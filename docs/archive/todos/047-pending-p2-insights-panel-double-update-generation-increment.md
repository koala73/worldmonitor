---
status: pending
priority: p2
issue_id: "047"
tags: [code-review, quality, analytical-frameworks, insights-panel]
dependencies: []
---

# `InsightsPanel` — double `updateGeneration` increment causes stale cancellation

## Problem Statement
In `InsightsPanel`, the framework change subscription (in constructor) increments `this.updateGeneration++` before calling `this.updateInsights()`. However, `updateInsights()` also increments `this.updateGeneration++` at its start (line ~270). This means every framework change causes the generation counter to advance by 2 instead of 1. Any in-flight `updateInsights` call checks `gen === this.updateGeneration` partway through — with the double increment, even the call we WANT to complete will see a stale generation and cancel itself, causing InsightsPanel to never update when the framework changes.

## Findings
- **`src/components/InsightsPanel.ts:55-58`** — subscription handler: `this.updateGeneration++; void this.updateInsights(this.lastClusters);`
- **`src/components/InsightsPanel.ts:~270`** — `updateInsights()` start: `const gen = ++this.updateGeneration;`
- Net result: generation is 2 higher than the call captured in `gen`, so the in-progress generation check `gen === this.updateGeneration` (e.g., line 449, 472) immediately fails
- Flagged by: kieran-typescript-reviewer, performance-oracle

## Proposed Solutions

### Option A: Remove manual increment from subscription handler (Recommended)
The subscription handler should only call `updateInsights` — let the method manage the generation counter internally:
```ts
this.frameworkUnsubscribe = subscribeFrameworkChange('insights', () => {
  void this.updateInsights(this.lastClusters);
});
```
`updateInsights` already does `const gen = ++this.updateGeneration` at its start, which is the correct single increment.
**Pros:** One-line fix, aligns with existing cancellation pattern | **Effort:** Trivial | **Risk:** Low

### Option B: Pre-capture gen in subscription handler and pass to updateInsights
Restructure `updateInsights` to accept an optional gen parameter.
**Pros:** More explicit | **Cons:** Over-engineering for a one-line bug fix | **Effort:** Medium | **Risk:** Medium

## Technical Details
- File: `src/components/InsightsPanel.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] Framework change triggers one `updateGeneration` increment total (inside `updateInsights`)
- [ ] InsightsPanel actually re-renders when framework changes (end-to-end test)
- [ ] No duplicate increment in the subscription handler

## Work Log
- 2026-03-27: Identified during PR #2380 review by kieran-typescript-reviewer and performance-oracle
