---
status: pending
priority: p2
issue_id: "014"
tags: [code-review, deep-forecast, simulation-package, performance]
---

# Two performance issues in simulation package builders: `new Set` in filter predicate + `intersectAny` O(n²)

## Problem Statement

Two patterns in the new simulation package code introduce unnecessary allocations and O(n×m) comparisons that will grow with the actor registry size.

## Findings

**CRITICAL-1: `intersectAny` uses `Array.includes` — O(n×m) in the actor registry loop**

`buildSimulationPackageEntities` builds `allForecastIds` as a flat array via `flatMap`, then passes it to `intersectAny` which calls `right.includes(item)` for each item in `actor.forecastIds`. With a 200-actor registry and 8 forecast IDs each, this is ~38,400 comparisons per call.

```javascript
const allForecastIds = candidates.flatMap((c) => c.sourceSituationIds || []);
for (const actor of (actorRegistry || [])) {
  if (!intersectAny(actor.forecastIds || [], allForecastIds)) continue;
```

Fix: convert `allForecastIds` to a Set once before the loop.

**CRITICAL-2: `new Set(candidate.marketBucketIds || [])` inside filter predicate**

`isMaritimeChokeEnergyCandidate` constructs a new Set from `marketBucketIds` (typically 2-3 elements) on every candidate, then calls `.has()` twice. At 50 candidates this is 50 Set allocations for a 2-element array check. `Array.includes` is faster for arrays of this size.

```javascript
const buckets = new Set(candidate.marketBucketIds || []);
return buckets.has('energy') || buckets.has('freight') || ...
```

## Proposed Solutions

### Fix both (Recommended)

```javascript
// Fix 1: Set-based forecast ID lookup
const allForecastIdSet = new Set(candidates.flatMap((c) => c.sourceSituationIds || []));
for (const actor of (actorRegistry || [])) {
  if (!(actor.forecastIds || []).some((id) => allForecastIdSet.has(id))) continue;

// Fix 2: Array.includes instead of Set for small arrays
const bucketArr = candidate.marketBucketIds || [];
return bucketArr.includes('energy') || bucketArr.includes('freight') || topBucket === 'energy' || topBucket === 'freight'
  || SIMULATION_ENERGY_COMMODITY_KEYS.has(candidate.commodityKey || '');
```

Effort: Tiny | Risk: Low

## Acceptance Criteria

- [ ] `allForecastIds` is a `Set` before the actor registry loop in `buildSimulationPackageEntities`
- [ ] `isMaritimeChokeEnergyCandidate` uses `Array.includes` or `Array.some` instead of `new Set` for `marketBucketIds` check
- [ ] All existing simulation package tests still pass

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `isMaritimeChokeEnergyCandidate`, `buildSimulationPackageEntities`

## Work Log

- 2026-03-24: Found by compound-engineering:review:performance-oracle in PR #2204 review
