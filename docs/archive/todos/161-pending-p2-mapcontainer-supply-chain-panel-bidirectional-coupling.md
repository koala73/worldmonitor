---
status: pending
priority: p2
issue_id: "161"
tags: [code-review, architecture, supply-chain, coupling]
dependencies: [155]
---

# MapContainer ↔ SupplyChainPanel Bidirectional Coupling via `setSupplyChainPanel`

## Problem Statement
`MapContainer` has a `setSupplyChainPanel(panel)` setter that stores a direct reference to `SupplyChainPanel`. This creates a bidirectional dependency: `SupplyChainPanel` calls into `MapContainer` via callbacks (correct direction), and `MapContainer` calls back into `SupplyChainPanel` via `showScenarioSummary` / `hideScenarioSummary` (reverse direction). This circular architecture makes both components harder to test and violates the unidirectional data flow established by every other panel in the system.

## Findings
- **File:** `src/components/MapContainer.ts` — `setSupplyChainPanel()` and `deactivateScenario()` calling `this.supplyChainPanel?.hideScenarioSummary()`
- **File:** `src/components/SupplyChainPanel.ts` — `setOnDismissScenario` / `setOnScenarioActivate` callbacks point to `MapContainer`
- All other panels (MonitorPanel, CountryDeepDivePanel, etc.) use one-way callbacks: panel → map, never map → panel
- The bidirectional link was noted in the Sprint E plan as deferred to this issue
- Identified by architecture-strategist during PR #2910 review (see todo #155 for the more urgent wiring issue)

## Proposed Solutions

### Option A: Remove `showScenarioSummary`/`hideScenarioSummary` from `MapContainer` dispatch (Recommended)
Instead of `MapContainer` calling `panel.showScenarioSummary()` and `panel.hideScenarioSummary()`:
- Have `SupplyChainPanel` observe scenario state changes through its existing `onScenarioActivate` and `onDismissScenario` callbacks
- The panel already receives `(id, result)` in `onScenarioActivate` — it can call `showScenarioSummary` on itself
- `MapContainer.activateScenario` fires `onScenarioActivate` → panel handles its own UI update
- `MapContainer.deactivateScenario` fires `onDismissScenario` → panel handles its own dismiss
- Remove `setSupplyChainPanel` from `MapContainer` entirely

**Pros:** Breaks the circular reference, consistent with all other panels
**Cons:** Requires refactoring how the panel receives activation events (it already does via callbacks)
**Effort:** Medium | **Risk:** Low

### Option B: Keep `setSupplyChainPanel` but document the coupling explicitly
Add a JSDoc comment acknowledging the bidirectional dependency and track via this todo.
**Pros:** No refactor needed now
**Cons:** Coupling persists indefinitely, harder to unit-test
**Effort:** Trivial | **Risk:** None (deferred tech debt)

## Recommended Action
_Apply Option A in a follow-up PR after P1 issues (#155) are fixed. The coupling is architectural debt but not a blocking bug._

## Technical Details
- **Affected files:** `src/components/MapContainer.ts`, `src/components/SupplyChainPanel.ts`
- Dependency: Fix todo #155 first (wiring), then restructure the callback flow here

## Acceptance Criteria
- [ ] `MapContainer` has no direct reference to `SupplyChainPanel`
- [ ] `setSupplyChainPanel()` removed from `MapContainer`
- [ ] Panel banner updates triggered via existing `onScenarioActivate` / `onDismissScenario` callbacks
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by architecture-strategist during PR #2910 review

## Resources
- PR: #2910
- Related: todo #155 (callbacks not wired — fix first)
