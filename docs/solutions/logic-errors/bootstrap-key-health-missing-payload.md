---
title: Bootstrap health reports missing compact projections as EMPTY
date: 2026-07-14
category: logic-errors
module: api/health.js
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - "Fresh seed metadata with a missing compact projection payload reported OK in /api/health."
  - "Dashboard panels could render blank without an actionable health signal."
root_cause: logic_error
resolution_type: code_fix
tags: [bootstrap-hydration, seed-meta, freshness-tracking, redis, health]
---

# Bootstrap health reports missing compact projections as EMPTY

## Problem

[`/api/health`](../../../api/health.js) previously allowed every `EMPTY_DATA_OK` source to report `OK` when its `seed-meta` was fresh, even if its Redis payload was absent. That contract was too broad for compact bootstrap projections: a writer or transform failure could blank a user-facing panel while health remained green. The affected issue is [#5321](https://github.com/koala73/worldmonitor/issues/5321).

`api/health.js:710-725` puts both quiet metadata-only sources and bootstrap projections in `EMPTY_DATA_OK_KEYS`. Treating both categories alike erased the distinction between an expected quiet result and a missing required projection.

## Symptoms

- Health reported `OK` for a fresh bootstrap seed even though its data key was gone.
- Panels backed by compact projections could render empty without an actionable health signal.
- Operators could not distinguish a quiet successful source cycle from a missing projection payload.

## What Didn't Work

Making every `EMPTY_DATA_OK` key fail when the payload was missing would have fixed the projection blind spot, but it would also have broken normal quiet-source behavior. `ddosAttacks`, `trafficAnomalies`, `weatherAlerts`, and `newsThreatSummary` legitimately write fresh metadata without a payload after a successful quiet cycle; they must remain healthy in that state. The test contract at `tests/health-empty-data-ok.test.mjs:16-92` covers this distinction.

Earlier bootstrap work had correctly added compact dashboard-shaped side keys, but it also showed that a side key needs its own availability signal; healthy metadata alone cannot prove that a required projection is present (session history).

## Solution

Keep the broad `EMPTY_DATA_OK_KEYS` list, then add an explicit strict subset for projections that must have a payload:

```js
const MISSING_DATA_IS_FAILURE_KEYS = new Set([
  'thermalEscalationBootstrap',
  'ucdpEventsBootstrap',
  'wildfiresBootstrap',
  'forecastsBootstrap',
  'positiveGeoEvents',
]);
```

The set is defined at `api/health.js:727-737`. In the health evaluation, a strict key with fresh seed metadata and no data key now reports `EMPTY` before the general `EMPTY_DATA_OK` path runs. All other `EMPTY_DATA_OK` keys retain the prior `OK`-when-fresh and stale-status behavior (`api/health.js:926-933`).

## Why This Works

The check is narrow and expresses the real operational invariant: the five named projections represent expected bootstrap data, whereas the quiet sources represent an optional observation that may legitimately have no payload. Giving strict missing-payload detection precedence catches projection writer and transform failures without turning expected no-event cycles into false alarms. The exact source categorization is visible in `api/health.js:710-737`, and the two resulting contracts are exercised in `tests/health-empty-data-ok.test.mjs:16-92`: strict keys are expected to be `EMPTY`, while quiet keys are expected to be `OK`.

## Prevention

When adding a source to `EMPTY_DATA_OK_KEYS`, decide explicitly which contract it needs:

- Quiet or metadata-only sources may stay in the general list, where fresh metadata plus no payload is healthy.
- Bootstrap projections or other data-required outputs must also be added to `MISSING_DATA_IS_FAILURE_KEYS` so a missing fresh payload is visible as `EMPTY`.

Extend `tests/health-empty-data-ok.test.mjs` with both the intended strict and quiet expectation for any new category. This protects the distinction at the Vercel Edge health endpoint instead of relying on an implicit interpretation of `EMPTY_DATA_OK`.

## Related Issues

- [#5321: health: EMPTY_DATA_OK bootstrap projections report OK while their key is GONE](https://github.com/koala73/worldmonitor/issues/5321)
- [Health must not grade an unconfigured optional source](health-must-not-grade-an-unconfigured-optional-source.md) — related classifier precedent for preserving an actionable source-state distinction.
- [Merged is not ran long cron seeders](../integration-issues/merged-is-not-ran-long-cron-seeders.md) — distinguishes this fresh-metadata/missing-payload condition from a producer that has not run.
