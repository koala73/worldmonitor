---
status: complete
priority: p1
issue_id: 170
tags: [code-review, phase-0, regional-intelligence, type-safety, build]
dependencies: []
---

# JSDoc @type annotations in scripts/regional-snapshot/*.mjs are decorative - tsc --checkJs not configured

## Problem Statement
All 13 modules under `scripts/regional-snapshot/*.mjs` use JSDoc annotations like `@type {import('../../shared/regions.types.js').BalanceVector}`. But:
1. `shared/regions.types.js` does not exist: only `shared/regions.types.d.ts`
2. `scripts/jsconfig.json` include array does NOT contain `seed-regional-snapshots.mjs` or `scripts/regional-snapshot/*.mjs`
3. Therefore `tsc --checkJs` never validates these annotations
4. The types are pure decoration that mislead reviewers into thinking the code is type-safe

This directly violates the user-mandated rule from `/Users/eliehabib/.claude/projects/-Users-eliehabib-Documents-GitHub-worldmonitor/memory/feedback_type_safety_always.md`: "ALWAYS write type-safe code: JSDoc+@ts-check for .mjs, .types.d.ts for data structures, strict TS for .ts files. Non-negotiable."

## Findings
- `scripts/jsconfig.json` includes only specific files; grep for "regional-snapshot" or "seed-regional-snapshots" in `jsconfig.json` returns nothing.
- `shared/regions.types.js` does not exist (only the `.d.ts`).
- No `// @ts-check` directive at the top of the regional-snapshot modules.
- Net effect: reviewers see JSDoc `@type` annotations and assume the code is checked, but tsc never visits these files, so any type drift goes unreported.

## Proposed Solutions

### Option 1: Wire into existing jsconfig
Add `scripts/seed-regional-snapshots.mjs` and `scripts/regional-snapshot/*.mjs` to `scripts/jsconfig.json`'s include array. Drop the `.js` extension from JSDoc imports (`import('../../shared/regions.types')` resolves to the `.d.ts`). Add `// @ts-check` directive at the top of each `.mjs`.

**Pros:** Honors the "type safety always" rule with minimum file churn. Surfaces real type errors.
**Cons:** Will surface real type errors that need fixing before merge.
**Effort:** Small
**Risk:** Low (risk is surfaced errors, not runtime regressions)

### Option 2: Convert to TypeScript
Convert the `.mjs` files to `.ts` and put them under `scripts/jsconfig.json` or a new tsconfig.

**Pros:** Strongest type safety.
**Cons:** Much larger change; touches the Railway seed runtime, requires compile or tsx loader, out of Phase 0 scope.
**Effort:** Large
**Risk:** Medium (runtime/loader changes)

## Recommended Action
(leave blank for triage)

## Technical Details
- Affected files:
  - `scripts/jsconfig.json` (add includes)
  - `scripts/seed-regional-snapshots.mjs`
  - `scripts/regional-snapshot/*.mjs` (13 modules, add `// @ts-check`, fix import paths)
- Components: build-time type checking, regional snapshot seed modules, CI pre-push hook
- Related rule: `/Users/eliehabib/.claude/projects/-Users-eliehabib-Documents-GitHub-worldmonitor/memory/feedback_type_safety_always.md`

## Acceptance Criteria
- [ ] `npx tsc --noEmit -p scripts/jsconfig.json` runs and validates regional-snapshot modules
- [ ] All `@type` annotations resolve correctly
- [ ] Each `.mjs` has `// @ts-check` at the top
- [ ] Type errors surfaced by Option 1 are fixed before merge

## Work Log
(empty)

## Resources
- PR #2940
- Spec: docs/internal/pro-regional-intelligence-upgrade.md
- Rule: `feedback_type_safety_always.md`
