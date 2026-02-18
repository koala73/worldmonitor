# Phase 2G: Displacement Migration - Research

**Researched:** 2026-02-19
**Domain:** UNHCR Population API, DisplacementService handler, multi-entity aggregation, frontend consumer adaptation
**Confidence:** HIGH

## Summary

Phase 2G migrates the displacement/UNHCR domain to sebuf. This is the fifth domain migration following seismology (2C), wildfires (2D), climate (2E), and prediction (2F), and benefits from thoroughly established patterns. This domain has **specific complexity** that distinguishes it from prior migrations:

1. **The handler is the most data-intensive**: The UNHCR Population API returns paginated raw records (up to 10,000 per page, across up to 25 pages) that must be aggregated into per-country displacement totals, host-country intake metrics, and top refugee flow corridors. The legacy `api/unhcr-population.js` does all this aggregation server-side. This is the heaviest data processing of any handler so far.

2. **Multi-entity response**: Unlike prior domains that return flat arrays, this handler produces a composite response with `globalTotals`, `countries[]`, and `topFlows[]` -- three distinct data structures derived from the same raw dataset.

3. **Hardcoded country centroids**: The legacy endpoint embeds a `COUNTRY_CENTROIDS` map (36 countries with lat/lon pairs) that must be migrated to the handler. The proto `CountryDisplacement` and `DisplacementFlow` messages include `GeoCoordinates` location fields that must be populated from these centroids.

4. **Significant shape differences**: The proto types use `GeoCoordinates { latitude, longitude }` objects while legacy uses flat `lat`/`lon` or `originLat`/`originLon`/`asylumLat`/`asylumLon` fields. The proto `int64` fields for population counts are encoded as `string` in generated TypeScript while legacy consumers expect `number`. The service module adapter must bridge both differences.

**Primary recommendation:** Follow the established 2-plan pattern (Plan 01: handler + gateway, Plan 02: service module + consumer rewiring + legacy deletion). The handler is COMPLEX but self-contained (aggregates raw UNHCR API data into proto shape). The service module is a STANDARD port/adapter (calls generated client, maps proto shape to legacy shape), similar to the climate pattern from Phase 2E. The main challenge is the shape mapping between proto `GeoCoordinates`/`string` int64 and legacy flat `lat`/`lon`/`number`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-07 | Geopolitical domain proto (UNHCR refugees) with service RPCs and HTTP annotations | Proto already defined at `proto/worldmonitor/displacement/v1/` with `DisplacementSummary`, `CountryDisplacement`, `DisplacementFlow`, `GlobalDisplacementTotals` messages, `GetDisplacementSummary` RPC, HTTP annotation at `/api/displacement/v1/get-displacement-summary`. No proto changes needed. |
| SERVER-02 | Handler implementation that proxies upstream external API and returns proto-typed responses | Handler must proxy UNHCR Population API (`https://api.unhcr.org/population/v1/population/`), paginate through all results, aggregate per-country stats (origin + asylum), compute global totals, build top displacement flows, attach country centroids as GeoCoordinates, and return proto-shaped `GetDisplacementSummaryResponse`. |
</phase_requirements>

## Current State

### Proto: `DisplacementService`
Single RPC `GetDisplacementSummary`:
- Request: `year` (int32), `country_limit` (int32), `flow_limit` (int32)
- Response: `summary: DisplacementSummary`
- `DisplacementSummary`: `year`, `global_totals: GlobalDisplacementTotals`, `countries: CountryDisplacement[]`, `top_flows: DisplacementFlow[]`
- `GlobalDisplacementTotals`: `refugees`, `asylum_seekers`, `idps`, `stateless`, `total` (all int64)
- `CountryDisplacement`: `code`, `name`, 6 origin metrics (int64), 3 host metrics (int64), `location: GeoCoordinates`
- `DisplacementFlow`: `origin_code`, `origin_name`, `asylum_code`, `asylum_name`, `refugees` (int64), `origin_location: GeoCoordinates`, `asylum_location: GeoCoordinates`
- Route: `POST /api/displacement/v1/get-displacement-summary`

**No proto enhancement needed.** The proto model already covers all legacy fields.

### Generated Code (already exists)
- Server: `src/generated/server/worldmonitor/displacement/v1/service_server.ts`
  - `DisplacementServiceHandler` interface with `getDisplacementSummary(ctx, req): Promise<GetDisplacementSummaryResponse>`
  - `createDisplacementServiceRoutes(handler, options)` for gateway mounting
  - **Note:** int64 fields are typed as `string` in generated code (e.g., `refugees: string`, `total: string`)
