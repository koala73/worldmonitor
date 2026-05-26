---
status: complete
priority: p2
issue_id: "025"
tags: [code-review, performance, simulation-runner, llm]
---

# Round 1 token budget (1800) may be too tight for fully-populated theaters

## Problem Statement

`SIMULATION_ROUND1_MAX_TOKENS = 1800` is the output token cap for Round 1 LLM calls. With a fully-populated theater (10 entities, 8 seeds, constraints, eval targets, simulation requirement, plus the ~350-token JSON response template), the system prompt alone consumes ~1,030 tokens. This leaves ~770 tokens for the response. A minimal valid Round 1 response (3 paths with labels, summaries, and 3 `initialReactions` each) costs ~700-900 tokens. At the high end of entity/seed density, the model will truncate its JSON mid-object, causing `round1_parse_failed` and marking the theater as failed — silently, with no token-exhaustion signal in the diagnostic.

## Findings

**F-1 (HIGH):** Token budget vs. prompt size analysis:

- Static template text: ~350 tokens
- 10 entities at ~20 tokens each: ~200 tokens
- 8 event seeds at ~25 tokens each: ~200 tokens
- simulationRequirement + constraints + evalTargets: ~255 tokens
- **Total input: ~1,005 tokens**
- **Output budget remaining: 795 tokens**
- Minimal valid Round 1 response (3 paths, 3 reactions each): **~700-900 tokens**
- Margin: **-105 to +95 tokens** — essentially zero at max density

`SIMULATION_ROUND2_MAX_TOKENS = 2500` is adequate for Round 2 (shorter input, richer output).

## Proposed Solutions

### Option A: Raise `SIMULATION_ROUND1_MAX_TOKENS` to 2200 + cap `initialReactions` in prompt (Recommended)

```javascript
const SIMULATION_ROUND1_MAX_TOKENS = 2200; // was 1800

// In buildSimulationRound1SystemPrompt INSTRUCTIONS section, add:
// - Maximum 3 initialReactions per path
```

This provides a 1,195-token output margin (2200 - 1005) which comfortably fits 3 paths × 3 reactions. The `initialReactions` cap aligns with existing behavior (only 3 are used in Round 2 path summaries).

Effort: Trivial | Risk: Very Low — increases LLM output budget, no structural change

### Option B: Dynamic token calculation based on entity/seed count

Calculate prompt token estimate and adjust `maxTokens` accordingly. More precise but adds complexity with no meaningful benefit given the fixed slice limits.

## Acceptance Criteria

- [ ] `SIMULATION_ROUND1_MAX_TOKENS` raised from 1800 to 2200
- [ ] INSTRUCTIONS block in `buildSimulationRound1SystemPrompt` includes "- Maximum 3 initialReactions per path"
- [ ] Existing tests pass (prompt builder tests check content, not token count)

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `SIMULATION_ROUND1_MAX_TOKENS` (~line 38), `buildSimulationRound1SystemPrompt` INSTRUCTIONS section (~line 15445)

## Work Log

- 2026-03-24: Found by compound-engineering:review:performance-oracle in PR #2220 review
