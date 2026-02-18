---
phase: 2G-displacement-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/displacement/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements: [DOMAIN-07, SERVER-02]

must_haves:
  truths:
    - "Handler paginates through all UNHCR Population API pages (up to 10,000 records per page, max 25 pages guard)"
    - "Handler implements year fallback: tries current year, then current-1, then current-2 until data found"
    - "Handler aggregates raw records into per-country origin metrics (refugees, asylumSeekers, idps, stateless) and per-country asylum metrics (hostRefugees, hostAsylumSeekers)"
    - "Handler merges origin and asylum maps into unified CountryDisplacement records with totalDisplaced computed"
    - "Handler computes GlobalDisplacementTotals by summing across all raw records"
    - "Handler builds DisplacementFlow corridors from origin->asylum pairs, sorted by refugees descending, capped by flowLimit (default 50)"
    - "Handler attaches GeoCoordinates from 36+ hardcoded country centroids to countries and flows"
    - "Handler returns all int64 fields as strings (matching generated DisplacementServiceHandler interface)"
    - "Handler returns empty/graceful response on ANY fetch failure"
    - "POST /api/displacement/v1/get-displacement-summary is routable through the gateway"
    - "Sidecar bundle compiles with displacement routes included"
  artifacts:
    - path: "api/server/worldmonitor/displacement/v1/handler.ts"
      provides: "DisplacementServiceHandler implementation proxying UNHCR Population API"
      exports: ["displacementHandler"]
    - path: "api/[[...path]].ts"
      provides: "Gateway with displacement routes mounted alongside seismology, wildfire, climate, prediction"
      contains: "createDisplacementServiceRoutes"
  key_links:
    - from: "api/server/worldmonitor/displacement/v1/handler.ts"
      to: "src/generated/server/worldmonitor/displacement/v1/service_server.ts"
      via: "implements DisplacementServiceHandler interface"
      pattern: "DisplacementServiceHandler"
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/displacement/v1/handler.ts"
      via: "imports displacementHandler and mounts routes"
      pattern: "displacementHandler"
---

<objective>
Implement the DisplacementServiceHandler that proxies the UNHCR Population API with full pagination, per-country aggregation, global totals computation, displacement flow corridors, and country centroid mapping. Wire it into the catch-all gateway and rebuild the sidecar bundle.

Purpose: This is the heaviest data-processing handler in the migration series. Unlike prior handlers (seismology: simple JSON map, wildfire: CSV parse, climate: parallel zone fetches, prediction: thin proxy), this handler must paginate through potentially 250,000 raw records, aggregate them into per-country displacement metrics from two perspectives (origin and asylum), compute refugee flow corridors between country pairs, and attach geographic coordinates from hardcoded centroids. The logic is a direct port of `api/unhcr-population.js`.

Output: Working POST /api/displacement/v1/get-displacement-summary endpoint returning proto-typed displacement summary with global totals, per-country displacement data, and top refugee flow corridors.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2G-displacement-migration/2G-RESEARCH.md

# Reference: existing handler patterns
@api/server/worldmonitor/climate/v1/handler.ts
@api/server/worldmonitor/prediction/v1/handler.ts

# Generated server interface (handler must implement this)
@src/generated/server/worldmonitor/displacement/v1/service_server.ts

# Legacy endpoint being replaced (source of truth for UNHCR API logic)
@api/unhcr-population.js

# Gateway to wire into
@api/[[...path]].ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement displacement handler with UNHCR API pagination, aggregation, and flow computation</name>
  <files>
    api/server/worldmonitor/displacement/v1/handler.ts
  </files>
  <action>
**Step 1: Create `api/server/worldmonitor/displacement/v1/handler.ts`.**

Import types from the generated server file:
```typescript
import type {
  DisplacementServiceHandler,
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
  CountryDisplacement,
  DisplacementFlow,
  GeoCoordinates,
} from '../../../../../src/generated/server/worldmonitor/displacement/v1/service_server';
```

Export `displacementHandler` as a named const implementing `DisplacementServiceHandler`.

**Step 2: Define the COUNTRY_CENTROIDS map.**

Port the exact 40-entry map from `api/unhcr-population.js` (lines 35-46). The map is `Record<string, [number, number]>` where key is ISO3 code and value is `[lat, lon]`:

```typescript
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AFG: [33.9, 67.7], SYR: [35.0, 38.0], UKR: [48.4, 31.2], SDN: [15.5, 32.5],
  SSD: [6.9, 31.3], SOM: [5.2, 46.2], COD: [-4.0, 21.8], MMR: [19.8, 96.7],
  YEM: [15.6, 48.5], ETH: [9.1, 40.5], VEN: [6.4, -66.6], IRQ: [33.2, 43.7],
  COL: [4.6, -74.1], NGA: [9.1, 7.5], PSE: [31.9, 35.2], TUR: [39.9, 32.9],
  DEU: [51.2, 10.4], PAK: [30.4, 69.3], UGA: [1.4, 32.3], BGD: [23.7, 90.4],
  KEN: [0.0, 38.0], TCD: [15.5, 19.0], JOR: [31.0, 36.0], LBN: [33.9, 35.5],
  EGY: [26.8, 30.8], IRN: [32.4, 53.7], TZA: [-6.4, 34.9], RWA: [-1.9, 29.9],
  CMR: [7.4, 12.4], MLI: [17.6, -4.0], BFA: [12.3, -1.6], NER: [17.6, 8.1],
  CAF: [6.6, 20.9], MOZ: [-18.7, 35.5], USA: [37.1, -95.7], FRA: [46.2, 2.2],
  GBR: [55.4, -3.4], IND: [20.6, 79.0], CHN: [35.9, 104.2], RUS: [61.5, 105.3],
};
```

