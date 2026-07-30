---
status: pending
priority: p3
issue_id: "073"
tags: [code-review, quality, typescript, analytical-frameworks]
dependencies: []
---

# `_fwData` stored as non-standard property on DOM element in `preferences-content.ts`

## Problem Statement
`src/services/preferences-content.ts` lines ~490-494 stash framework preview data on an HTMLElement using a non-standard property and a TypeScript cast:
```ts
(preview as HTMLElement & { _fwData?: { name: string; description: string; instructions: string } } | null)?._fwData = { ... }
```
Then reads it back on save. This is a legacy JS pattern that bypasses TypeScript's type system and dirties the DOM node.

## Proposed Solution
Use a closure variable instead:
```ts
let pendingFwData: { name: string; description: string; instructions: string } | null = null;
// assign in fetch .then()
pendingFwData = { name: data.name ?? 'Unnamed skill', description: ..., instructions: data.instructions };
// read in save button handler
if (!pendingFwData) return;
```

## Technical Details
- File: `src/services/preferences-content.ts:~490-494`
- Effort: Small | Risk: Low

## Work Log
- 2026-03-28: Identified by code-simplicity-reviewer during PR #2386 review
