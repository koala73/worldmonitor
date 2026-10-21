---
status: pending
priority: p3
issue_id: "056"
tags: [code-review, quality, analytical-frameworks]
dependencies: []
---

# `stripThinkingTags` logic duplicated verbatim in `summarize-article.ts` — should use shared function

## Problem Statement
`server/worldmonitor/news/v1/summarize-article.ts` contains a 16-line inline reimplementation of the `stripThinkingTags` function that already exists and is exported from `server/_shared/llm.ts`. The two implementations have identical pattern matching logic. Any future change to the thinking-tag stripping behavior must be applied in two places.

## Findings
- **`server/worldmonitor/news/v1/summarize-article.ts:155-170`** — inline `stripThinkingTags` implementation
- **`server/_shared/llm.ts`** — exports `stripThinkingTags` (or equivalent function)
- Flagged by: code-simplicity-reviewer

## Proposed Solutions

### Option A: Import and use the shared function (Recommended)
```ts
import { stripThinkingTags } from '../../_shared/llm.js';
// Replace inline implementation with:
const cleaned = stripThinkingTags(rawSummary);
```
**Effort:** Trivial | **Risk:** Low

## Technical Details
- Files: `server/worldmonitor/news/v1/summarize-article.ts`, `server/_shared/llm.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] `summarize-article.ts` imports `stripThinkingTags` from `_shared/llm.ts`
- [ ] No inline implementation remains
- [ ] Both files use identical tag-stripping logic from the same source

## Work Log
- 2026-03-27: Identified during PR #2380 review by code-simplicity-reviewer
