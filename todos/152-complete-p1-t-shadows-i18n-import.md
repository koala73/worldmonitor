---
status: complete
priority: p1
issue_id: "152"
tags: [code-review, quality, supply-chain]
dependencies: []
---

# `t` Parameter Shadows i18n `t` Import in `renderChokepoints`

## Problem Statement
In `SupplyChainPanel.ts:324`, the arrow function parameter `t` inside `SCENARIO_TEMPLATES.find(t => ...)` shadows the module-level `import { t } from '@/services/i18n'` at line 12. Inside the callback, `t` refers to the template object, not the i18n function. Any translated string added inside this callback (or nearby refactor) will silently use the template object as a function, throwing at runtime.

## Findings
- **File:** `src/components/SupplyChainPanel.ts:324`
- **Code:** `const template = SCENARIO_TEMPLATES.find(t => t.affectedChokepointIds.includes(cp.id) && t.type !== 'tariff_shock');`
- Not a crash today — `t(...)` is not called inside the callback — but it is a maintenance trap
- Biome may not catch this as an error (depends on shadow rules configured)

## Proposed Solutions

### Option A: Rename the arrow function parameter (Recommended)
```ts
const template = SCENARIO_TEMPLATES.find(tmpl =>
  tmpl.affectedChokepointIds.includes(cp.id) && tmpl.type !== 'tariff_shock'
);
```
**Pros:** One-line fix, obvious, eliminates shadow entirely
**Cons:** None
**Effort:** Small | **Risk:** None

## Recommended Action
_Apply Option A immediately — 1-line fix._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts`
- **Line:** 324

## Acceptance Criteria
- [ ] Arrow function parameter renamed from `t` to `tmpl` (or similar)
- [ ] `npm run lint` passes with no shadow warnings
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by kieran-typescript-reviewer during PR #2910 review

## Resources
- PR: #2910
