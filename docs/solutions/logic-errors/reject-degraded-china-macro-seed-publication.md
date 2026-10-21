---
title: Reject degraded China macro snapshots at the seed publish boundary
date: 2026-07-13
category: logic-errors
module: China macro seed pipeline
problem_type: logic_error
component: background_job
symptoms:
  - Degraded snapshots with four indicator slots could pass seed validation
  - A partial refresh could replace a launch-ready cached snapshot
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [china-macro, seed-validation, last-good, launch-readiness]
---

# Reject degraded China macro snapshots at the seed publish boundary

## Problem

The China macro adapter can intentionally return a degraded snapshot when a required price, activity, policy, or FX indicator is stale or unavailable. The original seed validator checked only that the payload contained at least four indicator slots, so a structurally complete but non-launch-ready snapshot could reach the publish path.

## Symptoms

- A snapshot with `launchReady: false` and `status: "degraded"` still satisfied the count-based validator.
- Publishing that snapshot could replace the last launch-ready value cached under `economic:china:macro:v1`.

## What Didn't Work

- Checking `indicators.length >= 4` verified payload shape, not data readiness. Unavailable or stale indicators remain present as slots, so their count does not prove that all required categories are usable.

## Solution

Keep the adapter's readiness decision as the source of truth and repeat it at the irreversible seed publication boundary:

```js
export function validateChinaMacroSnapshot(snapshot) {
  return snapshot?.launchReady === true
    && snapshot?.status === 'ready'
    && Array.isArray(snapshot?.indicators)
    && snapshot.indicators.length >= 4;
}
```

Pass that validator to `runSeed` in `scripts/seed-china-macro.mjs`. Add a regression assertion in `tests/china-macro-seed.test.mjs` that marks a required activity indicator stale, rebuilds the snapshot, and verifies both `launchReady === false` and validator rejection.

## Why This Works

`buildChinaMacroSnapshot` derives `launchReady` from the required price, activity, policy, and FX categories and assigns `status: "ready"` only when all four are usable. `runSeed` passes the fetched payload to `atomicPublish`, which invokes `validateFn` before writing the canonical Redis key. When validation fails, the publish is skipped and the existing cache TTL is extended, preserving the last-good snapshot.

## Prevention

- Treat shape checks and quality checks as separate assertions in every seed validator. For payloads with explicit readiness state, test the degraded payload itself and require the readiness state again at the publish boundary.

## Related Issues

- [Issue #5275](https://github.com/koala73/worldmonitor/issues/5275)
- [PR #5294](https://github.com/koala73/worldmonitor/pull/5294) (open at documentation time)
