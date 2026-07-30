---
status: pending
priority: p2
issue_id: 171
tags: [code-review, phase-0, regional-intelligence, trigger-evaluator, bug]
dependencies: []
---

# isCloseToThreshold watching band inverted for lt/lte operators

## Problem Statement

`scripts/regional-snapshot/trigger-evaluator.mjs:120-126` uses `ratio = value / target; return ratio > 0.8 && ratio < 1.0`. This is only correct for gt/gte triggers with positive thresholds. For lt with threshold 0.3, value 0.32 has ratio 1.07 which returns false (dormant), while value 0.28 has ratio 0.93 which returns true (watching). But 0.28 already PASSES the "less than" check (should be active), and 0.32 is what's actually close to breaching. The watching band is inverted for lt/lte operators. Also broken for negative thresholds (delta_lt with -0.20). Phase 1 will unstub delta ops and surface this bug.

## Findings

- `scripts/regional-snapshot/trigger-evaluator.mjs:120-126` — current ratio-based implementation only handles gt/gte with positive thresholds correctly.

## Proposed Solutions

### Option 1: Branch on threshold.operator

Implement explicit operator-aware watching bands:
- For `gt` / `gte`: `value >= t * 0.8 && value < t`
- For `lt` / `lte`: `value > t && value <= t * 1.2`
- For `delta_*` operators: return `false` (Phase 0 stub)

**Pros:** Correct semantics per operator; fits current stub-until-Phase-1 posture for delta ops; simple to test.
**Cons:** None significant.
**Effort:** Small.
**Risk:** Low.

### Option 2: Distance-from-threshold formulation

Normalize via absolute distance: `Math.abs(value - t) / Math.abs(t) <= 0.2 && !isActive(value, t, op)`.

**Pros:** Single formula, no operator branching.
**Cons:** Requires access to `isActive` result; denominator zero-guard needed; less readable than explicit branching.
**Effort:** Small.
**Risk:** Medium (zero-threshold division, subtle negative-threshold cases).

## Recommended Action

Option 1 — explicit operator branching. Small surface area, clear semantics, easy unit tests.

## Technical Details

Current buggy code at `trigger-evaluator.mjs:120-126` treats `ratio < 1.0` as universally meaning "not yet breached." That is only true when the trigger is `gt/gte` and the threshold is positive. For `lt` triggers the inequality is reversed: a value above threshold is the dormant/approaching side, while a value below is already-active. The fix partitions the computation by operator and returns `false` for all `delta_*` operators while Phase 0 still stubs them.

Negative thresholds (e.g. `delta_lt: -0.20`) are also silently wrong under the current formulation because `value / target` has the wrong sign semantics.

## Acceptance Criteria

- [ ] Test: `isCloseToThreshold(0.28, { operator: 'lt', value: 0.3 })` returns `false` (it's already active).
- [ ] Test: `isCloseToThreshold(0.32, { operator: 'lt', value: 0.3 })` returns `true` (close to breaching).
- [ ] Test: `isCloseToThreshold(0.85, { operator: 'gte', value: 1.0 })` returns `true`.
- [ ] Test: `delta_*` operators always return `false` in Phase 0.

## Work Log

## Resources

- PR #2940
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
