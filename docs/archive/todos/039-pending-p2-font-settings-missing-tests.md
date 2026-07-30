---
status: pending
priority: p2
issue_id: "039"
tags: [code-review, quality, i18n, font]
dependencies: []
---

# `font-settings.ts` has no tests — subtle DOM invariant unverified

## Problem Statement
`applyFont()` sets/removes `document.documentElement.dataset.font` based on the font preference.
The key invariant: when `mono` is selected, the attribute must be **absent** entirely (not `''` or `'mono'`).
`delete dataset.font` is correct but non-obvious — setting it to `''` would be wrong and leave `[data-font="system"]` inactive but the attribute still present.
No test currently pins this behavior, so a future refactor could silently break it.

## Proposed Solutions

### Option A: Add `tests/font-settings.test.mts`
Use the existing `jsdom` environment (already used by other `.test.mts` files).

```ts
import { applyFont } from '../src/services/font-settings.ts';

test('system font sets data-font attribute', () => {
  applyFont('system');
  assert.strictEqual(document.documentElement.dataset.font, 'system');
  assert.ok(document.documentElement.hasAttribute('data-font'));
});

test('mono font removes data-font attribute entirely', () => {
  document.documentElement.dataset.font = 'system'; // set first
  applyFont('mono');
  assert.strictEqual(document.documentElement.hasAttribute('data-font'), false);
});
```

**Effort:** Small | **Risk:** None

## Technical Details
- File: `src/services/font-settings.ts`
- Test file to create: `tests/font-settings.test.mts`
- PR: koala73/worldmonitor#2318

## Acceptance Criteria
- [ ] Test covers: `applyFont('system')` sets `data-font="system"`
- [ ] Test covers: `applyFont('mono')` results in attribute fully absent (not empty string)
- [ ] Tests pass in CI

## Work Log
- 2026-03-27: Identified during PR #2318 review via kieran-typescript-reviewer