- Client: `src/generated/client/worldmonitor/displacement/v1/service_client.ts`
  - `DisplacementServiceClient` class with `getDisplacementSummary(req): Promise<GetDisplacementSummaryResponse>`
  - Same `string` typing for int64 fields

### Legacy Endpoint: `api/unhcr-population.js`
Vercel Edge function with:
- **UNHCR Population API proxy**: `https://api.unhcr.org/population/v1/population/`
- **Pagination**: Up to 10,000 records per page, up to 25 pages max guard
- **Year fallback**: Tries current year, falls back to current-1, then current-2
- **Data aggregation**: Builds `byOrigin` map (refugees, asylumSeekers, idps, stateless) and `byAsylum` map (hostRefugees, hostAsylumSeekers), merges into unified `countries` array
- **Flow computation**: Builds flow map keyed by `originCode->asylumCode`, picks top 50 by refugee count
- **Country centroids**: Hardcoded `COUNTRY_CENTROIDS` map (36 countries with [lat, lon] pairs) for mapping coordinates
- **Caching**: Redis (`CACHE_KEY = 'unhcr:population:v2'`, 24h TTL), in-memory fallback, stale-on-error
- **CORS**: Uses shared `_cors.js` helper
- **Rate limiting**: IP-based, 20 requests/minute

### Legacy Frontend Service: `src/services/unhcr.ts`
Exports:
- `fetchUnhcrPopulation()` -> `UnhcrFetchResult { ok, data: UnhcrSummary, cachedAt? }` (main data fetch with circuit breaker)
- `getDisplacementColor(totalDisplaced)` -> `[r,g,b,a]` (map layer coloring)
- `getDisplacementBadge(totalDisplaced)` -> `{ label, color }` (panel severity badges)
- `formatPopulation(n)` -> `string` (e.g., "1.2M", "500K")
- `getOriginCountries(data)` -> `CountryDisplacement[]` (sorted, filtered)
- `getHostCountries(data)` -> `CountryDisplacement[]` (sorted, filtered)

**Internal complexity:** LOW -- thin wrapper around `fetch('/api/unhcr-population')` with circuit breaker. All aggregation logic lives in the legacy endpoint, not the service module.

### Legacy Types: `src/types/index.ts`
```typescript
export interface DisplacementFlow {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;        // number, not string
  originLat?: number;      // flat, not GeoCoordinates
  originLon?: number;
  asylumLat?: number;
  asylumLon?: number;
}

export interface CountryDisplacement {
  code: string;
  name: string;
  refugees: number;        // number, not string
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
  lat?: number;            // flat, not GeoCoordinates
  lon?: number;
}

export interface UnhcrSummary {
  year: number;
  globalTotals: {
    refugees: number;      // number, not string
    asylumSeekers: number;
    idps: number;
    stateless: number;
    total: number;
  };
  countries: CountryDisplacement[];
  topFlows: DisplacementFlow[];
}
```

### Shape Differences: Proto vs Legacy

| Field | Proto (generated TS) | Legacy | Mapping |
|-------|---------------------|--------|---------|
| `refugees` (GlobalTotals) | `string` (int64) | `number` | `Number(proto.refugees)` |
| `asylum_seekers` (GlobalTotals) | `string` (int64) | `number` | `Number(proto.asylumSeekers)` |
| All int64 population counts | `string` | `number` | `Number()` conversion needed |
| `CountryDisplacement.location` | `GeoCoordinates { latitude, longitude }` | `lat?: number, lon?: number` | `proto.location?.latitude`, `proto.location?.longitude` |
| `DisplacementFlow.origin_location` | `GeoCoordinates` | `originLat?, originLon?` | Same pattern |
| `DisplacementFlow.asylum_location` | `GeoCoordinates` | `asylumLat?, asylumLon?` | Same pattern |

**This is a CRITICAL mapping concern.** Every int64 field must be converted from `string` to `number`, and every `GeoCoordinates` must be unpacked to flat lat/lon. The service module adapter handles this.

### Consumers (files that import from UNHCR/displacement)

