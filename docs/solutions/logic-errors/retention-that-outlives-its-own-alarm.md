---
title: Retention that outlives its own alarm decays a warning into silence
date: 2026-09-07
category: logic-errors
module: scripts/seed-internet-outages.mjs
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "A sustained upstream outage reported STALE_SEED (warn) for seven days, then flipped back to OK while still serving a week-old frozen payload."
  - "No health signal distinguished a source that was being actively retained from one that was genuinely fresh."
root_cause: logic_error
resolution_type: code_fix
related_components: [api/health.js, scripts/_seed-utils.mjs]
tags: [seed-meta, last-good, retention, ttl, freshness-tracking, health, alarm-design, redis]
---

# Retention that outlives its own alarm decays a warning into silence

## Problem

A seeder's failure path retains last-good data by extending the payload key's TTL. If it extends *only* the payload and lets the freshness marker that reports on that payload expire on its own schedule, the alarm dies before the outage does — and the stale payload keeps being served behind a green health check.

Found while reviewing [PR #7862](https://github.com/koala73/worldmonitor/pull/7862) (issue [#7845](https://github.com/koala73/worldmonitor/issues/7845)), in the fix's own first draft, before merge.

> **History worth knowing, because it is the same lesson twice.** Two independent fixes for [#7845](https://github.com/koala73/worldmonitor/issues/7845) were open at once. [#7876](https://github.com/koala73/worldmonitor/pull/7876) merged first and shipped the retention path *without* the marker extension — so the failure described on this page went live on `main` before the page describing it did. [#7862](https://github.com/koala73/worldmonitor/pull/7862) adds the marker extension on top. If you are reading this before #7862 lands, `COMPANIONS`, `companionMetaKey` and the `preserveKeyTtls` meta entries are not yet on `main`, and the seven-day decay to `OK` is live.

## Symptoms

- A Cloudflare Radar companion source fails every tick. For ~7 days `/api/health` correctly reports `STALE_SEED` (warn).
- On day 8 the same unchanged failure reports `OK`. The panel still renders the payload frozen at the last successful publish.
- Nothing in the seeder's logs changes at the transition — the failure and its retention warning are identical on day 8 and day 6.

## What Didn't Work

The failure path looked correct in isolation, and each half of it was independently right:

```js
// Retain last-good, but do NOT touch seed-meta — rewriting fetchedAt would
// claim a success that never happened.
const retained = await extendExistingTtl([companion.key], companion.ttlSeconds);
```

Not rewriting `fetchedAt` is the correct instinct and the house rule — a failed run must never advance a success clock. The mistake was reading "don't touch seed-meta" as "don't touch the seed-meta *key*," when only its **value** must be left alone. Its **TTL** still needed extending.

Reasoning about the two keys separately is what hides this. The payload's retention is visibly bounded (`ttlSeconds`), so "the data expires eventually" feels true — but re-arming it every tick makes its *effective* lifetime unbounded, while the marker's lifetime stays fixed. Whichever expires first decides what health reports, and the fixed one loses.

## Solution

Extend the marker at its own floor alongside the payload, still without rewriting `fetchedAt`:

```js
// Two calls, not one pipeline: EXPIRE sets a TTL absolutely, so the payload
// and its meta must each be extended at their own value.
const [dataRetained, metaRetained] = await Promise.all([
  extendExistingTtl([companion.key], companion.ttlSeconds),
  extendExistingTtl([companionMetaKey(companion)], resolveSeedMetaTtl(undefined, companion.ttlSeconds)),
]);
const retained = dataRetained && metaRetained;
```

`EXPIRE` sets a TTL absolutely rather than adding to it, so the two keys cannot share one call — extending the marker at the payload's TTL would *shorten* it from seven days to one hour.

**Resolve the marker's TTL through the same function that wrote it; do not hardcode the floor.** `resolveSeedMetaTtl(metaTtlSeconds, dataTtlSeconds)` returns `metaTtlSeconds ?? Math.max(SEED_META_MIN_TTL_SECONDS, dataTtlSeconds || 0)` ([`scripts/_seed-utils.mjs:1089`](../../../scripts/_seed-utils.mjs)). The seven-day floor is a *minimum*, not a maximum: a key whose data TTL exceeds seven days has its marker written at the **data** TTL, and a caller may pass a longer explicit one. Re-arming such a marker at the floor would shorten it — the same alarm-before-data failure this page is about, reintroduced by the fix for it. The two companions here (3h and 1h) both resolve to the floor, which is exactly why hardcoding it looked safe.

The same cohort is declared to `runSeed` so the fetch-failure, SIGTERM and validation-skip paths retain it too:

```js
preserveKeyTtls: [
  ...COMPANIONS.map((c) => ({ key: c.key, ttlSeconds: c.ttlSeconds })),
  ...COMPANIONS.map((c) => ({ key: companionMetaKey(c), ttlSeconds: resolveSeedMetaTtl(undefined, c.ttlSeconds) })),
],
```

## Why This Works

`classifyKey` in `api/health.js` derives staleness *entirely* from the seed-meta record. With the marker gone, there is no fault to report and no clock to call stale:

- `readSeedMeta` returns `hasMeta: false, seedStale: null, metaCount: null` ([`api/health.js:2325`](../../../api/health.js)).
- `const records = hasData ? (metaCount ?? 1) : 0` ([`api/health.js:2742`](../../../api/health.js)) yields `1` — the payload is present, so the key does not look empty either.
- Every fault and staleness branch requires a signal that is now `null`, so classification falls through to `else status = 'OK'` ([`api/health.js:2912`](../../../api/health.js)).

`hasData && !hasMeta` is therefore indistinguishable from healthy. Keeping the marker alive keeps `seedStale` computable, so the warn persists exactly as long as the failure does.

Note what is *not* fixed by this: the payload is still served. That is intended — retention exists so readers keep seeing last-good. The bug was never that stale data was served; it was that serving it stopped being *reported*.

## Prevention

**The rule: if you extend a value's lifetime on failure, extend the lifetime of the signal that reports on that value — or the alarm expires before the problem does.**

This is the same invariant the fleet already guards from the other direction. [`tests/seed-ttl-outlives-staleness-fleet.test.mjs`](../../../tests/seed-ttl-outlives-staleness-fleet.test.mjs) enforces `ttlSeconds > maxStaleMin * 60` so a merely-late seeder degrades `STALE_SEED` → `EMPTY` in that order rather than reporting a crit for a source that is only running behind (issue #5309; the same family was fixed for reference data in [PR #7847](https://github.com/koala73/worldmonitor/pull/7847), merged). Both directions say one thing: **the reporting signal must outlive the value it reports on.**

Two reasons that fleet test cannot catch this variant, which is why it needs its own guard:

1. It compares *declared* constants — a seeder's `ttlSeconds` against its `maxStaleMin`. A retention path that re-arms a TTL every tick makes the payload's effective lifetime unbounded at runtime, and no declared constant expresses that.
2. It compares the payload TTL against the *staleness gate*, not against the *marker's own TTL*. Here both declared values are fine in isolation; only their interaction under sustained retention is wrong.

Concrete checks when writing or reviewing a retention path:

- Ask "what expires first — the data, or the thing that tells me the data is stale?" If the data can be re-armed indefinitely, the marker must be too.
- Assert the retention TTLs, not just the resulting payload — and derive the expected value the same way the writer does, so the assertion cannot outlive a TTL change:

  ```js
  assert.deepEqual(
    expireCommandsFor(run.redisCommands, TRAFFIC_META_KEY).map((c) => c[2]),
    [resolveSeedMetaTtl(undefined, ANOMALIES_TTL)],
    'the seed-meta key is extended at its own resolved TTL, never at the data TTL',
  );
  assert.equal(
    JSON.parse(run.store.get(TRAFFIC_META_KEY)).fetchedAt, NOW - 30 * 60_000,
    'extending the clock key must not rewrite the clock',
  );
  ```

  The second assertion is the one that keeps the fix honest: extending the marker's TTL is required, rewriting its `fetchedAt` is still forbidden. A fix that "kept the alarm alive" by re-stamping the clock would pass the first assertion and reintroduce the original silent-freeze.
- Remember `EXPIRE` is absolute, not additive. Batching keys with different lifetimes into one TTL call silently shortens the longer-lived one — and so does re-arming a single key at a constant that is only *usually* its longest TTL.

## See Also

- [`bootstrap-key-health-missing-payload.md`](./bootstrap-key-health-missing-payload.md) — the opposite half of the same `classifyKey` pairing: `hasMeta && !hasData` also falsely reported `OK`. Together these cover both ways a half-present key can read as healthy.
- [`multi-source-freshness-clock-must-reduce-with-min.md`](../design-patterns/multi-source-freshness-clock-must-reduce-with-min.md) — the closest prior alarm-design precedent: a freshness clock that fails to fire because of how two signals are combined.
- [`sentry-resolve-by-shipping-permanently-mutes-issues.md`](../workflow-issues/sentry-resolve-by-shipping-permanently-mutes-issues.md) — the mirror image at the process layer: there a signal outlives its accuracy, here it dies before the state it reports on.
