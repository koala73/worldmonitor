---
status: pending
priority: p2
issue_id: "091"
tags: [code-review, security, simulation, sanitization]
dependencies: []
---

# `sanitizeForPrompt` does not strip Unicode line-separator characters (U+2028, U+2029)

## Problem Statement

`sanitizeForPrompt` strips `\n` and `\r` but not Unicode LINE SEPARATOR (U+2028) or PARAGRAPH SEPARATOR (U+2029). Some LLM tokenizers treat these as line breaks. For the new `CANDIDATE ACTOR ROLES` section in the Round 2 prompt, role strings derived from `stateSummary.actors` (LLM-generated caseFile output) could theoretically contain these characters, allowing a role string to inject a structural line break into the prompt without being caught.

## Findings

- Flagged by security-sentinel during PR #2582 review
- Current regex: `.replace(/[\n\r]/g, ' ')`
- Proposed: `.replace(/[\n\r\u2028\u2029]/g, ' ')`
- Impact is low-risk for current pipeline (role strings are short, server-side only, no user input reaches this path), but is a defence-in-depth gap that applies to all callers of `sanitizeForPrompt`
- Fix benefits ALL LLM prompt construction across the codebase, not just the new `rolesSection`

## Proposed Solution

In `scripts/seed-forecasts.mjs` (line ~14040):

```js
// BEFORE:
function sanitizeForPrompt(str) {
  return String(str || '').replace(/[\n\r]/g, ' ').replace(/[<>{}]/g, '').replace(/[\x00-\x1f]/g, '').slice(0, 200);
}

// AFTER:
function sanitizeForPrompt(str) {
  return String(str || '').replace(/[\n\r\u2028\u2029]/g, ' ').replace(/[<>{}]/g, '').replace(/[\x00-\x1f]/g, '').slice(0, 200);
}
```

## Technical Details

- Files: `scripts/seed-forecasts.mjs` (sanitizeForPrompt function)
- Effort: Trivial | Risk: Very Low (pure defence-in-depth, no behavior change for current inputs)

## Acceptance Criteria

- [ ] `sanitizeForPrompt` strips U+2028 and U+2029
- [ ] `npm run test:data` passes

## Work Log

- 2026-03-31: Identified by security-sentinel during PR #2582 review