| Consumer | What it imports | From where | Fields accessed |
|----------|----------------|------------|-----------------|
| **App.ts** | `fetchUnhcrPopulation` | `@/services/unhcr` | `ok`, `data.countries`, `data.topFlows`, `data.countries.length` |
| **App.ts** | `ingestDisplacementForCII` | `@/services/country-instability` | Passes `data.countries` (CountryDisplacement[]) |
| **DisplacementPanel.ts** | `UnhcrSummary`, `CountryDisplacement` (types) | `@/types` | `data.globalTotals.{refugees,asylumSeekers,idps,total}`, `c.refugees`, `c.asylumSeekers`, `c.hostTotal`, `c.totalDisplaced`, `c.name`, `c.lat`, `c.lon` |
| **DisplacementPanel.ts** | `formatPopulation` | `@/services/unhcr` | Utility function |
| **MapContainer.ts** | `DisplacementFlow` (type) | `@/types` | `flows` array passed through to DeckGLMap |
| **DeckGLMap.ts** | `DisplacementFlow` (type) | `@/types` | `f.originLat`, `f.originLon`, `f.asylumLat`, `f.asylumLon`, `f.refugees` |
| **conflict-impact.ts** | `CountryDisplacement` (type) | `@/types` | `d.name`, `d.code`, `d.refugees`, `d.asylumSeekers` |
| **country-instability.ts** | `CountryDisplacement` (type) | `@/types` | `c.code`, `c.name`, `c.refugees`, `c.asylumSeekers` |

**Key observation:** Consumers use `number` arithmetic on population fields (e.g., `c.refugees + c.asylumSeekers`) and flat lat/lon access (e.g., `f.originLat`). The service module MUST map proto shape to legacy shape so consumers remain unchanged.

### UNHCR Population API Details (from legacy endpoint)

**Base URL:** `https://api.unhcr.org/population/v1/population/`
**Auth:** None (public API)
**Pagination:** `?year={year}&limit=10000&page={page}`
**Response shape:**
```json
{
  "items": [
    {
      "coo_iso": "AFG",      // Country of Origin ISO3
      "coo_name": "Afghanistan",
      "coa_iso": "PAK",      // Country of Asylum ISO3
      "coa_name": "Pakistan",
      "refugees": 1234567,
      "asylum_seekers": 12345,
      "idps": 0,
      "stateless": 0
    }
  ],
  "maxPages": 5
}
```

**Data volume:** Potentially thousands of records (one per origin-asylum country pair).

## Handler Design

### Architecture: Heavy Aggregation Handler

Unlike the prediction handler (thin proxy, returns empty on failure) or climate handler (parallel zone fetches, simple baseline math), the displacement handler must:

1. **Paginate** through all UNHCR API pages (up to 25 pages x 10,000 records)
2. **Aggregate by origin country** (sum refugees, asylumSeekers, idps, stateless)
3. **Aggregate by asylum country** (sum hostRefugees, hostAsylumSeekers)
4. **Merge origin + asylum** into unified country records
5. **Compute global totals** (sum across all records)
6. **Build displacement flows** (origin->asylum refugee corridors, top N by count)
7. **Attach coordinates** from hardcoded country centroids
8. **Respect request params**: year (with fallback), country_limit, flow_limit

This is the most data processing of any handler, but it is a direct port of the logic in `api/unhcr-population.js`.

### Handler Implementation Details

The handler should:
1. Accept `year` from request (default: current year, fallback to year-1, year-2 if no data)
2. Accept `countryLimit` (default: all countries) and `flowLimit` (default: 50)
3. Paginate through UNHCR API: `https://api.unhcr.org/population/v1/population/?year={year}&limit=10000&page={page}`
4. Aggregate raw records into by-origin and by-asylum maps
5. Compute `GlobalDisplacementTotals` (string-encoded int64s for proto)
6. Build `CountryDisplacement[]` with origin + asylum metrics merged, sorted by max(totalDisplaced, hostTotal) descending, optionally capped by `countryLimit`
7. Build `DisplacementFlow[]` from flow map, sorted by refugees descending, capped by `flowLimit`
8. Attach `GeoCoordinates` from the hardcoded centroids map
9. Return proto `GetDisplacementSummaryResponse { summary: DisplacementSummary }`
10. Return empty/graceful on ANY fetch failure (per Phase 2F-01 decision)

### Country Centroids

The 36-country centroid map from the legacy endpoint must be migrated to the handler:

```typescript
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AFG: [33.9, 67.7], SYR: [35.0, 38.0], UKR: [48.4, 31.2], /* ... 33 more */
};
```

These map ISO3 codes to `[lat, lon]` pairs. In the handler, they become `GeoCoordinates { latitude, longitude }` objects. Countries not in the map get no `location` (optional field in proto).

### Graceful Failure

