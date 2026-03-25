---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, agent-native, deep-forecast]
---

# Redis key constants for self-improvement loop not exported — agent cannot control learned section

## Problem Statement

`PROMPT_LEARNED_KEY`, `PROMPT_BASELINE_KEY`, and `PROMPT_LAST_ATTEMPT_KEY` are module-private. An agent that needs to clear a degraded learned section, reset the rate-limit gate, or audit the current learned content has no programmatic way to do so. The control path is a black box post-invocation.

## Findings

- `seed-forecasts.mjs:14256-14258` — three key constants, not in export block
- Export block (`seed-forecasts.mjs:14857-15009`) — no key constants listed
- `runImpactExpansionPromptRefinement` is exported (write-trigger), but read/clear is impossible
- `redisGet` and `redisDel` also not exported

## Proposed Solutions

### Option A: Export key constants + helper functions (Recommended)

```javascript
// Export the key names
export { PROMPT_LEARNED_KEY, PROMPT_BASELINE_KEY, PROMPT_LAST_ATTEMPT_KEY }

// Add thin helpers
export async function readImpactPromptLearnedSection(url, token) {
  return (await redisGet(url, token, PROMPT_LEARNED_KEY)) || '';
}
export async function clearImpactPromptLearnedSection(url, token) {
  await redisDel(url, token, PROMPT_LEARNED_KEY);
  await redisDel(url, token, PROMPT_LAST_ATTEMPT_KEY);
}
```
Effort: Small | Risk: Low

### Option B: Export key constants only

- Let callers use their own Redis client with the exported key names
- Effort: Tiny | Risk: Low

## Acceptance Criteria

- [ ] Agent can call `readImpactPromptLearnedSection` and get current content
- [ ] Agent can call `clearImpactPromptLearnedSection` to reset after regression
- [ ] Key constants exported for scripts that need them

## Technical Details

- File: `scripts/seed-forecasts.mjs:14256-14258`

## Work Log

- 2026-03-24: Found by compound-engineering:review:agent-native-reviewer in PR #2178 review
