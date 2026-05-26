---
status: complete
priority: p2
issue_id: "023"
tags: [code-review, security, simulation-runner, data-integrity]
---

# LLM output arrays written to R2 without per-element sanitization or length limits

## Problem Statement

In `processNextSimulationTask`, several LLM output arrays are written to R2 using only `map(String).slice(0, N)` — which ensures items are strings but applies no length cap per element and no sanitization. A single oversized or injection-containing LLM output item (e.g., a `stabilizers` entry of 50,000 characters) is written directly to R2 and later served to clients without truncation. Additionally, the `timingMarkers` sourced from `result.round2?.paths?.[0]` use a different (non-sanitized) path compared to the per-path `timingMarkers` processing that correctly applies `sanitizeForPrompt`.

## Findings

**F-1 (MEDIUM):**
```javascript
// scripts/seed-forecasts.mjs ~line 15766
dominantReactions: (result.round1?.dominantReactions || []).map(String).slice(0, 6),
stabilizers: (result.round2?.stabilizers || []).map(String).slice(0, 6),
invalidators: (result.round2?.invalidators || []).map(String).slice(0, 6),
keyActors: Array.isArray(p.keyActors) ? p.keyActors.map(String).slice(0, 6) : [],
// No per-element length limit or sanitization — each string can be arbitrarily long
```

**F-2 (MEDIUM):**
```javascript
// ~line 15769 — timingMarkers from round2 paths[0] (different code path than per-path markers)
timingMarkers: (result.round2?.paths?.[0]?.timingMarkers || []).slice(0, 4),
// Individual marker objects NOT sanitized — but per-path timingMarkers at ~15757 DO sanitize
```

## Proposed Solutions

### Option A: Apply `sanitizeForPrompt` + length cap to all LLM array elements (Recommended)

```javascript
dominantReactions: (result.round1?.dominantReactions || [])
  .map((s) => sanitizeForPrompt(String(s)).slice(0, 120)).slice(0, 6),
stabilizers: (result.round2?.stabilizers || [])
  .map((s) => sanitizeForPrompt(String(s)).slice(0, 120)).slice(0, 6),
invalidators: (result.round2?.invalidators || [])
  .map((s) => sanitizeForPrompt(String(s)).slice(0, 120)).slice(0, 6),
keyActors: Array.isArray(p.keyActors)
  ? p.keyActors.map((s) => sanitizeForPrompt(String(s)).slice(0, 80)).slice(0, 6)
  : [],
// For timingMarkers at ~15769 — apply same sanitization as per-path version:
timingMarkers: (result.round2?.paths?.[0]?.timingMarkers || []).slice(0, 4)
  .map((m) => ({ event: sanitizeForPrompt(m.event || '').slice(0, 80), timing: String(m.timing || 'T+0h').slice(0, 10) })),
```

Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `dominantReactions`, `stabilizers`, `invalidators` elements capped at 120 chars each with `sanitizeForPrompt`
- [ ] `keyActors` elements capped at 80 chars each with `sanitizeForPrompt`
- [ ] `timingMarkers` at the theater-result level uses the same sanitization as per-path version
- [ ] Test: LLM output with a 10,000-char `stabilizers[0]` is truncated to ≤120 chars in R2 artifact

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `processNextSimulationTask` (~lines 15752, 15766-15769)

## Work Log

- 2026-03-24: Found by compound-engineering:review:security-sentinel in PR #2220 review
