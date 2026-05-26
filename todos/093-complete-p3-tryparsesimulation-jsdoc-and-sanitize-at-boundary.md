---
status: pending
priority: p3
issue_id: "093"
tags: [code-review, typescript, simulation, security]
dependencies: []
---

# `tryParseSimulationRoundPayload` missing JSDoc after export + apply `sanitizeForPrompt` at parse boundary

## Problem Statement

Two related cleanup items on the newly-exported `tryParseSimulationRoundPayload`:

1. **Missing JSDoc** — the function was private before PR #2582. Exporting it without JSDoc annotations means `@ts-check` callers get no type feedback on parameters. The project pattern for exported functions is to annotate `@param` and `@returns`.

2. **`sanitizeForPrompt` deferred to merge step** — `tryParseSimulationRoundPayload` applies only `String(s).trim()` to `keyActorRoles` items. Sanitization happens later in `mergedPaths.map()`. If a future caller uses `tryParseSimulationRoundPayload` directly (e.g., in a test or a new code path) and skips the merge step, unsanitized LLM strings will escape. The fix is to apply `sanitizeForPrompt` at the parse boundary.

## Proposed Solution

Add JSDoc:
```js
/**
 * @param {string} text - raw LLM response text (may be JSON or JSON-with-prefix)
 * @param {1 | 2} round - simulation round number
 * @returns {{ paths: import('./seed-forecasts.types.d.ts').SimulationTopPath[] | null, stabilizers?: string[], invalidators?: string[], globalObservations?: string, confidenceNotes?: string, dominantReactions?: string[] }}
 */
function tryParseSimulationRoundPayload(text, round) {
```

Apply `sanitizeForPrompt` at parse boundary:
```js
// BEFORE:
p.keyActorRoles.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 10)

// AFTER:
p.keyActorRoles.map((s) => sanitizeForPrompt(String(s || '')).trim()).filter(Boolean).slice(0, 10)
```

Note: `.trim()` after `sanitizeForPrompt` is fine since `sanitizeForPrompt` doesn't strip leading/trailing spaces.

## Technical Details

- Files: `scripts/seed-forecasts.mjs` (tryParseSimulationRoundPayload)
- Effort: Trivial | Risk: Very Low

## Acceptance Criteria

- [ ] `tryParseSimulationRoundPayload` has `@param` + `@returns` JSDoc
- [ ] `sanitizeForPrompt` applied to `keyActorRoles` items at parse time
- [ ] T-P3 test still passes

## Work Log

- 2026-03-31: Identified by kieran-typescript-reviewer and security-sentinel during PR #2582 review
