---
status: pending
priority: p2
issue_id: "064"
tags: [code-review, typescript, correctness, analytical-frameworks]
dependencies: []
---

# `_activeCache.get(panelId)!` non-null assertion on a nullable Map value

## Problem Statement
`src/services/analysis-framework-store.ts` line 148:
```ts
if (_activeCache.has(panelId)) return _activeCache.get(panelId)!;
```
The Map stores `AnalysisFramework | null` (explicitly set to `null` to represent "no active framework"). The `!` non-null assertion coerces `null` to `AnalysisFramework` at the type level, misleading the TypeScript compiler. At runtime it works because callers handle `null`, but the type assertion is incorrect.

## Proposed Solution
```ts
if (_activeCache.has(panelId)) return _activeCache.get(panelId) ?? null;
```

## Technical Details
- File: `src/services/analysis-framework-store.ts:148`
- Effort: Trivial | Risk: Low

## Acceptance Criteria
- [ ] Non-null assertion removed; `?? null` used instead
- [ ] Return type of `getActiveFrameworkForPanel` remains `AnalysisFramework | null`

## Work Log
- 2026-03-28: Identified by kieran-typescript-reviewer and architecture-strategist during PR #2386 review
