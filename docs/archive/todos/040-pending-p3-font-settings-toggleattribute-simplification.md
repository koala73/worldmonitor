---
status: pending
priority: p3
issue_id: "040"
tags: [code-review, quality, font, simplification]
dependencies: []
---

# `applyFont()` if/else can be replaced with `toggleAttribute`

## Problem Statement
The current `applyFont()` uses an if/else with asymmetric operations (`dataset.font = 'system'` vs `delete dataset.font`).
This introduces a string coupling between TS (`'system'`) and CSS (`[data-font="system"]`).
`toggleAttribute` is the idiomatic DOM API for boolean attribute toggling and collapses 5 lines to 1.

## Proposed Solution

### Option A: Use `toggleAttribute` + boolean CSS selector
```ts
export function applyFont(font?: FontFamily): void {
  const resolved = font ?? getFontFamily();
  document.documentElement.toggleAttribute('data-font-system', resolved === 'system');
}
```
CSS changes to:
```css
[data-font-system] {
  --font-body-base: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
```
**Pros:** No string value coupling, 1 line, idiomatic | **Cons:** Requires CSS selector rename | **Effort:** Small | **Risk:** Low

### Option B: Keep as-is
The if/else is not harmful, just not minimal. Accept current form.

## Technical Details
- File: `src/services/font-settings.ts`, `src/styles/main.css`
- PR: koala73/worldmonitor#2318

## Acceptance Criteria
- [ ] `applyFont()` is one expression
- [ ] No string value coupling between TS and CSS selector

## Work Log
- 2026-03-27: Identified during PR #2318 review via code-simplicity-reviewer
