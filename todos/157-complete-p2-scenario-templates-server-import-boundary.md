---
status: complete
priority: p2
issue_id: "157"
tags: [code-review, architecture, supply-chain, import-boundaries]
dependencies: []
---

# `SCENARIO_TEMPLATES` Imported Directly from `../../server/` — Module Boundary Violation

## Problem Statement
`SupplyChainPanel.ts` imports `SCENARIO_TEMPLATES` via a relative path crossing into `server/`:
```ts
import { SCENARIO_TEMPLATES } from '../../server/worldmonitor/supply-chain/v1/scenario-templates';
```
Client components must not import from `server/` directly — the `src/` → `server/` boundary keeps server-only deps (gRPC stubs, proto codegen) out of the browser bundle. This import will silently work today but will break if any server-only module is added upstream of `scenario-templates.ts`.

## Findings
- **File:** `src/components/SupplyChainPanel.ts`
- Direct relative import crosses `src/` → `server/` module boundary
- `src/config/scenario-templates.ts` already re-exports the `ScenarioResult` and `ScenarioVisualState` types from this file
- The `SCENARIO_TEMPLATES` const is not yet re-exported from `src/config/scenario-templates.ts`
- Pattern in codebase: all other panel files import from `@/config/`, `@/services/`, or `@/components/`
- Identified by architecture-strategist during PR #2910 review

## Proposed Solutions

### Option A: Re-export `SCENARIO_TEMPLATES` via `src/config/scenario-templates.ts` (Recommended)
In `src/config/scenario-templates.ts`, add:
```ts
export { SCENARIO_TEMPLATES } from '../../server/worldmonitor/supply-chain/v1/scenario-templates';
```
Then update `SupplyChainPanel.ts`:
```ts
import { SCENARIO_TEMPLATES } from '@/config/scenario-templates';
```
**Pros:** One canonical boundary crossing point, consistent with existing type re-exports, no runtime impact
**Cons:** Needs one extra line in config file
**Effort:** Small | **Risk:** None

### Option B: Add a `src/` copy or adapter
Duplicate the const in `src/config/`. More files, divergence risk.
**Effort:** Medium | **Risk:** Medium (divergence)

## Recommended Action
_Apply Option A — add one re-export to `src/config/scenario-templates.ts` and update the import in `SupplyChainPanel.ts`._

## Technical Details
- **Affected files:** `src/config/scenario-templates.ts` (add re-export), `src/components/SupplyChainPanel.ts` (update import)

## Acceptance Criteria
- [ ] `src/components/SupplyChainPanel.ts` no longer imports from `../../server/`
- [ ] `SCENARIO_TEMPLATES` accessible via `@/config/scenario-templates`
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by architecture-strategist during PR #2910 review

## Resources
- PR: #2910
