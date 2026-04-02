---
status: pending
priority: p2
issue_id: "090"
tags: [code-review, simulation, correctness, architecture]
dependencies: []
---

# `bonusOverlap` ternary silently falls through to affectedAssets path for future `actorSource` values

## Problem Statement

In `computeSimulationAdjustment`:

```js
const bonusOverlap = actorSrc === 'stateSummary' ? roleOverlap.length : details.keyActorsOverlapCount;
```

The `else` branch catches both `actorSource='affectedAssets'` (correct) and `actorSource='none'` (incorrect — `keyActorsOverlapCount` would be 0 anyway, but the branch is semantically wrong) and any future third value. If a new `actorSource` variant is added later, it will silently use the `affectedAssets` entity-overlap count rather than failing visibly.

## Findings

- Flagged by architecture-strategist during PR #2582 review
- Current `actorSource` values: `'stateSummary'` | `'affectedAssets'` | `'none'`
- `actorSource='none'` currently has `candidateActors=[]` so `keyActorsOverlapCount=0`, masking the incorrect branch
- The fix is one line and makes the intent explicit

## Proposed Solution

```js
// BEFORE:
const bonusOverlap = actorSrc === 'stateSummary' ? roleOverlap.length : details.keyActorsOverlapCount;

// AFTER:
const bonusOverlap = actorSrc === 'stateSummary'
  ? details.roleOverlapCount
  : actorSrc === 'affectedAssets'
    ? details.keyActorsOverlapCount
    : 0;
```

This also removes the need for the intermediate `roleOverlap` array (use `details.roleOverlapCount` directly as flagged by code-simplicity-reviewer).

## Technical Details

- Files: `scripts/seed-forecasts.mjs` (computeSimulationAdjustment, ~line 11501)
- Effort: Trivial | Risk: Very Low

## Acceptance Criteria

- [ ] All three `actorSource` values have explicit branches (no implicit fallthrough)
- [ ] `node --test tests/forecast-trace-export.test.mjs` passes

## Work Log

- 2026-03-31: Identified by architecture-strategist during PR #2582 review
