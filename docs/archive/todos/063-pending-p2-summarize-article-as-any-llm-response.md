---
status: pending
priority: p2
issue_id: "063"
tags: [code-review, typescript, quality, analytical-frameworks]
dependencies: []
---

# `as any` on LLM response in `summarize-article.ts` bypasses type safety

## Problem Statement
`server/worldmonitor/news/v1/summarize-article.ts` line 155 casts the JSON response to `any`:
```ts
const data = await response.json() as any;
```
This bypasses TypeScript type checking for `data.usage`, `data.choices`, etc. Every other LLM response handler in the codebase uses a typed inline cast. The inline type already exists in `llm.ts` and can be reused.

## Proposed Solution
Replace with typed cast:
```ts
const data = await response.json() as {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
};
```

## Technical Details
- File: `server/worldmonitor/news/v1/summarize-article.ts:155`
- Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] `as any` removed from `summarize-article.ts` LLM response handling
- [ ] TypeScript passes with no new `any` usages

## Work Log
- 2026-03-28: Identified by kieran-typescript-reviewer during PR #2386 review
