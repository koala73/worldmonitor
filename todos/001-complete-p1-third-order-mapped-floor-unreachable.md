---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, deep-forecast, scoring-math, architecture]
---

# third_order hypotheses can never reach `mapped` status (math impossibility)

## Problem Statement

`getImpactValidationFloors('third_order')` returns `{ multiplier: 0.72, mapped: 0.74 }`. The maximum `baseScore` after `clampUnitInterval` is 1.0, so `validationScore = clampUnitInterval(baseScore * 0.72) ≤ 0.72`. The mapped floor check `validationScore >= 0.74` is permanently false. Every third_order hypothesis is silently demoted to `trace_only` regardless of quality. The parent-must-be-mapped invariant for third_order (lines 10473-10477) is also dead code.

## Findings

- `seed-forecasts.mjs:10285` — `return { internal: 0.66, mapped: 0.74, multiplier: 0.72 };`
- `validationScore = clampUnitInterval(baseScore * 0.72)` — max is 0.72
- `0.72 >= 0.74` — always false
- `gateDetails` in debug artifact only shows `secondOrderMappedFloor`, hiding this bug

## Proposed Solutions

### Option A: Lower the mapped floor (Recommended)

- Change `mapped: 0.74` to `mapped: 0.70`
- `0.72 >= 0.70` — now reachable at high-quality third_order hypotheses
- Effort: Small | Risk: Low

### Option B: Raise the multiplier

- Change `multiplier: 0.72` to `multiplier: 0.80`
- Max validationScore becomes 0.80, clears 0.74 floor
- Effort: Small | Risk: Medium (changes scoring distribution)

### Option C: Explicitly disable third_order (document as intentional)

- Set `mapped: 2.0` to make it permanently unreachable with a comment explaining why
- Preserves current behavior intentionally
- Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `third_order` hypothesis with strength=0.85, confidence=0.82, 2 refs, route match reaches `mapped` in test
- [ ] `gateDetails` in debug artifact includes `thirdOrderMappedFloor` alongside `secondOrderMappedFloor`
- [ ] T-conv or new test asserts third_order reachability

## Technical Details

- File: `scripts/seed-forecasts.mjs:10285`
- Function: `getImpactValidationFloors`

## Work Log

- 2026-03-24: Found by kieran-typescript-reviewer in PR #2178 review
