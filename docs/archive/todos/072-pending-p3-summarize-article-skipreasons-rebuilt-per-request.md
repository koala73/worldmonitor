---
status: pending
priority: p3
issue_id: "072"
tags: [code-review, performance, quality, analytical-frameworks]
dependencies: []
---

# `skipReasons` object rebuilt on every request in `summarize-article.ts`

## Problem Statement
`server/worldmonitor/news/v1/summarize-article.ts` lines 65-69 builds a `skipReasons` object on every invocation including hot-path cache hits:
```ts
const skipReasons: Record<string, string> = {
  ollama: 'OLLAMA_API_URL not configured',
  groq: 'GROQ_API_KEY not configured',
  openrouter: 'OPENROUTER_API_KEY not configured',
};
```
Also `!headlines` check on line 89 is dead code — `headlines` is always an array at that point (returned by `sanitizeHeadlinesLight`).

## Proposed Solution
Move `skipReasons` to module-level constant and remove dead null check:
```ts
const SKIP_REASONS: Record<string, string> = { ... }; // module level

// line 89: change
if (!headlines || !Array.isArray(headlines) || headlines.length === 0)
// to:
if (headlines.length === 0)
```

## Technical Details
- File: `server/worldmonitor/news/v1/summarize-article.ts:65-69, 89`
- Effort: Trivial | Risk: Low

## Work Log
- 2026-03-28: Identified by code-simplicity-reviewer during PR #2386 review
