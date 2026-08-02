---
title: Seeder auxiliary Redis writes crash on a single Upstash timeout
date: 2026-07-17
category: database-issues
module: scripts/_seed-utils.mjs
problem_type: database_issue
component: background_job
symptoms:
  - "`FATAL: The operation was aborted due to timeout` after a successful fetch in seed-gdelt-intel"
  - "Railway badge flips red with PUBLISH_TIMEOUT class; 3 crashes in 25-run window, 0 successes"
  - "Auxiliary `writeExtraKey` SETs or `extendExistingTtl` EXPIRE pipelines time out, taking the whole run down"
root_cause: missing_tooling
resolution_type: code_fix
severity: medium
tags:
  - redis
  - upstash
  - seeder
  - retry
  - seed-utils
  - afterpublish
  - timeout
---

# Seeder auxiliary Redis writes crash on a single Upstash timeout

## Problem

`seed-gdelt-intel` was crashing with `FATAL: The operation was aborted due to timeout` during the post-fetch Redis write phase. The upstream GDELT fetch had already succeeded and the canonical key publish (`atomicPublish`) already retried transient failures, but the auxiliary timeline-key writes and TTL extensions in `afterPublish` used one-shot `fetch()` calls. A single Upstash latency spike turned a transient blip into a full seeder crash and a Railway "Deploy Crashed!" email.

## Symptoms

- `FATAL: The operation was aborted due to timeout` appears after `Extended TTL on N key(s)` / `WARNING: N key(s) were expired/missing` logs.
- The seeder diagnostic classifies the service as `PUBLISH_TIMEOUT` with a warning severity.
- The crash recurs (3 in the inspected window) because every run re-rolls the same dice against Upstash tail latency.

## What Didn't Work

- **Retrying only the canonical publish.** `atomicPublish` already wrapped its staging/canonical SET/DEL in `withRetry`, but that only protects the canonical key. The `afterPublish` auxiliary writes (`writeExtraKey`, `extendExistingTtl`) were left single-shot.
- **Catching the timeout inside `extendExistingTtl`.** That helper already caught errors and returned `false`, but `writeExtraKey` threw on any non-ok response or abort, and neither helper retried — so a transient timeout still failed the run.

## Solution

Wrap both auxiliary Redis helpers in the same retry contract already used by `redisCommand` and `atomicPublish`:

- `writeExtraKey` (`scripts/_seed-utils.mjs:668`) now wraps its SET call in `withRetry` with 2 retries and a 1s base delay.
- `extendExistingTtl` (`scripts/_seed-utils.mjs:722`) now wraps its `/pipeline` call in `withRetry` with the same budget.
- Permanent 4xx errors are tagged `nonRetryable` so they fail fast.
- HTTP 429 errors honor the upstream `Retry-After` header.
- 5xx, timeouts, and network tears retry with exponential backoff.

The boolean contract of `extendExistingTtl` is preserved: it still returns `true` only when every `EXPIRE` returns `1`. A successful response with some `EXPIRE` no-ops (missing/expired keys) is a real data condition, not a transient error, so it returns `false` without burning retries.

Fixed in PR [#5364](https://github.com/koala73/worldmonitor/pull/5364).

## Why This Works

The root cause was not a bad source or bad data — it was a missing resilience layer on the auxiliary write path. Upstash REST is served over the public internet; a single stalled request or brief 503 is expected at scale. The canonical publish path already treated these as retryable; the auxiliary path did not. Adding retry makes the failure mode symmetric across all Redis writes in a seeder run.

## Prevention

- When adding a new Redis helper in `scripts/_seed-utils.mjs`, decide its retry contract up front. Helpers that write seeded data should default to `withRetry` unless the caller explicitly needs fail-fast semantics.
- Keep error tagging consistent with `redisCommand`:
  - `PERMANENT_4XX_STATUSES` → `err.nonRetryable = true`
  - `429` → parse `Retry-After` into `err.retryAfterMs`
  - everything else (5xx, timeout, network tear) → let `withRetry` back off
- Add a regression test that fails the first call and succeeds on retry for any new Redis write helper. The existing tests for `writeExtraKey` and `extendExistingTtl` now cover timeout, 503, 429, and permanent 401 paths.

## Related Issues

- `diagnose-railway-seeders` skill class `PUBLISH_TIMEOUT` — post-fetch Redis publish timed out.
- Memory: [[feedback_never_memorize_a_workaround_for_a_tool_bug_fix_the_tool]] — fix the shared helper rather than working around it in one seeder.
