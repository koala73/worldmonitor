---
status: pending
priority: p3
issue_id: "055"
tags: [code-review, quality, analytical-frameworks]
dependencies: []
---

# `FrameworkSelector` hardcodes `'insights'` panel — should use `note?: string` option

## Problem Statement
`FrameworkSelector.ts` has a branch `if (opts.panelId === 'insights')` that wraps the select with a `*` asterisk note. This is a panel-specific concern baked into a supposedly generic component. Every future panel requiring a note requires modifying this component. The `FrameworkSelectorOptions` interface should accept a `note?: string` option instead, with the caller (InsightsPanel constructor) passing the note text.

## Findings
- **`src/components/FrameworkSelector.ts:36-47`** — hardcoded `if (opts.panelId === 'insights')` with asterisk wrapper
- The same note is now needed for DailyMarketBriefPanel (see todo #053)
- Flagged by: code-simplicity-reviewer

## Proposed Solutions

### Option A: Add `note?: string` to FrameworkSelectorOptions
```ts
interface FrameworkSelectorOptions {
  panelId: AnalysisPanelId;
  isPremium: boolean;
  panel: Panel | null;
  note?: string;
}
```
InsightsPanel passes `note: '* Applies to client-generated analysis only'`.
Remove the `if panelId === 'insights'` branch from the constructor.
**Effort:** Small | **Risk:** Low

## Technical Details
- File: `src/components/FrameworkSelector.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] No panel IDs hardcoded in `FrameworkSelector` constructor
- [ ] `note?: string` option accepted and rendered when provided
- [ ] InsightsPanel and DailyMarketBriefPanel pass appropriate notes

## Work Log
- 2026-03-27: Identified during PR #2380 review by code-simplicity-reviewer
