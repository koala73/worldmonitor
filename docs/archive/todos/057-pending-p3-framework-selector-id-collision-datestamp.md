---
status: pending
priority: p3
issue_id: "057"
tags: [code-review, quality, analytical-frameworks]
dependencies: []
---

# `Date.now()` IDs for imported frameworks can collide — use `crypto.randomUUID()` instead

## Problem Statement
`preferences-content.ts` uses `Date.now()` as the `id` for newly imported frameworks. If a user imports two frameworks within the same millisecond (e.g., via automated paste), both get the same ID, causing a silent duplicate that `saveImportedFramework` may not catch (its duplicate check is on `name`, not `id`). `crypto.randomUUID()` is available in all modern browsers and provides guaranteed uniqueness.

## Findings
- **`src/services/preferences-content.ts`** — import handler: `id: Date.now().toString()` (approximate location)
- `saveImportedFramework` in `analysis-framework-store.ts` checks for duplicate names but not duplicate IDs
- Flagged by: kieran-typescript-reviewer

## Proposed Solutions

### Option A: Use `crypto.randomUUID()` (Recommended)
```ts
id: crypto.randomUUID()
```
Available globally in all browser targets and Vercel Edge runtime.
**Effort:** Trivial | **Risk:** Low

## Technical Details
- File: `src/services/preferences-content.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] Framework `id` uses `crypto.randomUUID()` instead of `Date.now()`
- [ ] Two simultaneous imports produce distinct IDs

## Work Log
- 2026-03-27: Identified during PR #2380 review by kieran-typescript-reviewer
