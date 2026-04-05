---
status: pending
priority: p3
issue_id: "092"
tags: [code-review, simplicity, simulation]
dependencies: ["089", "090"]
---

# Eliminate `roleOverlap` intermediate array in `computeSimulationAdjustment`

## Problem Statement

`roleOverlap` is stored as a filtered array but is only ever used as `.length` (twice). The array itself is never inspected. This creates an unnecessary intermediate allocation.

## Current Code

```js
const roleOverlap = actorSrc === 'stateSummary' ? candidateActors.filter((a) => simRoles.has(a)) : [];
details.roleOverlapCount = roleOverlap.length;
// ...
const bonusOverlap = actorSrc === 'stateSummary' ? roleOverlap.length : details.keyActorsOverlapCount;
```

## Proposed Solution

```js
details.roleOverlapCount = actorSrc === 'stateSummary'
  ? candidateActors.filter((a) => simRoles.has(a)).length
  : 0;
const bonusOverlap = actorSrc === 'stateSummary'
  ? details.roleOverlapCount
  : actorSrc === 'affectedAssets' ? details.keyActorsOverlapCount : 0;
```

This combines with todo #090 (explicit ternary for `bonusOverlap`).

## Technical Details

- Files: `scripts/seed-forecasts.mjs`
- Effort: Trivial | Risk: Very Low

## Acceptance Criteria

- [ ] No `roleOverlap` intermediate array
- [ ] `node --test tests/forecast-trace-export.test.mjs` passes

## Work Log

- 2026-03-31: Identified by code-simplicity-reviewer during PR #2582 review