**Step 3: Implement `fetchUnhcrYearItems` helper.**

Port from legacy `api/unhcr-population.js` lines 48-76. This is the pagination core:

```typescript
async function fetchUnhcrYearItems(year: number): Promise<UnhcrRawItem[] | null> {
  const limit = 10000;
  const maxPageGuard = 25;
  const items: UnhcrRawItem[] = [];

  for (let page = 1; page <= maxPageGuard; page++) {
    const response = await fetch(
      `https://api.unhcr.org/population/v1/population/?year=${year}&limit=${limit}&page=${page}`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) return null;

    const data = await response.json();
    const pageItems: UnhcrRawItem[] = Array.isArray(data.items) ? data.items : [];
    if (pageItems.length === 0) break;
    items.push(...pageItems);

    const maxPages = Number(data.maxPages);
    if (Number.isFinite(maxPages) && maxPages > 0) {
      if (page >= maxPages) break;
      continue;
    }

    if (pageItems.length < limit) break;
  }

  return items;
}
```

Define the `UnhcrRawItem` interface locally:
```typescript
interface UnhcrRawItem {
  coo_iso?: string;
  coo_name?: string;
  coa_iso?: string;
  coa_name?: string;
  refugees?: number;
  asylum_seekers?: number;
  idps?: number;
  stateless?: number;
}
```

**Step 4: Implement `getCoordinates` helper.**

```typescript
function getCoordinates(code: string): GeoCoordinates | undefined {
  const centroid = COUNTRY_CENTROIDS[code];
  if (!centroid) return undefined;
  return { latitude: centroid[0], longitude: centroid[1] };
}
```

**Step 5: Implement `getDisplacementSummary` handler method.**

This is the core aggregation logic ported from `api/unhcr-population.js` lines 119-246. The handler must:

1. **Determine year with fallback**: Use `req.year` if > 0, otherwise try current year, then current-1, then current-2. Stop at first year with data (matching legacy lines 120-134):
```typescript
const currentYear = new Date().getFullYear();
const requestYear = req.year > 0 ? req.year : 0;
let rawItems: UnhcrRawItem[] = [];
let dataYearUsed = currentYear;

