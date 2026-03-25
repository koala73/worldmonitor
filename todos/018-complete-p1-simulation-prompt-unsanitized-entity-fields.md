---
status: complete
priority: p1
issue_id: "018"
tags: [code-review, security, simulation-runner, prompt-injection]
---

# Unsanitized entity/seed fields injected into LLM simulation prompts

## Problem Statement

`buildSimulationRound1SystemPrompt` and `buildSimulationRound2SystemPrompt` interpolate multiple fields directly into LLM system prompts without calling `sanitizeForPrompt`. The fields `e.entityId`, `e.class`, `e.stance`, `s.seedId`, `s.type`, `s.timing`, and Round 1 `r.actorId` all bypass sanitization entirely. These fields originate from external news data processed by the package builder, where `entityId` is derived from actor names extracted from live headlines via regex. A crafted headline can produce an `entityId` that, when embedded in the system prompt with the instruction "use exact entityId when citing actors", forms a valid prompt injection payload.

## Findings

**F-1 (HIGH):** `e.entityId` injected raw with explicit directive to LLM to use it verbatim:
```javascript
// scripts/seed-forecasts.mjs ~line 15402
`- ${e.entityId} | ${sanitizeForPrompt(e.name)} | class=${e.class} | stance=${e.stance || 'unknown'}`
// e.entityId, e.class, e.stance — none sanitized
```

**F-2 (HIGH):** Event seed fields `s.seedId`, `s.type`, `s.timing` injected raw:
```javascript
`- ${s.seedId} [${s.type}] ${sanitizeForPrompt(s.summary)} (${s.timing})`
```

**F-3 (HIGH):** Round 2 prompt uses `r.actorId` from Round 1 LLM output (chaining injection risk):
```javascript
// scripts/seed-forecasts.mjs ~line 15468
actors: ${(p.initialReactions || []).slice(0, 3).map((r) => r.actorId).join(', ')}
// r.actorId comes from LLM JSON output — not sanitized before round 2 injection
```

`sanitizeProposedLlmAddition` exists in the same file and provides keyword-pattern blocking ("ignore", "override", "you must") but is never called on simulation fields.

## Proposed Solutions

### Option A: Apply `sanitizeForPrompt` to all bypassed fields (Recommended)

```javascript
// In buildSimulationRound1SystemPrompt:
const entityList = theaterEntities.slice(0, 10).map(
  (e) => `- ${sanitizeForPrompt(e.entityId)} | ${sanitizeForPrompt(e.name)} | class=${sanitizeForPrompt(e.class)} | stance=${sanitizeForPrompt(e.stance || 'unknown')}`,
).join('\n');

const seedList = theaterSeeds.slice(0, 8).map(
  (s) => `- ${sanitizeForPrompt(s.seedId)} [${sanitizeForPrompt(s.type)}] ${sanitizeForPrompt(s.summary)} (${sanitizeForPrompt(s.timing)})`,
).join('\n');

// In buildSimulationRound2SystemPrompt:
actors: ${(p.initialReactions || []).slice(0, 3).map((r) => sanitizeForPrompt(r.actorId || '')).join(', ')}
```

Effort: Small | Risk: Low

### Option B: Enforce allowlist regex on `entityId` at package-build time

Add `/^[a-z0-9_\-]{1,80}$/` validation in `buildSimulationPackageEntities` at the point where `entityId` is generated. Reject any ID not matching the pattern. This is defense-in-depth upstream.

Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] All fields interpolated into simulation system prompts are wrapped in `sanitizeForPrompt()`
- [ ] `e.entityId`, `e.class`, `e.stance` sanitized in `buildSimulationRound1SystemPrompt`
- [ ] `s.seedId`, `s.type`, `s.timing` sanitized in `buildSimulationRound1SystemPrompt`
- [ ] `r.actorId` sanitized in `buildSimulationRound2SystemPrompt`
- [ ] Test: entity with `entityId` containing newline + directive text produces sanitized prompt

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `buildSimulationRound1SystemPrompt` (~line 15397), `buildSimulationRound2SystemPrompt` (~line 15430), `buildSimulationRound2SystemPrompt` (~line 15468)
- Existing function: `sanitizeForPrompt(text)` at line ~13481 — strips newlines, `<>{}`, control chars, truncates at 200 chars
- Related: todo #013 (package-builder sanitization) — this is the downstream consumer gap

## Work Log

- 2026-03-24: Found by compound-engineering:review:security-sentinel in PR #2220 review
