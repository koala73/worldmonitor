---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, deep-forecast, data-integrity]
---

# `candidateSection` overflow discards entire learned history instead of trimming

## Problem Statement

When `currentLearnedSection + '\n\n' + sanitizedAddition` exceeds `PROMPT_LEARNED_MAX_CHARS` (1600), the fallback sets `candidateSection = sanitizedAddition.slice(0, PROMPT_LEARNED_MAX_CHARS)`, discarding all prior accumulated learned content. The intent is clearly to keep the most recent guidance, but the current logic drops everything old and keeps only the new addition.

## Findings

- `seed-forecasts.mjs:14482-14487`:
  ```js
  if (candidateSection.length > PROMPT_LEARNED_MAX_CHARS) {
    candidateSection = sanitizedAddition.slice(0, PROMPT_LEARNED_MAX_CHARS);
  }
  ```
- On overflow, ALL prior learned content is silently erased
- Over multiple refinement runs, older guidance accumulates to >1600 chars and is eventually dropped entirely

## Proposed Solutions

### Option A: Keep tail (most recent content) on overflow (Recommended)

```javascript
if (candidateSection.length > PROMPT_LEARNED_MAX_CHARS) {
  candidateSection = candidateSection.slice(-PROMPT_LEARNED_MAX_CHARS);
}
```
Keeps the most recent 1600 chars (appended content is at the end). Effort: Tiny | Risk: Low

### Option B: Keep head (oldest content) on overflow

- Drop new addition if combined exceeds limit
- Preserves stability at cost of never updating
- Effort: Tiny | Risk: Low

## Acceptance Criteria

- [ ] When combined section > 1600 chars, `currentLearnedSection` content is partially preserved (not fully dropped)
- [ ] New test: concatenation overflow keeps tail of combined string, not just sanitizedAddition alone

## Technical Details

- File: `scripts/seed-forecasts.mjs:14482-14487`

## Work Log

- 2026-03-24: Found by kieran-typescript-reviewer in PR #2178 review
