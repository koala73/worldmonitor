---
status: complete
priority: p1
issue_id: "155"
tags: [code-review, architecture, supply-chain, correctness]
dependencies: []
---

# Scenario Callbacks Never Wired in `panel-layout.ts` — Feature Dead on Arrival

## Problem Statement
`SupplyChainPanel.setOnScenarioActivate()` and `setOnDismissScenario()` are declared and implemented but never called anywhere. When the user clicks "Simulate Closure" and the poll completes, `this.onScenarioActivate?.(...)` fires — but the callback is null, so no map overlays are applied. The dismiss button also does nothing. The entire scenario visual engine is non-functional in production.

## Findings
- **File:** `src/app/panel-layout.ts` — missing wiring
- `setOnScenarioActivate` and `setOnDismissScenario` public methods exist on `SupplyChainPanel` but are never called
- `MapContainer.setSupplyChainPanel()` also exists but is never called
- The feature compiles and type-checks but is a silent no-op at runtime
- Confirmed by architecture reviewer: "wiring is declared but not connected"

## Proposed Solutions

### Option A: Wire callbacks in `panel-layout.ts` (Recommended)
In `src/app/panel-layout.ts`, after `SupplyChainPanel` is created:
```ts
supplyChainPanel.setOnScenarioActivate((id, result) => {
  this.ctx.map?.activateScenario(id, result);
});
supplyChainPanel.setOnDismissScenario(() => {
  this.ctx.map?.deactivateScenario();
});
```
This follows the existing pattern for all other panel callbacks (e.g. `MonitorPanel.onChanged`).
**Pros:** Correct architecture, no circular reference, follows established pattern
**Cons:** Requires checking how `this.ctx.map` is typed/available in panel-layout.ts
**Effort:** Small | **Risk:** Low

### Option B: Keep `setSupplyChainPanel` on MapContainer, call it from panel-layout.ts
Also call `mapContainer.setSupplyChainPanel(supplyChainPanel)` in panel-layout.ts. Keeps the current back-reference architecture but at least makes it functional.
**Pros:** Minimal change to the current design
**Cons:** Preserves the bidirectional coupling (see todo #161)
**Effort:** Small | **Risk:** Low

## Recommended Action
_Apply Option A — wire callbacks in `panel-layout.ts`. This is the minimum fix to make the feature functional and also the architecturally correct approach (see #161 for the full coupling cleanup)._

## Technical Details
- **Affected files:** `src/app/panel-layout.ts` (wiring), `src/components/SupplyChainPanel.ts` (callbacks declared)
- **Lines in panel-layout.ts:** find where `SupplyChainPanel` is constructed (grep: `new SupplyChainPanel`)

## Acceptance Criteria
- [ ] `setOnScenarioActivate` wired in `panel-layout.ts` → calls `mapContainer.activateScenario`
- [ ] `setOnDismissScenario` wired in `panel-layout.ts` → calls `mapContainer.deactivateScenario`
- [ ] Clicking "Simulate Closure" (PRO, done scenario) applies arc recolor + heat layer on DeckGL
- [ ] Dismiss × on banner restores normal visual state

## Work Log
- 2026-04-10: Identified by architecture-strategist during PR #2910 review

## Resources
- PR: #2910
