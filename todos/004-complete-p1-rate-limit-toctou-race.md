---
status: pending
priority: p1
issue_id: "004"
tags: [code-review, security, race-condition, redis]
---

# TOCTOU race on refinement rate-limit key allows concurrent writes to learned section

## Problem Statement

`runImpactExpansionPromptRefinement` reads `PROMPT_LAST_ATTEMPT_KEY`, then sets it AFTER the async LLM calls complete. Two concurrent invocations (fire-and-forget from both `completed` and non-completed branches) can both read an empty/stale key, both proceed to the LLM critique call, and both write independent LLM-generated additions to `PROMPT_LEARNED_KEY`. The second write clobbers the first.

## Findings

- `seed-forecasts.mjs:14412-14413` — read `PROMPT_LAST_ATTEMPT_KEY`
- `seed-forecasts.mjs:14441` — set key AFTER LLM calls complete
- `processDeepForecastTask` calls fire-and-forget at lines 14188 AND 14215 — both can fire simultaneously
- No atomic SET NX EX in current `redisSet` wrapper
- The `PROMPT_LEARNED_KEY` write at line 14502 can be clobbered by the second concurrent winner

## Proposed Solutions

### Option A: SET the rate-limit key BEFORE the LLM call (Recommended)

```javascript
// Set immediately before LLM call to prevent TOCTOU
await redisSet(url, token, PROMPT_LAST_ATTEMPT_KEY, String(Date.now()), 3600);
const critiqueResult = await callForecastLLM(...);
```
If the process crashes mid-call, the rate-limit still fires (good). If both workers race to set, the second sees the first's key and exits.
Effort: Small | Risk: Low

### Option B: Add SET NX EX to Upstash REST wrapper

- Build `redisSetNx(url, token, key, value, ttl)` using Upstash REST pipeline
- Use atomic check-and-set: only the first writer succeeds
- Effort: Medium | Risk: Low

### Option C: Process-level mutex

- Use an in-memory `Set<string>` of in-flight refinement keys
- Only works if both invocations are in the same process (they are, for fire-and-forget)
- Effort: Small | Risk: Medium (only works single-process)

## Acceptance Criteria

- [ ] Two concurrent calls to `runImpactExpansionPromptRefinement` result in at most 1 Redis write to `PROMPT_LEARNED_KEY`
- [ ] Rate-limit key set before LLM call

## Technical Details

- File: `scripts/seed-forecasts.mjs:14412-14441`
- Function: `runImpactExpansionPromptRefinement`

## Work Log

- 2026-03-24: Found by compound-engineering:review:security-sentinel in PR #2178 review
