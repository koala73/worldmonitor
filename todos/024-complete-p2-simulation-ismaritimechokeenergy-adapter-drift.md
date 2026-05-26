---
status: complete
priority: p2
issue_id: "024"
tags: [code-review, architecture, simulation-runner, schema-drift]
---

# `isMaritimeChokeEnergyCandidate` hand-rolled adapter creates schema drift risk

## Problem Statement

`processNextSimulationTask` calls `isMaritimeChokeEnergyCandidate` with a manually-constructed adapter object mapping fields from `selectedTheaters` items individually. The function expects `{ routeFacilityKey, marketBucketIds, marketContext: { topBucketId }, commodityKey }` but `selectedTheaters` stores `topBucketId` flat (not under `marketContext`). If `selectedTheaters` items ever gain a `marketContext` field directly (as the upstream data model already uses), the manual mapping shadows the real `marketContext.topBucketId` with an empty string. If the function's logic ever expands to use additional fields, the call site silently fails to pass them.

## Findings

**F-1 (MEDIUM):**
```javascript
// scripts/seed-forecasts.mjs ~line 15719
const eligibleTheaters = (pkgData.selectedTheaters || []).filter((t) =>
  isMaritimeChokeEnergyCandidate({
    routeFacilityKey: t.routeFacilityKey || '',
    marketBucketIds: t.marketBucketIds || [],
    marketContext: { topBucketId: t.topBucketId || '' },  // t.topBucketId is flat; marketContext is reconstructed
    commodityKey: t.commodityKey || '',
  }),
);
// If t gains a real marketContext field, the reconstructed one shadows it
// isMaritimeChokeEnergyCandidate called at line 12190 uses the full candidate object directly
```

Two call sites for the same function with different input shapes is a maintenance hazard.

## Proposed Solutions

### Option A: Pass theater object directly, normalize inside the function (Recommended)

Update `isMaritimeChokeEnergyCandidate` to accept both flat and nested shapes:
```javascript
function isMaritimeChokeEnergyCandidate(candidate) {
  const topBucket = candidate.marketContext?.topBucketId || candidate.topBucketId || '';
  // ...rest of logic unchanged, just reads topBucket instead of candidate.marketContext.topBucketId
}

// In processNextSimulationTask — just pass t directly:
const eligibleTheaters = (pkgData.selectedTheaters || []).filter((t) =>
  isMaritimeChokeEnergyCandidate(t)
);
```

Effort: Small | Risk: Low — backwards compatible, no behavior change for existing call site at line 12190

### Option B: Verify that `selectedTheaters` schema already includes all needed fields

Check `buildSimulationPackageFromDeepSnapshot` to confirm it writes `routeFacilityKey`, `marketBucketIds`, `topBucketId`, `commodityKey` to theater items. If confirmed, document the flat-vs-nested convention with a comment at the call site.

## Acceptance Criteria

- [ ] `isMaritimeChokeEnergyCandidate` accepts both flat (`topBucketId`) and nested (`marketContext.topBucketId`) input
- [ ] `processNextSimulationTask` passes `t` directly without hand-rolling the adapter
- [ ] Both call sites (line 12190 and new line 15719) produce identical classification results
- [ ] Existing tests for `isMaritimeChokeEnergyCandidate` still pass

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `isMaritimeChokeEnergyCandidate` (~line 11871), `processNextSimulationTask` (~line 15719), `buildSimulationPackageFromDeepSnapshot` (~line 12190)

## Work Log

- 2026-03-24: Found by compound-engineering:review:architecture-strategist in PR #2220 review
