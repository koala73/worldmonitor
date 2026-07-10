---
status: pending
priority: p3
issue_id: "028"
tags: [code-review, architecture, simulation-runner, schema]
---

# No structured `completionStatus` field in simulation outcome — callers must parse strings

## Problem Statement

The simulation outcome has no machine-readable `completionStatus` field. Callers must re-derive completion state from `theaterResults.length`, `failedTheaters.length`, and the string-encoded `globalObservations` field. This works for Phase 2 but will block Phase 3 callers (UI panels, downstream agents) that need to branch on `partial` vs `all_failed` vs `no_eligible_theaters`.

## Findings

**F-1:**
```javascript
const outcome = {
  globalObservations: eligibleTheaters.length === 0
    ? 'No maritime chokepoint/energy theaters in package'
    : theaterResults.length === 0 ? 'All theaters failed simulation' : '',
  confidenceNotes: `${theaterResults.length}/${eligibleTheaters.length} theaters completed`,
  // No structured completionStatus or eligibleTheaterCount
};
```

Callers deriving status: `theaterResults.length === 0 && failedTheaters.length === 0` could mean "no eligible theaters" or "eligibleTheaters array was somehow empty". No way to distinguish without `eligibleTheaterCount`.

## Proposed Solution

```javascript
const completionStatus =
  eligibleTheaters.length === 0 ? 'no_eligible_theaters'
  : theaterResults.length === 0 ? 'all_failed'
  : failedTheaters.length > 0 ? 'partial'
  : 'complete';

const outcome = {
  ...existingFields,
  completionStatus,
  eligibleTheaterCount: eligibleTheaters.length,
};
```

Also add `theaterCount` to `GetSimulationOutcomeResponse` proto (currently only `theaterCount` for successful results) — or add `eligibleTheaterCount` field in Phase 3.

## Acceptance Criteria

- [ ] `completionStatus: 'no_eligible_theaters' | 'all_failed' | 'partial' | 'complete'` added to outcome schema
- [ ] `eligibleTheaterCount` added to outcome schema
- [ ] `getSimulationOutcome` RPC response includes `completionStatus` (or proto updated in Phase 3)

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `processNextSimulationTask` (~line 15774) outcome construction
- Phase 3 concern: add `completionStatus` to `GetSimulationOutcomeResponse` proto

## Work Log

- 2026-03-24: Found by compound-engineering:review:architecture-strategist in PR #2220 review
