---
title: "A freshness clock covering two independent upstreams must reduce with min, not max"
date: 2026-08-05
category: design-patterns
module: seed-content-age
problem_type: design_pattern
component: background_job
severity: high
applies_when: "A seeder publishes one canonical key assembled from two or more upstreams that can freeze independently, and reports a single content-age contract for it"
tags: [content-age, stale-content, freshness, seeders, health-monitoring, alarm-design, multi-source]
---

# A freshness clock covering two independent upstreams must reduce with min, not max

## Context

`runSeed`'s content-age contract asks a seeder for one `{newestItemAt, oldestItemAt}` pair describing the data it just fetched (`scripts/_seed-utils.mjs:2006`), and `/api/health` fires `STALE_CONTENT` when `newestItemAt` falls outside `maxContentAgeMin`. This is the only layer that catches an upstream FREEZE — HTTP 200 forever with unchanging observations — because the cron still runs, the fetch still succeeds, and `validate()` still passes.

The shared helper `tokensToContentMeta` (`scripts/_content-age-helpers.mjs:80-94`) takes a flat list of date tokens and keeps the **largest** surviving timestamp:

```js
for (const token of list) {
  const ts = periodTokenToMs(token);
  if (ts == null || !Number.isFinite(ts) || ts <= 0 || ts > skewLimit) continue;
  valid++;
  if (ts > newest) newest = ts;   // <- max()
  if (ts < oldest) oldest = ts;
}
```

That is exactly right for the case it was built for: one series, many observation dates, and the newest one is the freshness signal. Every seeder that wired the contract before this one had a single upstream — `scripts/seed-ecb-fx-rates.mjs:139-141` passes its per-pair dates, `scripts/seed-ecb-short-rates.mjs:134-139` passes the €STR span.

The Bank of Russia seeder (#6154) was the first to assemble **two independent upstreams** into one canonical key: an XML rate table and a SOAP key-rate series, different services that can fail independently. Its first draft passed both sets of dates into one `tokensToContentMeta` call.

## Guidance

When a canonical key is assembled from N upstreams that can freeze independently, derive **one clock per upstream** and report the **oldest** of them. Every source must be current for the payload to read as fresh.

```js
// WRONG — one call, reduced with max(): the fresher source hides the frozen one
export function contentMeta(data, nowMs = Date.now()) {
  const tokens = seriesA(data).concat(seriesB(data));
  return tokensToContentMeta(tokens, nowMs);
}

// RIGHT — a clock per source, reduced with min()
export function contentMeta(data, nowMs = Date.now()) {
  const a = tokensToContentMeta(seriesADates(data), nowMs);
  const b = tokensToContentMeta(seriesBDates(data), nowMs);
  if (a == null || b == null) return null;   // fail closed: an undatable half IS stale
  return {
    newestItemAt: Math.min(a.newestItemAt, b.newestItemAt),
    oldestItemAt: Math.min(a.oldestItemAt, b.oldestItemAt),
  };
}
```

Two rules travel with it:

1. **Fail closed on a missing clock.** If any source yields no datable token, return `null`. `runSeed` reads `null` as `STALE_CONTENT`, which is the correct verdict — "we cannot date this half" is indistinguishable from "this half is dead."
2. **Clamp a legitimately future-dated token rather than letting it be dropped.** `tokensToContentMeta` discards anything more than an hour ahead (`scripts/_content-age-helpers.mjs:88`), so a source that publishes a *next-day effective date* contributes nothing for part of every day. Clamping it to `now` keeps a live source reading as fresh while a frozen one still ages honestly. See `cbrContentMeta` at `scripts/seed-cbr-rates.mjs:400-419`.

## Why This Matters

Under `max()`, the alarm can only fire when **every** source freezes at once — the rarest failure mode. The common one, a single service going quiet while its sibling keeps publishing, is silent forever: `/api/health` stays green, `seed-meta.fetchedAt` keeps advancing because the seeder genuinely ran, and the record count stays whole because the frozen half still returns its last payload. Nothing else in the stack inspects observation dates, so there is no second line of defence.

The failure is worse than no contract at all, because a wired content-age contract *looks* like coverage. A reader auditing the seeder sees `contentMeta` + `maxContentAgeMin` present and moves on.

This is the same shape as issue #3845, where ECB's CISS series froze for ~12 months behind an HTTP 200 and the panel served a year-old value — the incident the content-age contract was built for. A `max()` reduction over multiple sources reintroduces that blind spot for every source but the freshest.

## When to Apply

Apply whenever **one** canonical key is fed by **more than one** independently-failing upstream — separate hosts, separate services on one host (a REST endpoint and a SOAP endpoint), or one endpoint per region. It does not apply to a single series with many observation dates, which is what `tokensToContentMeta`'s `max()` is correctly designed for.

The diagnostic question when reviewing any freshness contract: *"Which single upstream can stop publishing without changing `newestItemAt`?"* If the answer is anything other than "none," the reduction is wrong.

A related trap in the same family: do not clock off a **run-length-encoded** series' newest step. A value on hold for six months has a six-month-old newest step while the series publishes daily — track the newest raw observation separately (`keyRate.observedAt`) and let the compressed steps only widen `oldestItemAt`.

## Examples

The defect, reproduced against the shipped payload shape. Both cases are locked as tests in `tests/seed-cbr-rates.test.mjs`:

```js
// FX table frozen since June; the key rate is still publishing daily.
const payload = {
  effectiveDate: '2026-06-01',                              // FX: 64 days stale
  keyRate: { observedAt: '2026-08-04', changes: [{ date: '2026-07-27', rate: 14 }] },
};

// Under max(): newestItemAt = 2026-08-04 -> age 0 -> HEALTHY. The FX table is dead.
// Under min(): newestItemAt = 2026-06-01 -> age 64d -> STALE_CONTENT. Correct.
```

The reverse direction fails the same way with the roles swapped — a live FX table hiding a frozen key rate — which is why the tests assert both, plus `null` on a missing clock and a never-future `newestItemAt`.

Verified by mutation: reverting `cbrContentMeta` to the single `tokensToContentMeta` call turns four tests red. A fix in this class is worth mutation-testing specifically, because the "before" code produces a *healthy-looking* verdict rather than an error, so a test that merely exercises the happy path passes against both versions.

Shipped in [#6187](https://github.com/koala73/worldmonitor/pull/6187) (issue #6154).
