---
status: pending
priority: p2
issue_id: 180
tags: [code-review, phase-0, regional-intelligence, refactor, dry]
dependencies: []
---

# REGIONS.find duplicated 5 times instead of using getRegion helper

## Problem Statement
`shared/geography.js:242` exports `getRegion(regionId)` but 5 compute modules use inline `REGIONS.find((r) => r.id === regionId)` instead:
- `balance-vector.mjs:18` and `balance-vector.mjs:253`
- `evidence-collector.mjs:16`
- `actor-scoring.mjs:26`
- `scenario-builder.mjs:18`

Duplication will cause inconsistency when validation logic is added (e.g., warning on unknown region, caching, normalization).

## Findings
- `getRegion` helper already exists and is the canonical accessor
- 5 callsites use inline `REGIONS.find` instead
- 4 of the 5 files only need `getRegion` but currently import the raw `REGIONS` array
- No tests enforce use of the helper

## Proposed Solutions

### Option 1: Mass-replace with getRegion
Replace all inline `REGIONS.find` calls with `getRegion(regionId)` and drop `REGIONS` from imports where only `getRegion` is needed.

**Pros:** Centralizes region lookup; future validation lives in one place; smaller imports
**Cons:** Touches 5 files
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
Files to update:
- `scripts/regional-snapshot/balance-vector.mjs` (lines 18, 253)
- `scripts/regional-snapshot/evidence-collector.mjs` (line 16)
- `scripts/regional-snapshot/actor-scoring.mjs` (line 26)
- `scripts/regional-snapshot/scenario-builder.mjs` (line 18)

`shared/geography.js:242` defines:
```js
export function getRegion(regionId) { ... }
```

## Acceptance Criteria
- [ ] Mass-replace REGIONS.find with getRegion calls in 5 modules
- [ ] Drop REGIONS from imports in 4 files where only getRegion is needed
- [ ] Tests still pass

## Work Log

## Resources
- PR #2940
- PR #2942
