---
status: pending
priority: p2
issue_id: "159"
tags: [code-review, performance, supply-chain, globe]
dependencies: []
---

# `flushPolygons` Iterates All 250 GeoJSON Features on Every Flush — Pre-compute Scenario Polygons

## Problem Statement
`GlobeMap.flushPolygons()` iterates over `countriesGeoJsonData.features` to build scenario `GlobePolygon` objects on every call. `flushPolygons()` is called whenever ANY polygon layer changes (CII update, conflict update, imagery toggle, storm cone render). With ~250 GeoJSON features, this is ~250 object allocations + ISO-2 Set lookups on every flush, even when the scenario state hasn't changed.

## Findings
- **File:** `src/components/GlobeMap.ts`
- `flushPolygons()` constructs scenario polygons inline from `this.scenarioState.affectedIso2s` + `countriesGeoJsonData` on every call
- Every other polygon layer (CII, conflict, imagery) pre-builds its polygon array before `flushPolygons()` and simply concatenates
- `setScenarioState()` calls `flushPolygons()` but does not cache the pre-built polygon array
- Identified by performance-oracle during PR #2910 review

## Proposed Solutions

### Option A: Pre-compute scenario polygons in `setScenarioState()` (Recommended)
```ts
private scenarioPolygons: GlobePolygon[] = [];

public setScenarioState(state: ScenarioVisualState | null): void {
  this.scenarioState = state;
  if (!state?.affectedIso2s?.length || !this.countriesGeoJsonData) {
    this.scenarioPolygons = [];
  } else {
    const affected = new Set(state.affectedIso2s);
    this.scenarioPolygons = this.countriesGeoJsonData.features
      .filter(f => affected.has(f.properties?.['ISO3166-1-Alpha-2'] as string))
      .map(f => ({ ...buildGlobePolygon(f), _kind: 'scenario' as const }));
  }
  this.flushPolygons();
}
```
Then in `flushPolygons()`:
```ts
const polys = [...this.ciiPolygons, ...this.conflictPolygons, ...this.scenarioPolygons, ...];
(this.globe as any).polygonsData(polys);
```
**Pros:** O(1) in `flushPolygons()` for scenario layer, consistent with existing pattern for other polygon types
**Cons:** Slightly larger memory footprint (cached array)
**Effort:** Small | **Risk:** Low

### Option B: Keep inline, add early-exit guard
```ts
if (!this.scenarioState?.affectedIso2s?.length) { /* skip scenario loop */ }
```
Reduces cost to near-zero when no scenario active, but still O(n) when active.
**Effort:** Trivial | **Risk:** None (acceptable trade-off)

## Recommended Action
_Apply Option A if the inline loop is confirmed to run frequently (profile first). Option B is an acceptable minimal fix if profiling shows low impact._

## Technical Details
- **Affected files:** `src/components/GlobeMap.ts`
- Add `private scenarioPolygons: GlobePolygon[] = []`
- Move construction into `setScenarioState()`

## Acceptance Criteria
- [ ] `flushPolygons()` does not iterate GeoJSON features when scenario state is unchanged
- [ ] `setScenarioState()` pre-builds `scenarioPolygons`
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by performance-oracle during PR #2910 review

## Resources
- PR: #2910