if (requestYear > 0) {
  const items = await fetchUnhcrYearItems(requestYear);
  if (items && items.length > 0) {
    rawItems = items;
    dataYearUsed = requestYear;
  }
} else {
  for (let year = currentYear; year >= currentYear - 2; year--) {
    const items = await fetchUnhcrYearItems(year);
    if (!items) continue;
    if (items.length > 0) {
      rawItems = items;
      dataYearUsed = year;
      break;
    }
  }
}
```

2. **Aggregate by origin and asylum** (matching legacy lines 136-179):
- Build `byOrigin: Record<string, { name, refugees, asylumSeekers, idps, stateless }>` summing origin metrics per `coo_iso`
- Build `byAsylum: Record<string, { name, refugees, asylumSeekers }>` summing asylum metrics per `coa_iso`
- Build `flowMap: Record<string, { originCode, originName, asylumCode, asylumName, refugees }>` for origin->asylum pairs with refugees > 0
- Accumulate `totalRefugees`, `totalAsylumSeekers`, `totalIdps`, `totalStateless` across all items

3. **Merge into unified countries** (matching legacy lines 181-214):
- Create countries from `byOrigin` with origin metrics and `totalDisplaced = refugees + asylumSeekers + idps + stateless`
- For each `byAsylum` entry: if country exists, add host metrics; if not, create new entry with zero origin metrics
- Attach `GeoCoordinates` from centroids via `getCoordinates(code)`

4. **Sort countries** by `max(totalDisplaced, hostTotal)` descending (matching legacy line 239-243)

5. **Apply countryLimit**: If `req.countryLimit > 0`, slice the sorted countries array

6. **Build flows** (matching legacy lines 216-227):
- Sort flowMap values by refugees descending
- Slice by `req.flowLimit` (default 50 if `req.flowLimit <= 0`)
- Attach origin and asylum `GeoCoordinates` from centroids

7. **Return proto-shaped response.** CRITICAL: All int64 fields must be `String()` since the generated types define them as `string`:
```typescript
return {
  summary: {
    year: dataYearUsed,
    globalTotals: {
      refugees: String(totalRefugees),
      asylumSeekers: String(totalAsylumSeekers),
      idps: String(totalIdps),
      stateless: String(totalStateless),
      total: String(totalRefugees + totalAsylumSeekers + totalIdps + totalStateless),
    },
    countries: protoCountries,
    topFlows: protoFlows,
  },
};
```

Each `CountryDisplacement` in `protoCountries`:
```typescript
{
  code, name,
  refugees: String(d.refugees),
  asylumSeekers: String(d.asylumSeekers),
  idps: String(d.idps),
  stateless: String(d.stateless),
  totalDisplaced: String(d.totalDisplaced),
  hostRefugees: String(d.hostRefugees),
  hostAsylumSeekers: String(d.hostAsylumSeekers),
  hostTotal: String(d.hostTotal),
  location: getCoordinates(code),
}
```

Each `DisplacementFlow` in `protoFlows`:
```typescript
{
  originCode, originName, asylumCode, asylumName,
  refugees: String(f.refugees),
  originLocation: getCoordinates(f.originCode),
  asylumLocation: getCoordinates(f.asylumCode),
}
```

**Step 6: Wrap in try/catch with graceful failure.**

Per established pattern (2F-01 decision), return empty/graceful on ANY failure:
```typescript
catch {
  return {
    summary: {
      year: req.year > 0 ? req.year : new Date().getFullYear(),
      globalTotals: {
        refugees: '0', asylumSeekers: '0', idps: '0', stateless: '0', total: '0',
      },
      countries: [],
      topFlows: [],
    },
  };
}
```

**Step 7: Verify the handler compiles.**

Run `npx tsc -p tsconfig.api.json --noEmit` and confirm zero errors. Read the generated server file first to verify exact type names for imports.
  </action>
  <verify>
Run `npx tsc -p tsconfig.api.json --noEmit` and confirm zero errors. Verify the handler file exists at `api/server/worldmonitor/displacement/v1/handler.ts` and exports `displacementHandler`.
  </verify>
  <done>
Handler file exists at `api/server/worldmonitor/displacement/v1/handler.ts`, exports `displacementHandler` implementing `DisplacementServiceHandler`. Contains 40-entry COUNTRY_CENTROIDS map, UNHCR API pagination (10,000/page, 25-page guard), year fallback (current to current-2), per-country origin+asylum aggregation, globalTotals computation, flow corridor building with centroid coordinates, countryLimit/flowLimit support, all int64 fields as String(), and graceful empty response on failure. Type-checks cleanly.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire displacement routes into gateway and rebuild sidecar</name>
  <files>
    api/[[...path]].ts
  </files>
  <action>
**Step 1: Mount displacement routes in the catch-all gateway.**

In `api/[[...path]].ts`:
1. Add import for the displacement route creator after the existing prediction imports (lines 19-20):
   ```typescript
   import { createDisplacementServiceRoutes } from '../src/generated/server/worldmonitor/displacement/v1/service_server';
   import { displacementHandler } from './server/worldmonitor/displacement/v1/handler';
   ```
2. Add displacement routes to `allRoutes` array (after the prediction line, line 30):
   ```typescript
   ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
   ```
3. The same `serverOptions` const with `onError: mapErrorToResponse` works for displacement since it is service-agnostic.

**Step 2: Rebuild the sidecar sebuf bundle.**

Run `npm run build:sidecar-sebuf` to rebuild the Tauri sidecar bundle with the new displacement routes included. This must succeed without errors.

**Step 3: Type check the full project.**

Run `npx tsc -p tsconfig.api.json --noEmit` to verify no type errors were introduced in the api/ layer.
  </action>
  <verify>
Run `npx tsc -p tsconfig.api.json --noEmit` -- zero errors. Run `npm run build:sidecar-sebuf` -- succeeds. Grep `api/[[...path]].ts` for `createDisplacementServiceRoutes` to confirm it is wired in.
  </verify>
  <done>
Gateway mounts displacement routes alongside seismology, wildfire, climate, and prediction. Sidecar bundle compiles with displacement included. Full API type check passes.
  </done>
</task>

</tasks>

<verification>
1. `npx tsc -p tsconfig.api.json --noEmit` passes with zero errors
2. `npm run build:sidecar-sebuf` succeeds
3. `api/server/worldmonitor/displacement/v1/handler.ts` exists and exports `displacementHandler`
4. `api/[[...path]].ts` includes `createDisplacementServiceRoutes`
5. Handler contains 40-entry COUNTRY_CENTROIDS map matching legacy exactly
6. Handler paginates UNHCR API with 10,000 limit and 25-page guard
7. Handler has year fallback loop (currentYear to currentYear-2)
8. Handler aggregates by origin and asylum, merges into unified country records
9. Handler returns all int64 fields as `String()` (not number)
10. Handler returns graceful empty response on failure
</verification>

<success_criteria>
POST /api/displacement/v1/get-displacement-summary is a routable endpoint that paginates through all UNHCR Population API data, aggregates into per-country displacement metrics (origin + asylum perspectives), computes global totals, builds top refugee flow corridors with geographic coordinates, and returns a proto-typed DisplacementSummary. Year fallback ensures data availability. Country centroids provide geographic coordinates for map rendering. Graceful degradation returns empty summary on any upstream failure.
</success_criteria>

<output>
After completion, create `.planning/phases/2G-displacement-migration/2G-01-SUMMARY.md`
</output>