Per 2F-01 decision: handler returns empty/graceful on ANY fetch failure. For displacement, this means:

```typescript
return {
  summary: {
    year: requestedYear,
    globalTotals: { refugees: '0', asylumSeekers: '0', idps: '0', stateless: '0', total: '0' },
    countries: [],
    topFlows: [],
  },
};
```

### Caching Consideration

The legacy endpoint has Redis caching (24h TTL) and in-memory fallback. The handler does NOT implement caching -- this is consistent with the established pattern. Caching is a gateway/infrastructure concern, not a handler concern. The UNHCR data updates yearly so frequent fetches are wasteful, but the handler simply proxies each request.

**Open question:** Should the handler implement simple in-memory caching given the data changes yearly? This is NOT done in other handlers but the UNHCR API is slow (multiple pages) and the data is static. Decision for planner.

## Service Module Design

### Architecture: Standard Port/Adapter (like Climate 2E)

Unlike the prediction service module (complex multi-strategy fetch), the displacement service module is a **standard port/adapter** that:

1. Calls the generated `DisplacementServiceClient.getDisplacementSummary()`
2. Maps proto shape to legacy consumer shape (int64 string->number, GeoCoordinates->flat lat/lon)
3. Exports the same public API the legacy `src/services/unhcr.ts` provided
4. Re-exports presentation helpers (getDisplacementColor, getDisplacementBadge, formatPopulation, getOriginCountries, getHostCountries)

### Service Module File Structure

```
src/services/displacement/
  index.ts          # Main module: all exports
```

Uses the directory pattern (`src/services/displacement/index.ts`) matching the wildfires/climate convention from Phase 2E-02 decision.

### What the Service Module Exports

```typescript
// Consumer-friendly types (re-exported, matching legacy shape)
export interface DisplacementFlow {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;        // number, NOT string
  originLat?: number;      // flat, NOT GeoCoordinates
  originLon?: number;
  asylumLat?: number;
  asylumLon?: number;
}

export interface CountryDisplacement {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
  lat?: number;
  lon?: number;
}

export interface UnhcrSummary {
  year: number;
  globalTotals: {
    refugees: number;
    asylumSeekers: number;
    idps: number;
    stateless: number;
    total: number;
  };
  countries: CountryDisplacement[];
  topFlows: DisplacementFlow[];
}

export interface UnhcrFetchResult {
  ok: boolean;
  data: UnhcrSummary;
  cachedAt?: string;
}

// Main fetch (public API)
export async function fetchUnhcrPopulation(): Promise<UnhcrFetchResult>;

// Presentation helpers (used by DisplacementPanel, DeckGLMap)
export function getDisplacementColor(totalDisplaced: number): [number, number, number, number];
export function getDisplacementBadge(totalDisplaced: number): { label: string; color: string };
export function formatPopulation(n: number): string;
export function getOriginCountries(data: UnhcrSummary): CountryDisplacement[];
export function getHostCountries(data: UnhcrSummary): CountryDisplacement[];
```

### Internal: Proto-to-Legacy Mapping

The core mapping functions:

```typescript
function toDisplaySummary(proto: ProtoGetDisplacementSummaryResponse): UnhcrSummary {
  const s = proto.summary!;
  const gt = s.globalTotals!;
  return {
    year: s.year,
    globalTotals: {
      refugees: Number(gt.refugees),
      asylumSeekers: Number(gt.asylumSeekers),
      idps: Number(gt.idps),
      stateless: Number(gt.stateless),
      total: Number(gt.total),
    },
    countries: s.countries.map(toDisplayCountry),
    topFlows: s.topFlows.map(toDisplayFlow),
  };
}

function toDisplayCountry(proto: ProtoCountryDisplacement): CountryDisplacement {
  return {
    code: proto.code,
    name: proto.name,
    refugees: Number(proto.refugees),
    asylumSeekers: Number(proto.asylumSeekers),
    idps: Number(proto.idps),
    stateless: Number(proto.stateless),
    totalDisplaced: Number(proto.totalDisplaced),
    hostRefugees: Number(proto.hostRefugees),
    hostAsylumSeekers: Number(proto.hostAsylumSeekers),
    hostTotal: Number(proto.hostTotal),
    lat: proto.location?.latitude,
    lon: proto.location?.longitude,
  };
}

function toDisplayFlow(proto: ProtoDisplacementFlow): DisplacementFlow {
  return {
    originCode: proto.originCode,
    originName: proto.originName,
    asylumCode: proto.asylumCode,
    asylumName: proto.asylumName,
    refugees: Number(proto.refugees),
    originLat: proto.originLocation?.latitude,
    originLon: proto.originLocation?.longitude,
    asylumLat: proto.asylumLocation?.latitude,
    asylumLon: proto.asylumLocation?.longitude,
  };
}
```

