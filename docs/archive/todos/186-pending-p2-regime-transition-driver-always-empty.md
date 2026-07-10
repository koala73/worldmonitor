---
status: pending
priority: p2
issue_id: 186
tags: [code-review, phase-0, regional-intelligence, dead-code, schema]
dependencies: []
---

# regime.transition_driver field is dead weight (always empty in Phase 0)

## Problem Statement
`scripts/seed-regional-snapshots.mjs:137` passes empty string as the driver to `buildRegimeState` because the diff isn't computed yet at that point in the pipeline. Field exists in type, is serialized, never populated. Phase 1 readers will find always-empty.

## Findings
- `regime.transition_driver` is part of the persisted snapshot shape
- Value is always `""` because diff is computed later in the pipeline
- Phase 1 consumers will be forced to ignore the field or special-case it
- Options: populate after diff step, or defer the field to Phase 2

## Proposed Solutions

### Option 1: Populate transition_driver from inferTriggerReason(diff) after the diff step
Rewire the pipeline so regime state is built after the diff is known.

**Pros:** Field carries real information
**Cons:** Requires reordering steps in the orchestrator
**Effort:** Small
**Risk:** Low

### Option 2: Document as Phase 2 and keep empty
Add a comment noting the field is intentionally deferred.

**Pros:** No behavioral change
**Cons:** Field remains dead weight
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
File: `scripts/seed-regional-snapshots.mjs:137` - call site with empty driver.
Function: `buildRegimeState` - consumer.
Function: `inferTriggerReason(diff)` - would populate the field.

## Acceptance Criteria
- [ ] Populate regime.transition_driver from inferTriggerReason(diff) after the diff step
- [ ] OR document the field as Phase 2 and keep empty

## Work Log

## Resources
- PR #2940
- PR #2942
