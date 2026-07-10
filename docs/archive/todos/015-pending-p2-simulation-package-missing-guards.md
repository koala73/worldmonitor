---
status: pending
priority: p2
issue_id: "015"
tags: [code-review, deep-forecast, simulation-package, correctness]
---

# Two missing null guards + `theater.label` undefined in simulation package builders

## Problem Statement

Three correctness gaps in the new simulation package builders produce silent degradation or misleading output without any log.

## Findings

**1. `buildSimulationPackageEvaluationTargets`: no guard when `candidate` is `undefined`**

```javascript
const candidate = candidates.find((c) => c.candidateStateId === theater.candidateStateId);
// No guard here — if candidate is undefined, actors silently falls back to 'key actors'
const actors = (candidate?.stateSummary?.actors || []).slice(0, 3).join(', ') || 'key actors';
```

`buildSimulationPackageConstraints` has an explicit `if (!candidate) continue` guard for the same `find()` pattern. `buildSimulationPackageEvaluationTargets` does not. Silent degradation produces a valid-looking evaluation target with generic actor text and no diagnostic.

**2. `theater.label` has no fallback — produces `"Simulate how a undefined (...)"` when `candidateStateLabel` is missing**

```javascript
label: c.candidateStateLabel,  // no fallback
// later:
return `Simulate how a ${theater.label} (${theater.stateKind || 'disruption'}...`;
```

If `candidateStateLabel` is absent, the `simulationRequirement` string contains literal "undefined". This propagates into R2 and downstream LLM consumers.

**3. `buildSimulationStructuralWorld`: `s.macroRegion` (singular) matched against `theaterRegions` built from `c.macroRegions` (plural array)**

If the signal schema stores an array in `macroRegion`, the `Set.has()` lookup against an array reference silently returns false for all such signals, producing empty `touchingSignals`. This code path has no test coverage (tests pass `signals: []`).

## Proposed Solutions

```javascript
// Fix 1: add candidate guard in buildSimulationPackageEvaluationTargets
const candidate = candidates.find((c) => c.candidateStateId === theater.candidateStateId);
if (!candidate) {
  console.warn(`[SimulationPackage] No candidate for theaterId=${theater.theaterId} (evaluationTargets)`);
}

// Fix 2: label fallback in selectedTheaters map
label: c.candidateStateLabel || c.dominantRegion || 'unknown theater',

// Fix 3: handle both singular and array macroRegion in signal filter
.filter((s) => {
  const sigMacro = s.macroRegion;
  return theaterRegions.has(s.region)
    || (Array.isArray(sigMacro) ? sigMacro.some((r) => theaterRegions.has(r)) : theaterRegions.has(sigMacro))
    || theaterStateIds.has(s.situationId);
})
```

Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `buildSimulationPackageEvaluationTargets` logs a warn when candidate is undefined for a theater
- [ ] `theater.label` is never `undefined` — falls back to `dominantRegion` or `'unknown theater'`
- [ ] `buildSimulationStructuralWorld` handles both singular string and array `macroRegion` on signals
- [ ] Test: a theater with `candidateStateLabel: undefined` produces a `simulationRequirement` that does NOT contain the string `"undefined"`

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `buildSimulationPackageEvaluationTargets`, `buildSimulationStructuralWorld`, `selectedTheaters` map in `buildSimulationPackageFromDeepSnapshot`

## Work Log

- 2026-03-24: Found by compound-engineering:review:kieran-typescript-reviewer in PR #2204 review
