---
status: pending
priority: p2
issue_id: "070"
tags: [code-review, correctness, ui, analytical-frameworks]
dependencies: []
---

# `FrameworkSelector.refresh()` falls back to stale option value when framework is deleted

## Problem Statement
`src/components/FrameworkSelector.ts` `refresh()` method (lines 91-93):
```ts
refresh(): void {
  if (!this.select) return;
  const current = this.select.value;
  this.populateOptions(this.select);
  this.select.value = getActiveFrameworkForPanel(this.panelId)?.id ?? current;
}
```
If the currently selected framework was deleted from the library, `getActiveFrameworkForPanel` returns `null`, and `?.id ?? current` falls back to `current` (the stale value of the now-deleted option). The select ends up pointing at an option that no longer exists — a silent empty selection with no visual feedback to the user.

## Proposed Solution
Fall back to `''` (default) instead of the stale value:
```ts
this.select.value = getActiveFrameworkForPanel(this.panelId)?.id ?? '';
```

## Technical Details
- File: `src/components/FrameworkSelector.ts:91-93`
- Effort: Trivial | Risk: Low

## Acceptance Criteria
- [ ] Deleting the active framework resets the selector to "Default (Neutral)" on next refresh
- [ ] No silent stale selection after framework deletion

## Work Log
- 2026-03-28: Identified by kieran-typescript-reviewer during PR #2386 review
