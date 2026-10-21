---
status: pending
priority: p3
issue_id: "016"
tags: [code-review, deep-forecast, simulation-package, quality]
---

# Simplification opportunities in simulation package builders — duplicated patterns + YAGNI items

## Problem Statement

Several mechanical duplications and one YAGNI issue in the new simulation package code (~30 lines of avoidable noise in a 405-line addition).

## Findings

**1. `candidates.find()` duplicated 3x across builder functions**
`buildSimulationPackageEventSeeds`, `buildSimulationPackageConstraints`, `buildSimulationPackageEvaluationTargets` each do `candidates.find((c) => c.candidateStateId === theater.candidateStateId)` per theater loop. Pre-building a `Map` once in the orchestrator and passing it down eliminates 6 `find()` calls.

**2. `entry.text.slice(0, 200)` repeated 3x in `buildSimulationPackageEventSeeds`**
Extract `const MAX_SEED_SUMMARY = 200`.

**3. `name.toLowerCase().replace(/\W+/g, '_')` repeated 4x for slugifying entity IDs**
Extract `const slugify = (s) => s.toLowerCase().replace(/\W+/g, '_')`.

**4. Fallback entity block: 3 explicit `addEntity(...)` calls per theater with identical shape**
A data-driven `FALLBACK_ANCHOR_DEFS` array reduces the block from ~30 lines to ~10 and makes adding a fourth anchor class trivial.

**5. `gateDetails` in debug payload hardcodes threshold values instead of reading from `getImpactValidationFloors()`**
```javascript
gateDetails: { secondOrderMappedFloor: 0.58, ... }
```
These are already the live values in `getImpactValidationFloors('second_order')`. When thresholds change again, `gateDetails` silently shows stale values. Read from the function instead.

**6. Actor extraction regex too narrow**
`/^(.+?)\s+remain the lead actors/i` — misses "are the primary actors", "continue as the key actors". When this misses, there is no log. Add: `console.debug('[SimulationPackage] evidence actor regex miss', entry.text.slice(0, 80))` so the fallback rate is observable.

## Proposed Solutions

```javascript
// In buildSimulationPackageFromDeepSnapshot, before calling builders:
const candidateById = new Map(top.map((c) => [c.candidateStateId, c]));

// Extract helpers near section header:
const slugify = (s) => s.toLowerCase().replace(/\W+/g, '_');
const MAX_SEED_SUMMARY = 200;

// gateDetails reads live values:
const secondOrderFloors = getImpactValidationFloors('second_order');
gateDetails: {
  secondOrderMappedFloor: secondOrderFloors.mapped,
  secondOrderMultiplier: secondOrderFloors.multiplier,
  pathScoreThreshold: 0.50,
  acceptanceThreshold: 0.60,
},
```

Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `slugify` and `MAX_SEED_SUMMARY` extracted as file-local constants
- [ ] `candidateById` Map built once in `buildSimulationPackageFromDeepSnapshot`, passed to builders
- [ ] `gateDetails` reads from `getImpactValidationFloors()` rather than hardcoding values
- [ ] All existing simulation package tests still pass

## Technical Details

- File: `scripts/seed-forecasts.mjs` — simulation package section (~line 11720–12100)

## Work Log

- 2026-03-24: Found by compound-engineering:review:code-simplicity-reviewer in PR #2204 review
