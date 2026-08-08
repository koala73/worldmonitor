# Plan: Map Performance Improvements (Revised v2)

## Context

worldmonitor.app renders a real-time geopolitical map using three engines:

- **DeckGLMap** (WebGL, deck.gl over MapLibre) — primary desktop map
- **GlobeMap** (globe.gl / Three.js) — 3D globe mode
- **Map.ts** (Leaflet + D3 SVG) — mobile fallback

Default web layout enables 12 map layers. Performance profiling (built-in console.warn at >16ms) revealed `buildLayers()` is a hot path.

## Diagnosis

Three real bottlenecks identified:

1. **Supercluster indexes built unconditionally at startup** — `rebuildTechHQSupercluster()` and `rebuildDatacenterSupercluster()` run on map `'load'` and basemap switch for ALL users, even when `SITE_VARIANT !== 'tech'` and datacenters are off.

2. **`filterByTime()` re-runs 10× on every `buildLayers()` call** — called on every data update, zoom change, and layer toggle. `filterByTime()` uses `Date.now()` as its cutoff, so results expire over time — but rebuilding them on every render is wasteful when data hasn't changed within the current minute.

3. **`initStaticLayers()` in GlobeMap processes all 9 static datasets unconditionally** — MILITARY_BASES, NUCLEAR_FACILITIES, GAMMA_IRRADIATORS, SPACEPORTS, ECONOMIC markers, AI_DATA_CENTERS, WATERWAYS, MINERALS, UNDERSEA_CABLES/PIPELINES all processed at startup for every variant.

### Ruled out (no issue):

- `rafSchedule` is NOT a continuous loop — fires only when called, already correct
- `flushMarkersImmediate()` already gates by `this.layers.xxx` — no redundant pushes
- GlobeMap debounce (100ms + 300ms max) already coalesces rapid updates

---

## Change 1: Lazy Supercluster Initialization

**File**: `src/components/DeckGLMap.ts`

**Remove** the unconditional eager builds at `'load'` and basemap-switch:
```typescript
// REMOVE these two lines from 'load' handler (and basemap-switch handler):
this.rebuildTechHQSupercluster();
this.rebuildDatacenterSupercluster();
```

**Add** lazy-init inside `updateClusterData()`, before the existing cluster usage. `updateClusterData()` already computes the exact conditions needed:

```typescript
// In updateClusterData(), after computing useTechHQ / useDatacenterClusters:
const useTechHQ = SITE_VARIANT === 'tech' && layers.techHQs;
const useDatacenterClusters = layers.datacenters && zoom < 5;

if (useTechHQ && !this.techHQSC) this.rebuildTechHQSupercluster();
if (useDatacenterClusters && !this.datacenterSC) this.rebuildDatacenterSupercluster();
```

First time these layers are active at the right zoom, the cluster is built once and cached.

**Risk**: Very low. `updateClusterData()` already has early-return guards and is called at every render. The lazy-init path is a one-time cost, identical to the current eager cost — just deferred.

---

## Change 2: Memoized `filterByTime` Helper

**File**: `src/components/DeckGLMap.ts`

Add a single memoized wrapper using `WeakMap` (avoids strong-ref memory leak on old array replacements):

```typescript
private _timeFilterCache = new WeakMap<object, { min: number; range: TimeRange; result: unknown[] }>();

private filterByTimeCached<T>(items: T[], key: (t: T) => Date | string | number): T[] {
  const min = Math.floor(Date.now() / 60000); // 1-minute bucket
  const range = this.state.timeRange;
  const cached = this._timeFilterCache.get(items as object);
  if (cached && cached.min === min && cached.range === range) return cached.result as T[];
  const result = this.filterByTime(items, key);
  this._timeFilterCache.set(items as object, { min, range, result });
  return result;
}
```

Cache invalidation:

- **New data**: `set*()` methods assign a new array reference → WeakMap miss, old entry GC'd
- **Time range change**: `range` differs → cache miss
- **Clock advance**: `min` bucket (per-minute) expires naturally → recompute picks up newly-expired events

In `buildLayers()`, replace all 10 inline calls (change `filterByTime` → `filterByTimeCached`). No setter or state changes needed.

**Risk**: Low. WeakMap eliminates memory leak. 1-minute bucket means at most 60s of stale filtering — acceptable given AIS data refreshes every 20s and triggers a new array ref.

---

## Change 3: Guard `initStaticLayers()` in GlobeMap

**File**: `src/components/GlobeMap.ts`

Wrap all 9 datasets in `initStaticLayers()` with their layer-state guards. Add `ensureStaticDataForLayer(layer)` called from both `setLayers()` (newly-enabled keys) and `enableLayer()` (programmatic enables — URL restore, search, panel actions):

```typescript
private ensureStaticDataForLayer(layer: keyof MapLayers): void {
  switch (layer) {
    case 'bases':       if (!this.milBaseMarkers.length) this.milBaseMarkers = MILITARY_BASES.map(...); break;
    case 'nuclear':     if (!this.nuclearSiteMarkers.length) this.nuclearSiteMarkers = NUCLEAR_FACILITIES.filter(...).map(...); break;
    case 'irradiators': if (!this.irradiatorSiteMarkers.length) this.irradiatorSiteMarkers = GAMMA_IRRADIATORS.map(...); break;
    case 'spaceports':  if (!this.spaceportSiteMarkers.length) this.spaceportSiteMarkers = SPACEPORTS.filter(...).map(...); break;
    case 'economic':    if (!this.economicMarkers.length) this.economicMarkers = ECONOMIC_CENTERS.map(...); break;
    case 'datacenters': if (!this.datacenterMarkers.length) this.datacenterMarkers = AI_DATA_CENTERS.filter(...).map(...); break;
    case 'waterways':   if (!this.waterwayMarkers.length) this.waterwayMarkers = STRATEGIC_WATERWAYS.map(...); break;
    case 'minerals':    if (!this.mineralMarkers.length) this.mineralMarkers = CRITICAL_MINERALS.filter(...).map(...); break;
    case 'tradeRoutes': if (!this.tradeRouteSegments.length) this.tradeRouteSegments = resolveTradeRouteSegments(); break;
    case 'cables':
    case 'pipelines':   if (!this.globePaths.length) this.globePaths = [...CABLES.map(...), ...PIPELINES.map(...)]; break;
  }
}
```

Hook into `setLayers()`:
```typescript
for (const k of Object.keys(layers) as (keyof MapLayers)[]) {
  if (!prev[k] && layers[k]) this.ensureStaticDataForLayer(k); // newly enabled
  // existing channel flush logic continues...
}
```

Hook into `enableLayer()`:
```typescript
public enableLayer(layer: keyof MapLayers): void {
  if (layer === 'dayNight') return;
  if (this.layers[layer]) return;
  (this.layers as any)[layer] = true;
  this.ensureStaticDataForLayer(layer); // lazy init for programmatic enables
  this.flushLayerChannels(layer);
  this.enforceLayerLimit();
}
```

**Risk**: Low. Static datasets never change at runtime. For variants where layers are on by default, `initStaticLayers()` runs at startup as before.

---

## Files Changed

| File | Change |
|---|---|
| `src/components/DeckGLMap.ts` | Changes 1 + 2 (~30 lines net) |
| `src/components/GlobeMap.ts` | Change 3 (~80 lines net) |

## Expected Improvements

- **Startup**: Superclusters not built until first needed; GlobeMap static data skipped for non-default layers (~40-200ms per variant)
- **Per-render**: `buildLayers()` hits WeakMap cache instead of re-filtering; at most 1 recompute per minute per active layer
