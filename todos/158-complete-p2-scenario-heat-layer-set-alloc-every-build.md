---
status: complete
priority: p2
issue_id: "158"
tags: [code-review, performance, supply-chain, deckgl]
dependencies: []
---

# `createScenarioHeatLayer` Allocates New `Set` on Every `buildLayers()` Call

## Problem Statement
`DeckGLMap.createScenarioHeatLayer()` constructs `new Set(this.scenarioState.affectedIso2s)` inside the method body. `buildLayers()` is called on every frame/render cycle by DeckGL when layers need to be rebuilt. The `Set` allocation is O(n) on the number of affected ISO-2 codes and runs inside the hot DeckGL render path.

## Findings
- **File:** `src/components/DeckGLMap.ts`
- **Code:**
  ```ts
  private createScenarioHeatLayer(): GeoJsonLayer | null {
    if (!this.scenarioState?.affectedIso2s?.length || !this.countriesGeoJsonData) return null;
    const affected = new Set(this.scenarioState.affectedIso2s);  // ← allocated every call
    return new GeoJsonLayer({ ..., getFillColor: (feature) => { const code = ...; return affected.has(code) ? ... } });
  }
  ```
- `buildLayers()` is called whenever deck viewport or layers change — potentially dozens of times per second during pan/zoom
- The `Set` contents only change when `setScenarioState()` is called (rare)
- Identified by performance-oracle during PR #2910 review

## Proposed Solutions

### Option A: Cache the Set in `setScenarioState()` (Recommended)
```ts
private affectedIso2Set: Set<string> = new Set();

public setScenarioState(state: ScenarioVisualState | null): void {
  this.scenarioState = state;
  this.affectedIso2Set = new Set(state?.affectedIso2s ?? []);
  this.rebuildLayers();
}

private createScenarioHeatLayer(): GeoJsonLayer | null {
  if (!this.affectedIso2Set.size || !this.countriesGeoJsonData) return null;
  return new GeoJsonLayer({ ..., getFillColor: (feature) => {
    const code = feature.properties?.['ISO3166-1-Alpha-2'] as string | undefined;
    return (code && this.affectedIso2Set.has(code) ? [220, 60, 40, 80] : [0, 0, 0, 0]) as [number,number,number,number];
  }});
}
```
**Pros:** Set allocated once per state change (not per render), correct `updateTriggers` still invalidates DeckGL cache
**Cons:** Small memory overhead for the cached Set field
**Effort:** Small | **Risk:** Low

### Option B: Keep as-is with a comment
Acceptable if `buildLayers()` is only called on state change. But DeckGL calls it more often.
**Effort:** None | **Risk:** High (performance regression on active globe interactions)

## Recommended Action
_Apply Option A — cache the Set in `setScenarioState()`._

## Technical Details
- **Affected files:** `src/components/DeckGLMap.ts`
- Add private `affectedIso2Set: Set<string> = new Set()` field
- Move Set construction to `setScenarioState()`

## Acceptance Criteria
- [ ] `createScenarioHeatLayer` does not allocate a new `Set` on each call
- [ ] `setScenarioState()` rebuilds the cached Set
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by performance-oracle during PR #2910 review

## Resources
- PR: #2910
