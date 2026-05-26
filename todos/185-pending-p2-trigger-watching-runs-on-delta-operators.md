---
status: pending
priority: p2
issue_id: 185
tags: [code-review, phase-0, regional-intelligence, triggers]
dependencies: [171]
---

# trigger-evaluator runs isCloseToThreshold on delta operators that are unconditionally false

## Problem Statement
`scripts/regional-snapshot/trigger-evaluator.mjs:18-35`. `evaluateThreshold` returns false for two reasons: (a) threshold not breached, (b) operator is `delta_*` (Phase 0 stub). In case (b), `isCloseToThreshold` STILL runs and could elevate dormant triggers to "watching" based on misleading math.

## Findings
- `delta_*` operators are stubbed to return false in Phase 0
- `isCloseToThreshold` has no knowledge of the stub
- Watching-state elevation for delta-gated triggers is semantically wrong
- Downstream Phase 1 readers will surface these as near-triggers incorrectly

## Proposed Solutions

### Option 1: Skip isCloseToThreshold for delta_* operators
Guard at the top of the watching branch.

**Pros:** Minimal change; correct semantics
**Cons:** Adds one branch
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
File: `scripts/regional-snapshot/trigger-evaluator.mjs:18-35`
Related issue: #171 (isCloseToThreshold inverted for lt operators)

## Acceptance Criteria
- [ ] Skip isCloseToThreshold for delta_* operators
- [ ] Test: delta_gt trigger never appears in watching list during Phase 0

## Work Log

## Resources
- PR #2940
- PR #2942
- Related: issue #171
