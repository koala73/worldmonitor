---
status: pending
priority: p3
issue_id: 190
tags: [code-review, phase-0, regional-intelligence, performance, dry]
dependencies: []
---

# Hot-loop JSON.stringify(caseFile) duplicated across modules - precompute once

## Problem Statement
`actor-scoring.mjs:38`, `balance-vector.mjs:259` (`computeAllianceCohesion`), `scenario-builder.mjs:50` all call `JSON.stringify(f?.caseFile ?? ...).toLowerCase()` per forecast per region. For 14 forecasts x 8 regions x 5 callsites = 560 calls producing identical strings. Also creates inconsistency: actor-scoring checks `caseFile ?? signals`, alliance-cohesion checks only `caseFile`.

## Findings
- 5 call sites stringify `caseFile` per-forecast-per-region
- ~560 redundant stringifies per seed run at current scale
- Inconsistent fallback: some use `caseFile ?? signals`, others use `caseFile` only
- Text is identical across callsites for the same forecast - prime memoization target

## Proposed Solutions

### Option 1: Precompute caseFileText once in main()
Attach `_caseFileText` to each forecast before the region loop; all modules read it.

**Pros:** Single source of truth for what counts as searchable text; ~560 stringifies become 14; removes inconsistency
**Cons:** Adds a non-schema field to the forecast object (prefix with `_` to signal internal)
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
Affected files:
- `scripts/regional-snapshot/actor-scoring.mjs:38`
- `scripts/regional-snapshot/balance-vector.mjs:259` (computeAllianceCohesion)
- `scripts/regional-snapshot/scenario-builder.mjs:50`
- `scripts/seed-regional-snapshots.mjs` - main() where precomputation would land

The current code pattern is roughly:
```js
JSON.stringify(f?.caseFile ?? f?.signals ?? {}).toLowerCase()
```

The fallback chain must be normalized across all callers.

## Acceptance Criteria
- [ ] Precompute `_caseFileText: string` per forecast once before the region loop in main()
- [ ] All modules read `f._caseFileText` instead of re-stringifying
- [ ] Single consistent definition of what fields contribute to the searchable text

## Work Log

## Resources
- PR #2940
- PR #2942