### Presentation Helpers

The existing helpers in `src/services/unhcr.ts` should be preserved as-is in the new service module:
- `getDisplacementColor()` -- uses number thresholds (1M, 500K, 100K), no change needed
- `getDisplacementBadge()` -- uses number thresholds and CSS custom properties, no change needed
- `formatPopulation()` -- pure math on number, no change needed
- `getOriginCountries()` -- filters and sorts, works with `CountryDisplacement` interface, no change needed
- `getHostCountries()` -- filters and sorts, works with `CountryDisplacement` interface, no change needed

These helpers are just arithmetic/sorting on the consumer-friendly types. They move verbatim from `src/services/unhcr.ts` to `src/services/displacement/index.ts`.

## Gateway Integration

`api/[[...path]].ts`:
- Import `createDisplacementServiceRoutes` from `../src/generated/server/worldmonitor/displacement/v1/service_server`
- Import `displacementHandler` from `./server/worldmonitor/displacement/v1/handler`
- Add to `allRoutes` array: `...createDisplacementServiceRoutes(displacementHandler, serverOptions)`

Handler file: `api/server/worldmonitor/displacement/v1/handler.ts`

Also rebuild sidecar bundle (`npm run build:sidecar-sebuf`).

## Consumer Adaptation

### Import Path Changes

| Consumer | Old import | New import |
|----------|-----------|------------|
| **App.ts** | `import { fetchUnhcrPopulation } from '@/services/unhcr'` | `import { fetchUnhcrPopulation } from '@/services/displacement'` |
| **DisplacementPanel.ts** | `import type { UnhcrSummary, CountryDisplacement } from '@/types'` + `import { formatPopulation } from '@/services/unhcr'` | `import type { UnhcrSummary, CountryDisplacement } from '@/services/displacement'` + `import { formatPopulation } from '@/services/displacement'` |
| **MapContainer.ts** | `import { DisplacementFlow } from '@/types'` | `import type { DisplacementFlow } from '@/services/displacement'` |
| **DeckGLMap.ts** | `import { DisplacementFlow } from '@/types'` | `import type { DisplacementFlow } from '@/services/displacement'` |
| **conflict-impact.ts** | `import type { CountryDisplacement } from '@/types'` | `import type { CountryDisplacement } from '@/services/displacement'` |
| **country-instability.ts** | `import type { CountryDisplacement } from '@/types'` | `import type { CountryDisplacement } from '@/services/displacement'` |

### No Consumer Logic Changes Required

Because the service module exports the **exact same types and function signatures** as the legacy service, consumers only need import path changes. No arithmetic, no field access changes. The shape mapping is entirely internal to the service module.

### Barrel Export Update

`src/services/index.ts` does NOT currently export unhcr. No barrel change needed. Consumers import directly from `@/services/unhcr` (or `@/services/displacement` after migration).

## Cleanup

Delete:
- `api/unhcr-population.js` -- replaced by handler in the catch-all gateway
- `src/services/unhcr.ts` -- replaced by `src/services/displacement/index.ts`

Remove from `src/types/index.ts`:
- `DisplacementFlow` interface (lines 256-266)
- `CountryDisplacement` interface (lines 268-283)
- `UnhcrSummary` interface (lines 285-296)
- Comment `// UNHCR Displacement Data` (line 255)

Verify with grep that no file still imports these from `@/types` after rewiring.

## Architecture Patterns

### Established Migration Pattern (from 2C/2D/2E/2F)

Each domain migration has two plans:
1. **Plan 01: Handler + gateway wiring + sidecar rebuild**
   - Implement handler at `api/server/worldmonitor/displacement/v1/handler.ts`
   - Wire into `api/[[...path]].ts` gateway
   - Rebuild sidecar bundle
2. **Plan 02: Service module (port/adapter) + consumer rewiring + legacy deletion**
   - Create service module at `src/services/displacement/index.ts`
   - Rewire all consumers to import from service module
   - Delete legacy endpoint and legacy service
   - Remove dead types from `src/types/index.ts`

