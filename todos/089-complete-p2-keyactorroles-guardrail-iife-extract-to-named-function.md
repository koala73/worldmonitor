---
status: pending
priority: p2
issue_id: "089"
tags: [code-review, quality, simulation, simplicity]
dependencies: []
---

# Extract `keyActorRoles` guardrail IIFE to named `sanitizeKeyActorRoles` function

## Problem Statement

The `keyActorRoles` guardrail in `mergedPaths.map()` is implemented as an 8-line IIFE. The logic is non-trivial (sanitize → check allowlist via normalizeActorName → filter), runs once per path per theater, and is currently untestable in isolation. IIFEs of this complexity violate the project's "extractable at natural boundaries" principle. Additionally, `allowed.map(normalizeActorName)` is recomputed fresh for every path, even though `theater.actorRoles` is constant across all paths in a theater.

## Findings

- Flagged by kieran-typescript-reviewer (HIGH) and code-simplicity-reviewer independently
- Performance: `allowedNorm` Set rebuilt per path (up to 5 paths × 12 roles = 60 redundant normalizeActorName calls per theater)
- The IIFE has no dedicated test — the guardrail filter behavior is only exercised implicitly through T-K (which covers the stateSummary path)
- The sanitize-before-filter ordering could cause a latent mismatch: `sanitizeForPrompt(s).slice(0,80)` is applied before `normalizeActorName(s)` comparison (normalizeActorName normalizes the truncated string, which is correct — but the intent is clearer with filter-first)

## Proposed Solution

Extract to a named function near the other sim helpers:

```js
/**
 * @param {string[] | undefined} rawRoles - LLM-returned role strings from keyActorRoles
 * @param {string[]} allowedRoles - theater.actorRoles allowlist (empty = no semantic filter)
 * @returns {string[]}
 */
function sanitizeKeyActorRoles(rawRoles, allowedRoles) {
  const sanitized = (Array.isArray(rawRoles) ? rawRoles : [])
    .map((s) => sanitizeForPrompt(String(s)).slice(0, 80));
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return sanitized.slice(0, 8);
  const allowedNorm = new Set(allowedRoles.map(normalizeActorName));
  return sanitized.filter((s) => allowedNorm.has(normalizeActorName(s))).slice(0, 8);
}
```

Then in `mergedPaths.map()`:
```js
keyActorRoles: sanitizeKeyActorRoles(p.keyActorRoles, theater.actorRoles),
```

And hoist (optional but clean):
```js
const allowedRoles = Array.isArray(theater.actorRoles) ? theater.actorRoles : [];
// pass allowedRoles to sanitizeKeyActorRoles for all paths in this theater
```

## Technical Details

- Files: `scripts/seed-forecasts.mjs`
- Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `sanitizeKeyActorRoles` is a named function (not IIFE)
- [ ] `allowedNorm` Set not recomputed per path when `allowed` is constant per theater
- [ ] `npm run test:data` passes
- [ ] New unit test for `sanitizeKeyActorRoles` (allowlist match, allowlist miss, empty allowed)

## Work Log

- 2026-03-31: Identified by kieran-typescript-reviewer and code-simplicity-reviewer during PR #2582 review
