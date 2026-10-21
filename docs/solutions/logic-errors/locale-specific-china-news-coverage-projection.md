---
title: Keep China news coverage projections locale-aware
date: 2026-07-14
last_updated: 2026-07-14
category: logic-errors
module: News insights seeder and China coverage audit
problem_type: logic_error
component: background_job
symptoms:
  - A successful English digest could be mistaken for successful Chinese-source coverage
  - China news audit status could become healthy while MIIT or MOFCOM had not been evaluated
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [china-coverage, news-insights, locale-digest, seed-audit]
---

# Keep China news coverage projections locale-aware

## Problem

The global insights payload is ranked and locale-specific. It cannot prove that every China source completed: Xinhua belongs to the English digest, while MIIT and MOFCOM belong to the Chinese digest. A source-status projection built from only the English digest would treat the absent Chinese entries as successful.

## Symptoms

- The China coverage manifest could mark `news.china` launched without a source-level Chinese digest check.
- A healthy English digest could mask an unavailable or stale MIIT or MOFCOM feed.

## What Didn't Work

- Inferring source health from globally ranked top stories loses per-feed outcomes after ranking.
- Reading only `news:digest:v1:full:en` is insufficient because the feed-digest cache key includes the requested locale.

## Solution

Define each audited China source with the locale of the digest that evaluates it:

```js
export const CHINA_NEWS_SOURCES = Object.freeze([
  { source: 'Xinhua', digestLanguage: 'en' },
  { source: 'MIIT (China)', digestLanguage: 'zh' },
  { source: 'MOFCOM (China)', digestLanguage: 'zh' },
]);
```

`scripts/seed-insights.mjs` reads the normal English digest, reads or warms the supplemental Chinese digest, and passes both to `buildChinaNewsCoverage`. The helper emits `available` only for a digest with a valid `generatedAt` timestamp and no exceptional feed status; absent, timeout, all-undated, and missing-locale cases remain unavailable.

Publish the projection separately at `news:insights:v1:CN`. Strip it from the canonical `news:insights:v1` payload, so the user-facing global digest contract remains unchanged. When a fresh digest run retains a last-known-good global brief, carry the fresh projection through that return solely for `afterPublish`; the transform still removes it before the public payload is written. The China manifest requires all three named sources to be available and timestamped before `news.china` is healthy.

## Why This Works

`list-feed-digest` stores results under `news:digest:v1:${variant}:${lang}`, so its per-feed status is authoritative only for the requested locale. Evaluating each source against its own locale prevents missing Chinese feeds from being interpreted as normal absent-status entries.

The Chinese check is supplemental: its failure is caught and produces an unavailable projection rather than preventing the existing global insights seed from publishing. A brief-only degradation can retain the last-known-good global payload while still publishing fresh source evidence. If the English digest itself is unavailable, there is no new projection, so the old projection is only TTL-extended and the audit eventually reports it stale instead of green.

## Prevention

- For a country-specific audit built from locale-filtered inputs, record the locale beside every source and test a missing supplemental digest explicitly.
- Keep audit-only projections separate from ranked or public payloads, then make the audit require the projection's per-source timestamps and statuses.
- Test the last-known-good branch separately: preserve fresh audit-only evidence when the public payload falls back for an unrelated brief-generation failure.

## Related Issues

- [Issue #5272](https://github.com/koala73/worldmonitor/issues/5272)
- [Issue #5278](https://github.com/koala73/worldmonitor/issues/5278)