### Handler Pattern (Heavy Aggregation)
```typescript
// api/server/worldmonitor/displacement/v1/handler.ts
import type {
  DisplacementServiceHandler,
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
  CountryDisplacement,
  DisplacementFlow,
} from '../../../../../src/generated/server/worldmonitor/displacement/v1/service_server';

const UNHCR_BASE = 'https://api.unhcr.org/population/v1/population/';
const COUNTRY_CENTROIDS: Record<string, [number, number]> = { /* 36 entries */ };

export const displacementHandler: DisplacementServiceHandler = {
  async getDisplacementSummary(
    _ctx: ServerContext,
    req: GetDisplacementSummaryRequest,
  ): Promise<GetDisplacementSummaryResponse> {
    try {
      // 1. Determine year (fallback from current to current-2)
      // 2. Paginate through UNHCR API
      // 3. Aggregate by origin and asylum
      // 4. Build global totals, countries[], topFlows[]
      // 5. Attach centroids as GeoCoordinates
      // 6. Respect countryLimit and flowLimit
      // 7. Return GetDisplacementSummaryResponse
    } catch {
      // Return empty/graceful on ANY failure
      return { summary: { year: 0, countries: [], topFlows: [] } };
    }
  },
};
```

### Service Module Pattern (Standard Port/Adapter)
```typescript
// src/services/displacement/index.ts
import {
  DisplacementServiceClient,
  type GetDisplacementSummaryResponse as ProtoResponse,
  type CountryDisplacement as ProtoCountry,
  type DisplacementFlow as ProtoFlow,
} from '@/generated/client/worldmonitor/displacement/v1/service_client';

// Consumer-friendly types (legacy shape)
export interface CountryDisplacement { /* number fields, flat lat/lon */ }
export interface DisplacementFlow { /* number fields, flat lat/lon */ }
export interface UnhcrSummary { /* number globalTotals, array of above */ }

const client = new DisplacementServiceClient('');

export async function fetchUnhcrPopulation(): Promise<UnhcrFetchResult> {
  try {
    const response = await client.getDisplacementSummary({ year: 0, countryLimit: 0, flowLimit: 50 });
    const summary = toDisplaySummary(response);
    return { ok: true, data: summary };
  } catch (error) {
    console.warn('[Displacement] Fetch failed:', error);
    return { ok: false, data: emptyResult };
  }
}

// Internal mapping: proto string/GeoCoordinates -> legacy number/flat lat/lon
function toDisplaySummary(proto: ProtoResponse): UnhcrSummary { /* ... */ }

// Presentation helpers (copied verbatim from legacy)
export function getDisplacementColor(totalDisplaced: number): [number, number, number, number] { /* ... */ }
export function getDisplacementBadge(totalDisplaced: number): { label: string; color: string } { /* ... */ }
export function formatPopulation(n: number): string { /* ... */ }
export function getOriginCountries(data: UnhcrSummary): CountryDisplacement[] { /* ... */ }
export function getHostCountries(data: UnhcrSummary): CountryDisplacement[] { /* ... */ }
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Proto type generation | Manual TS interfaces | Generated `service_server.ts` and `service_client.ts` | Already generated, type-safe |
| HTTP routing | Express/custom router | `createDisplacementServiceRoutes` from generated server | Consistent with other domains |
| Error handling | Custom error responses | `mapErrorToResponse` via `serverOptions.onError` | Gateway-wide error handling |
| Circuit breaker | Custom retry logic | Existing `createCircuitBreaker` from `@/utils` | Already used by legacy service (though note: the service module may not need it if the generated client already handles failures gracefully) |
| GeoCoordinates mapping | Manual lat/lon handling | Proto `GeoCoordinates { latitude, longitude }` in handler, mapping in service module | Consistent with wildfire/climate patterns |

**Key insight:** The handler does the heavy lifting (UNHCR API aggregation), the service module is a thin adapter. This is the opposite of the prediction domain (thin handler, complex service module).

## Common Pitfalls

### Pitfall 1: int64 String-to-Number Mismatch
**What goes wrong:** Proto int64 fields are typed as `string` in generated TypeScript. Consumers do arithmetic like `c.refugees + c.asylumSeekers`. If strings leak through, JavaScript string concatenation produces "12345678" instead of addition.
**Why it happens:** protoc-gen-ts generates int64 as string to avoid JavaScript precision loss for very large numbers.
**How to avoid:** Service module adapter MUST `Number()` every int64 field. Test with: `typeof result.data.countries[0].refugees === 'number'`.
**Warning signs:** Displacement panel showing concatenated numbers instead of sums, or NaN values.

### Pitfall 2: GeoCoordinates vs Flat lat/lon
**What goes wrong:** Proto uses `GeoCoordinates { latitude, longitude }` objects. DeckGLMap accesses `f.originLat`, `f.originLon`. If proto shape leaks through, map shows no displacement arcs (undefined coordinates).
**Why it happens:** Proto nests coordinates in objects; legacy uses flat fields.
**How to avoid:** Service module adapter unpacks: `originLat: proto.originLocation?.latitude`. The toDisplayFlow() and toDisplayCountry() functions handle this mapping.
**Warning signs:** Displacement arcs layer shows nothing on map despite data loading.

### Pitfall 3: Handler Response int64 as String
**What goes wrong:** The handler builds the proto response and must use `string` for int64 fields in the generated TypeScript types. Writing `refugees: 12345` when the type expects `string` causes a TypeScript error.
**Why it happens:** Generated `service_server.ts` types define int64 fields as `string`.
**How to avoid:** Handler must convert aggregated numbers to strings: `refugees: String(totalRefugees)`. All population count fields in the response must be stringified.
**Warning signs:** TypeScript compile errors in handler: "Type 'number' is not assignable to type 'string'".

### Pitfall 4: UNHCR API Pagination
**What goes wrong:** Only fetching page 1, missing most data. Or fetching with wrong page size, hitting rate limits.
**Why it happens:** UNHCR API defaults to small pages; data can span many pages.
**How to avoid:** Port the exact pagination logic from legacy: `limit=10000`, loop until `page >= maxPages` or `items.length < limit`, max 25 pages guard.
**Warning signs:** Global totals much lower than expected (e.g., 100K refugees instead of 35M+).

### Pitfall 5: Year Fallback Logic
**What goes wrong:** Requesting current year when UNHCR data for that year is not yet available, resulting in empty response.
**Why it happens:** UNHCR data is published with a lag; current year data may not exist.
**How to avoid:** Port the fallback loop: try currentYear, then currentYear-1, then currentYear-2. Stop at first year with data.
**Warning signs:** Handler returns empty despite UNHCR API being healthy.

### Pitfall 6: Forgetting to Rebuild Sidecar
**What goes wrong:** Tauri desktop app doesn't see the new displacement handler because sidecar bundle is stale.
**Why it happens:** Gateway update requires rebuilding `api/[[...path]].js` via `build-sidecar-sebuf.mjs`.
**How to avoid:** Run `npm run build:sidecar-sebuf` after modifying `api/[[...path]].ts`.
**Warning signs:** Desktop app works for other domains but displacement handler returns 404.

### Pitfall 7: Circuit Breaker in Service Module
**What goes wrong:** Legacy `src/services/unhcr.ts` wraps the fetch in a circuit breaker. If the new service module omits it, transient failures cause cascading retries.
**Why it happens:** The circuit breaker is in the legacy service, not the legacy endpoint.
**How to avoid:** Decide whether to keep the circuit breaker. The generated client already throws on failure, and the service module catches errors and returns `{ ok: false, data: emptyResult }`. A circuit breaker may still be useful to avoid repeated slow UNHCR API calls. Recommendation: keep it for consistency with the legacy behavior.
**Warning signs:** Slow page loads when UNHCR API is down (each load waits for timeout).

## Key Differences from Prior Migrations

| Aspect | Seismology (2C) | Wildfires (2D) | Climate (2E) | Prediction (2F) | **Displacement (2G)** |
|--------|----------------|----------------|--------------|------------------|-----------------------|
| API authentication | None | NASA API key | None | None (Cloudflare) | **None** (public API) |
| Handler reliability | Always works | Works with key | Always works | Usually fails | **Usually works** (public, no blocks) |
| Business logic in handler | Simple JSON map | CSV parse + map | Baseline comparison | Thin proxy | **Heavy aggregation** (pagination, per-country sums, flow computation) |
| Service module complexity | Thin port/adapter | Some helpers | Thin port/adapter | COMPLEX multi-strategy | **Standard port/adapter** + presentation helpers |
| Shape mismatch | lat/lon -> location | lat/lon -> location | lat/lon -> location + enums | Scale 0-100 vs 0-1 | **int64 string->number** + **GeoCoordinates->flat lat/lon** |
| Proto vs legacy richness | Proto matches legacy | Proto richer | Proto matches legacy | Proto richer | **Proto matches legacy** (structurally) |
| Consumer count | 7 files | 5 files | 6 files | 9 files | **6 files** (App, DisplacementPanel, MapContainer, DeckGLMap, conflict-impact, country-instability) |
| Proto changes needed | INT64 annotation | Added fields | None | None | **None** |

## Open Questions

1. **Handler-level caching**
   - What we know: The legacy endpoint uses Redis (24h TTL) + in-memory fallback. UNHCR data updates yearly. Handler pagination is slow (multiple API calls).
   - What's unclear: Should the handler implement in-memory caching? No other handler does. But the UNHCR API is slow and data is static.
   - Recommendation: Do NOT add caching in the handler. Keep it consistent with other handlers. The client-side circuit breaker and browser caching provide adequate protection. If caching becomes needed, it can be added as a future enhancement at the gateway level.

2. **Country centroids completeness**
   - What we know: Legacy has 36 country centroids. The proto can represent any country via GeoCoordinates. Some countries in the UNHCR data may not have centroids.
   - What's unclear: Are 36 centroids sufficient? The DeckGLMap filters out flows without coordinates.
   - Recommendation: Port the existing 36 centroids as-is. Countries without centroids simply have no `location` field (optional in proto) and won't appear on map arcs. This matches current behavior.

3. **ISO3 vs ISO2 country codes**
   - What we know: UNHCR API returns ISO3 codes (e.g., "AFG"). Proto `CountryDisplacement.code` is just `string`. Legacy stores ISO3. The `ingestDisplacementForCII` function in `country-instability.ts` has an `ISO3_TO_ISO2` conversion map.
   - What's unclear: Should the proto `code` field contain ISO3 or ISO2?
   - Recommendation: Keep ISO3 in the handler and service module (matching legacy behavior). The `country-instability.ts` conversion logic handles the ISO3->ISO2 mapping internally.

## Sources

### Primary (HIGH confidence)
- `proto/worldmonitor/displacement/v1/displacement.proto` -- Message definitions (4 messages, 30+ fields)
- `proto/worldmonitor/displacement/v1/get_displacement_summary.proto` -- Request/Response messages
- `proto/worldmonitor/displacement/v1/service.proto` -- Service definition with HTTP annotation
- `src/generated/server/worldmonitor/displacement/v1/service_server.ts` -- Generated handler interface (156 lines, all int64 as string)
- `src/generated/client/worldmonitor/displacement/v1/service_client.ts` -- Generated client class (146 lines)
- `api/unhcr-population.js` -- Legacy Vercel Edge endpoint (270 lines, complete aggregation logic)
- `src/services/unhcr.ts` -- Legacy frontend service (73 lines, circuit breaker + presentation helpers)
- `src/types/index.ts:255-296` -- Legacy DisplacementFlow, CountryDisplacement, UnhcrSummary type definitions
- `api/[[...path]].ts` -- Catch-all gateway (needs displacement handler mounted)
- `api/server/worldmonitor/climate/v1/handler.ts` -- Reference handler (parallel fetch + aggregation pattern)
- `api/server/worldmonitor/prediction/v1/handler.ts` -- Reference handler (graceful failure pattern)
- `src/services/climate/index.ts` -- Reference service module (port/adapter pattern)
- `src/services/wildfires/index.ts` -- Reference service module (port/adapter with toMapXxx adapter)
- `src/services/prediction/index.ts` -- Reference service module (complex multi-strategy)
- `src/components/DisplacementPanel.ts` -- Consumer: full source examined (165 lines)
- `src/components/DeckGLMap.ts:3176-3192` -- Consumer: createDisplacementArcsLayer examined
- `src/services/conflict-impact.ts:1-50` -- Consumer: displacementData parameter examined
- `src/services/country-instability.ts:264-278` -- Consumer: ingestDisplacementForCII examined
- `src/App.ts:3668-3687` -- Consumer: UNHCR data loading block examined
- `scripts/build-sidecar-sebuf.mjs` -- Sidecar build script (esbuild config)

### Secondary (MEDIUM confidence)
- UNHCR Population API structure inferred from legacy endpoint fetch URLs and response parsing -- not independently verified against UNHCR docs, but the legacy endpoint is in production and works

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries/patterns already established in 2C-2F, no new dependencies
- Architecture: HIGH -- handler aggregation logic is a direct port of legacy endpoint (examined complete 270-line source), service module follows established port/adapter pattern from 2E climate
- Pitfalls: HIGH -- all consumer field access patterns verified by reading source code, int64 string/number mismatch and GeoCoordinates/flat lat/lon shape differences documented with exact field mappings

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable domain, no external library changes expected)
