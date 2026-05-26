---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, performance, redis]
---

# 3 Redis GETs per deep forecast completion when quality is already high (no rate-limit applied)

## Problem Statement

`runImpactExpansionPromptRefinement` reads `PROMPT_LAST_ATTEMPT_KEY`, `PROMPT_BASELINE_KEY`, and `PROMPT_LEARNED_KEY` on every call. The `quality_met` early-exit path (quality >= 0.80) returns early WITHOUT setting `PROMPT_LAST_ATTEMPT_KEY`. So on every high-quality deep forecast run, the function makes 3 Redis GETs, updates the baseline, and exits — with no 30-minute cooldown applied. If deep forecasts run continuously with good quality, this generates unbounded Redis reads.

## Findings

- `seed-forecasts.mjs:14437` — `quality_met` early exit: does NOT set `PROMPT_LAST_ATTEMPT_KEY`
- `seed-forecasts.mjs:14412-14413` — reads `lastAttemptRaw` (1 GET)
- `seed-forecasts.mjs:14419` — reads `baselineRaw` (1 GET)
- `seed-forecasts.mjs:14443` — reads `currentLearnedSection` (1 GET)
- = 3 GETs per run when quality is consistently good, no backoff applied

## Proposed Solutions

### Option A: Set `PROMPT_LAST_ATTEMPT_KEY` in `quality_met` path (Recommended)

```javascript
// In quality_met path, set rate-limit so next 30 min skip entirely
await redisSet(url, token, PROMPT_LAST_ATTEMPT_KEY, String(Date.now()), 3600);
return { iterationCount: 0, committed: false, exitReason: 'quality_met' };
```
Effort: Tiny | Risk: Low

### Option B: Check rate-limit FIRST, before all other Redis reads

- Move `lastAttemptRaw` check to be the very first operation
- On rate-limited: return immediately (0 Redis reads instead of 3)
- Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] High-quality runs (composite >= 0.80) do NOT trigger 3 Redis GETs on consecutive calls within 30 minutes
- [ ] Rate-limit key is set in `quality_met` path

## Technical Details

- File: `scripts/seed-forecasts.mjs:14437`
- Function: `runImpactExpansionPromptRefinement`

## Work Log

- 2026-03-24: Found by compound-engineering:review:performance-oracle in PR #2178 review
