---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, deep-forecast, llm-budget, architecture]
---

# `runImpactExpansionPromptRefinement` fires LLM call when validation is empty

## Problem Statement

In `processDeepForecastTask`, the non-completed branch (status != 'completed') calls `runImpactExpansionPromptRefinement(candidatePackets, evaluation.validation || {})`. When `evaluation.validation` is empty (no mapped hypotheses), `scoreImpactExpansionQuality({}, candidatePackets)` produces composite=0.0, which is below the 0.80 quality threshold, unconditionally triggering the critique LLM call on every failed deep forecast run. This wastes LLM budget with no useful signal.

## Findings

- `seed-forecasts.mjs:14215-14219` — non-completed branch calls refinement with `evaluation.validation || {}`
- `scoreImpactExpansionQuality({}, candidatePackets)` → composite=0 → triggers critique
- Critique prompt receives empty validation data, cannot generate useful guidance
- Rate limit is set (prevents infinite loop), but 1 wasted LLM call per non-completed run still occurs

## Proposed Solutions

### Option A: Guard with mapped count check (Recommended)

```javascript
if (evaluation.validation?.mapped?.length > 0) {
  runImpactExpansionPromptRefinement(candidatePackets, evaluation.validation)
    .catch((err) => console.warn('[PromptRefinement] Error:', err.message));
}
```
Effort: Small | Risk: Low

### Option B: Always pass to refinement but guard inside the function

- Add early exit in `runImpactExpansionPromptRefinement` when `validation.mapped?.length === 0`
- Effort: Small | Risk: Low (duplicates the guard logic)

## Acceptance Criteria

- [ ] Deep forecast run with no mapped hypotheses does NOT trigger LLM critique call
- [ ] Log message confirms skip: `[PromptRefinement] Skipping — no mapped hypotheses`
- [ ] Existing refinement tests still pass

## Technical Details

- File: `scripts/seed-forecasts.mjs:14215`
- Function: `processDeepForecastTask`

## Work Log

- 2026-03-24: Found by kieran-typescript-reviewer in PR #2178 review
