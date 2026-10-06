---
title: "Supply-chain hard specs sealed VOID because the resolver read a field the producer never writes"
date: 2026-10-06
category: logic-errors
module: scripts/_forecast-resolution-eval
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "28 of 30 supply-chain chokepoint hard-spec entries in the ledger sealed VOID (26 no_establishable_metric, 2 unsupported_window)"
  - "The riskScore extractor returned NaN for every live supply_chain:chokepoints:v4 record"
  - "Resolver tests passed because their fixtures used the generator's renamed shape"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [forecast, resolver, field-name-drift, producer-consumer, fixtures, chokepoints, void]
---

# Supply-chain hard specs sealed VOID because the resolver read a field the producer never writes

## Problem

Supply-chain forecasts carry a hard resolution spec such as `supply_chain:chokepoints:v4|riskScore(route==<region>) >= 60` (built in `scripts/_forecast-resolution.mjs`). The live chokepoint records carry `name` and `disruptionScore`, not `riskScore` (`server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts`). The resolver extracted NaN from every record and sealed the entry VOID. Fixed in #8893.

## Symptoms

- 28 of 30 chokepoint-spec entries in the working ledger were VOID: 26 `no_establishable_metric` and 2 `unsupported_window` (per #8893).
- A read-only GET of `supply_chain:chokepoints:v4` on 2026-10-06 showed Suez Canal with `disruptionScore` 35 and no `riskScore` field.
- The resolver test suite was green.

## What Didn't Work

The resolver tests built fixtures as `{ route, riskScore }`. That is the shape `normalizeChokepoints` in `scripts/seed-forecasts.mjs` produces after it renames `disruptionScore` to `riskScore` for the detector. The resolver never sees that shape. It reads the raw Redis record. The fixtures encoded the consumer's assumption, so they could not catch the mismatch.

## Solution

The `riskScore` case in `scripts/_forecast-resolution-eval.mjs` now also reads `disruptionScore`:

```js
case 'riskScore':
  // supply_chain:chokepoints:v4 publishes disruptionScore; the generator
  // renames it to riskScore before the detector reads it, the resolver does not.
  return firstFinite(record.riskScore, record.risk_score, record.disruptionScore, record.score, record.risk);
```

The `route` selector already matched `name`. A new test uses the producer-shaped record `{ name, disruptionScore }`. It returned VOID before the fix and YES with value 72 after. Entries already sealed VOID stay VOID, because re-resolving them would rewrite published outcomes.

## Why This Works

Two consumers read the same key through different paths. The generator normalizes the record, and the resolver reads it raw. The spec language named the normalized field. Reading the producer's field name in the resolver closes the gap between the spec and the stored record.

## Prevention

- Build resolver and reader fixtures from the producer's output, not from the shape another consumer derives. A captured live record or the producer's own builder are both good sources.
- When a spec or query names a field, check that field against the stored record at the key it names, not against the in-memory shape of the code that wrote the spec.
- A VOID rate near 100% for one spec family is a schema mismatch until proven otherwise. Check the stored record before tuning thresholds.

Related: `docs/solutions/design-patterns/contract-gate-field-names-miss-value-axis.md` covers a different producer and reader disagreement on the same supply-chain data.
