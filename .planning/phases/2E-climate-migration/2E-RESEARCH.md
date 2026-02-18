# Phase 2E: Climate Migration - Research

**Researched:** 2026-02-18
**Domain:** Open-Meteo climate anomaly detection, ClimateService handler, frontend consumer adaptation
**Confidence:** HIGH

## Summary

Phase 2E migrates the climate/Open-Meteo domain to sebuf. This is the third domain migration following seismology (2C) and wildfires (2D), and benefits from well-established patterns. The complexity is moderate -- between seismology (simple JSON proxy) and wildfires (CSV parsing, env-var gating, shape mismatch):

1. **No API key needed**: Open-Meteo Archive API is free and requires no authentication -- no env-var gating or graceful degradation needed (unlike wildfires)
2. **JSON API**: Open-Meteo returns JSON, not CSV -- no custom parsing needed (simpler than wildfires)
3. **Real business logic in handler**: 15 zones fetched in parallel, 30-day baseline comparison, severity/type classification -- all belongs in the handler
4. **Shape mismatch**: Legacy `ClimateAnomaly` has `lat`/`lon`, proto has `location: GeoCoordinates` -- consumers need adaptation
5. **Proto fits well**: Proto already has all needed fields (zone, location, tempDelta, precipDelta, severity, type, period) -- no proto enhancement needed
6. **Enum mapping**: Legacy uses lowercase strings (`'normal'`, `'extreme'`), proto uses prefixed enums (`'ANOMALY_SEVERITY_NORMAL'`, `'ANOMALY_SEVERITY_EXTREME'`) -- consumers must adapt
7. **Multiple consumer types**: Panel, map heatmap, CII ingestion, conflict-impact correlation -- but all use the same `ClimateAnomaly` type from `@/types`

**Primary recommendation:** Follow the 2-plan pattern (Plan 01: handler + gateway, Plan 02: service module + consumer rewiring + legacy deletion). The service module is simpler than wildfires -- it is a thin port/adapter like earthquakes, not a module with business logic. The severity classification and baseline comparison are API-side concerns that belong entirely in the handler.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-01 | Environmental domain proto with service RPCs and HTTP annotations | Proto already defined at `proto/worldmonitor/climate/v1/` with `ClimateAnomaly` message, `AnomalySeverity`/`AnomalyType` enums, `ListClimateAnomalies` RPC, HTTP annotation at `/api/climate/v1/list-climate-anomalies`. No proto changes needed. |
| SERVER-02 | Handler implementation that proxies upstream external API and returns proto-typed responses | Handler must proxy Open-Meteo Archive API (`https://archive-api.open-meteo.com/v1/archive`), fetch 15 zones in parallel, compute 30-day baseline comparison, classify severity/type, return `ClimateAnomaly[]`. Pattern established by seismology and wildfire handlers. |
</phase_requirements>

## Current State

### Proto: `ClimateService`
Single RPC `ListClimateAnomalies`:
- Request: `pagination`, `min_severity` filter
- Response: `anomalies: ClimateAnomaly[]`, `pagination`
- `ClimateAnomaly`: `zone`, `location (GeoCoordinates)`, `temp_delta (double)`, `precip_delta (double)`, `severity (AnomalySeverity)`, `type (AnomalyType)`, `period`
- Route: `POST /api/climate/v1/list-climate-anomalies`

**No proto enhancement needed.** All fields the legacy endpoint returns are already modeled:
| Legacy field | Proto field | Match |
|---|---|---|
| `zone: string` | `zone: string` | Exact |
| `lat: number` | `location.latitude: number` | Shape change |
| `lon: number` | `location.longitude: number` | Shape change |
| `tempDelta: number` | `tempDelta: number` | Exact |
| `precipDelta: number` | `precipDelta: number` | Exact |
| `severity: 'normal'\|'moderate'\|'extreme'` | `severity: AnomalySeverity` | Enum mapping |
| `type: 'warm'\|'cold'\|'wet'\|'dry'\|'mixed'` | `type: AnomalyType` | Enum mapping |
| `period: string` | `period: string` | Exact |

### Generated Code (already exists)
- Server: `src/generated/server/worldmonitor/climate/v1/service_server.ts`
  - `ClimateServiceHandler` interface with `listClimateAnomalies(ctx, req): Promise<ListClimateAnomaliesResponse>`
  - `createClimateServiceRoutes(handler, options)` for gateway mounting
- Client: `src/generated/client/worldmonitor/climate/v1/service_client.ts`
  - `ClimateServiceClient` class with `listClimateAnomalies(req): Promise<ListClimateAnomaliesResponse>`

### Legacy Endpoint: `api/climate-anomalies.js`
Edge function with:
- **15 monitored zones** with lat/lon coordinates (Ukraine, Middle East, Sahel, Horn of Africa, South Asia, California, Amazon, Australia, Mediterranean, Taiwan Strait, Myanmar, Central Africa, Southern Africa, Central Asia, Caribbean)
- **Open-Meteo Archive API** (`https://archive-api.open-meteo.com/v1/archive`): free, no API key, returns JSON
- **30-day window**: `start_date` = 30 days ago, `end_date` = today
- **Daily variables**: `temperature_2m_mean`, `precipitation_sum`, timezone UTC
- **Baseline comparison**: Last 7 days of valid data vs preceding baseline (everything before last 7)
- **Severity classification**: `classifySeverity(tempDelta, precipDelta)` -- |temp| >= 5 OR |precip| >= 80 -> extreme, |temp| >= 3 OR |precip| >= 40 -> moderate, else normal
- **Type classification**: `classifyType(tempDelta, precipDelta)` -- complex logic considering relative magnitudes of temp/precip deltas
- **Rounding**: tempDelta and precipDelta rounded to 1 decimal place
- **Null filtering**: Filters out null values from daily arrays before computing averages
- **Minimum data check**: Requires at least 14 data points, returns null for zone if insufficient
- **Caching**: Redis 6h TTL + in-memory fallback (handler-side caching not needed -- gateway/edge caching handles this)
- **Rate limiting**: 15 req/min per IP (gateway-side concern, not handler)
- **Response**: `{ success: boolean, anomalies: ClimateAnomaly[], timestamp: string }`

### Legacy Frontend Service: `src/services/climate.ts`
Exports:
- `fetchClimateAnomalies()` -> `ClimateFetchResult` (calls `/api/climate-anomalies`, filters out `severity === 'normal'`, wraps in circuit breaker)
- `getSeverityColor(anomaly)` -> CSS color string (NOT imported by any consumer -- dead code)
- `getSeverityIcon(anomaly)` -> emoji string (imported by ClimateAnomalyPanel)
- `formatDelta(value, unit)` -> formatted string (imported by ClimateAnomalyPanel)

### Legacy Type: `src/types/index.ts`
```typescript
export type AnomalySeverity = 'normal' | 'moderate' | 'extreme';
export interface ClimateAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: AnomalySeverity;
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}
```

### Consumers (6 files total)

**1. `src/App.ts` (line 34, lines 3688-3707)**
- Imports `fetchClimateAnomalies` from `@/services/climate`
- Imports `ingestClimateForCII` from `@/services/country-instability`
- Calls `fetchClimateAnomalies()`, checks `.ok`, gets `.anomalies`
- Feeds anomalies to: panel (`setAnomalies`), CII ingestion (`ingestClimateForCII`), map (`setClimateAnomalies`)
- Records data freshness

**2. `src/components/ClimateAnomalyPanel.ts`**
- Imports `ClimateAnomaly` from `@/types`
- Imports `getSeverityIcon`, `formatDelta` from `@/services/climate`
- `setAnomalies(anomalies: ClimateAnomaly[])` -- renders table
- Accesses: `a.zone`, `a.tempDelta`, `a.precipDelta`, `a.severity`, `a.type`, `a.lat`, `a.lon` (for click-to-zoom)
- Row click handler uses `data-lat` and `data-lon` attributes

**3. `src/components/DeckGLMap.ts` (lines 266, 3194-3211, 3301-3304)**
- Imports `ClimateAnomaly` from `@/types`
- `private climateAnomalies: ClimateAnomaly[]`
- `setClimateAnomalies(anomalies: ClimateAnomaly[])` -- stores and re-renders
- `createClimateHeatmapLayer()` -- creates `HeatmapLayer<ClimateAnomaly>`
  - `getPosition: (d) => [d.lon, d.lat]` -- **uses `lon`/`lat` directly**
  - `getWeight: (d) => Math.abs(d.tempDelta) + Math.abs(d.precipDelta) * 0.1`

**4. `src/components/MapContainer.ts` (lines 28, 287-290)**
- Imports `ClimateAnomaly` from `@/types`
- `setClimateAnomalies(anomalies: ClimateAnomaly[])` -- delegates to DeckGLMap

**5. `src/services/country-instability.ts` (lines 8, 279-299)**
- Imports `ClimateAnomaly` from `@/types`
- `ZONE_COUNTRY_MAP`: Maps zone names to ISO2 country codes (only 4 zones mapped: Ukraine, Middle East, South Asia, Myanmar)
- `ingestClimateForCII(anomalies: ClimateAnomaly[])` -- accesses `a.severity`, `a.zone`
- Filters out `severity === 'normal'`, assigns stress scores per country

**6. `src/services/conflict-impact.ts` (lines 1, 8, 16, 47-51, 57)**
- Imports `ClimateAnomaly` from `@/types`
- `ConflictImpactLink.climateAnomaly: ClimateAnomaly | null`
- `correlateConflictImpact(... anomalies: ClimateAnomaly[])` -- accesses `a.zone`, `a.severity`
- Finds matching anomaly by zone name fuzzy match

## Handler Design

### Open-Meteo API Details
- **Base URL**: `https://archive-api.open-meteo.com/v1/archive`
- **Authentication**: None required (free API)
- **Rate limits**: Open-Meteo has generous rate limits for non-commercial use. The handler fetches 15 zones which is well within limits.
- **Parameters**: `latitude`, `longitude`, `start_date`, `end_date`, `daily`, `timezone`
- **Response format**: JSON with `daily.temperature_2m_mean[]` and `daily.precipitation_sum[]` arrays
- **Null handling**: API may return null values in daily arrays (e.g., data not yet available for recent days)

### Handler Implementation Pattern
```
api/server/worldmonitor/climate/v1/handler.ts
```

The handler implements all the business logic currently in the legacy endpoint:
1. Compute date range (today minus 30 days to today)
2. Fetch all 15 zones in parallel via `Promise.allSettled`
3. For each zone: parse JSON response, filter nulls, compute baseline comparison
4. Classify severity and type using the same logic as legacy
5. Map to proto `ClimateAnomaly` objects with enum values
6. Return as `ListClimateAnomaliesResponse`

**Key difference from wildfire handler**: No env-var gating needed. Open-Meteo is free and keyless.

### Monitored Zones (15 hardcoded, same as legacy)
| Zone | Latitude | Longitude |
|------|----------|-----------|
| Ukraine | 48.4 | 31.2 |
| Middle East | 33.0 | 44.0 |
| Sahel | 14.0 | 0.0 |
| Horn of Africa | 8.0 | 42.0 |
| South Asia | 25.0 | 78.0 |
| California | 36.8 | -119.4 |
| Amazon | -3.4 | -60.0 |
| Australia | -25.0 | 134.0 |
| Mediterranean | 38.0 | 20.0 |
| Taiwan Strait | 24.0 | 120.0 |
| Myanmar | 19.8 | 96.7 |
| Central Africa | 4.0 | 22.0 |
| Southern Africa | -25.0 | 28.0 |
| Central Asia | 42.0 | 65.0 |
| Caribbean | 19.0 | -72.0 |

### Severity Classification Logic (must match legacy exactly)
```typescript
function classifySeverity(tempDelta: number, precipDelta: number): AnomalySeverity {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= 5 || absPrecip >= 80) return 'ANOMALY_SEVERITY_EXTREME';
  if (absTemp >= 3 || absPrecip >= 40) return 'ANOMALY_SEVERITY_MODERATE';
  return 'ANOMALY_SEVERITY_NORMAL';
}
```

### Type Classification Logic (must match legacy exactly)
```typescript
function classifyType(tempDelta: number, precipDelta: number): AnomalyType {
  const absTemp = Math.abs(tempDelta);
  const absPrecip = Math.abs(precipDelta);
  if (absTemp >= absPrecip / 20) {
    if (tempDelta > 0 && precipDelta < -20) return 'ANOMALY_TYPE_MIXED';
    if (tempDelta > 3) return 'ANOMALY_TYPE_WARM';
    if (tempDelta < -3) return 'ANOMALY_TYPE_COLD';
  }
  if (precipDelta > 40) return 'ANOMALY_TYPE_WET';
  if (precipDelta < -40) return 'ANOMALY_TYPE_DRY';
  if (tempDelta > 0) return 'ANOMALY_TYPE_WARM';
  return 'ANOMALY_TYPE_COLD';
}
```

## Service Module Design

### Architecture Decision: Thin Port/Adapter (like earthquakes, NOT like wildfires)

The climate service module should be a thin port/adapter pattern, NOT a module with business logic:
- **All computation belongs in the handler**: Baseline comparison, severity classification, type classification -- all pure computation that transforms raw Open-Meteo data into proto-shaped anomalies
- **Service module only needs to**: Call the generated client, re-export the proto type, and provide utility functions consumed by ClimateAnomalyPanel
- **Helper functions `getSeverityIcon`/`formatDelta`**: These are presentation utilities that belong in the service module (same file), imported by the panel component

```
src/services/climate.ts   (rewrite in-place, same as earthquakes.ts pattern)
```

No need for a directory-per-service pattern here (unlike wildfires which had `computeRegionStats`, `flattenFires`, `toMapFires` -- real business logic). Climate service just fetches and exposes the data plus presentation helpers.

### What the Rewritten Service Module Exports

```typescript
// From generated client (re-exported)
export type { ClimateAnomaly };

// Fetch function (port)
export async function fetchClimateAnomalies(): Promise<ClimateFetchResult>;

// Presentation helpers (preserved from legacy, used by ClimateAnomalyPanel)
export function getSeverityIcon(anomaly: ClimateAnomaly): string;
export function formatDelta(value: number, unit: string): string;
```

**`getSeverityColor` is dead code** -- exported by legacy service but never imported by any consumer. Drop it during migration.

### Key Adaptation: ClimateFetchResult Shape

The legacy `ClimateFetchResult` has `{ ok: boolean, anomalies: ClimateAnomaly[], timestamp: string }`. The new version should:
- Keep `ok: boolean` (true on success, false on error)
- Return proto `ClimateAnomaly[]` (with enum severity/type, GeoCoordinates location)
- Drop `timestamp` if not needed (check App.ts usage... App.ts does not use `timestamp`)

Actually, the legacy `fetchClimateAnomalies` filters out `severity === 'normal'` before returning. With proto enums, this becomes filtering out `'ANOMALY_SEVERITY_NORMAL'`. This filter should stay in the service module since it is a consumer-side concern (handler returns all anomalies, service module filters for display).

## Consumer Adaptation

### Shape Changes Required

The key change: `ClimateAnomaly` type moves from `@/types` (with `lat`/`lon`) to proto (with `location.latitude`/`location.longitude`, enum severity/type).

| Consumer | Fields accessed | Adaptation needed |
|---|---|---|
| **ClimateAnomalyPanel** | `zone`, `tempDelta`, `precipDelta`, `severity`, `type`, `lat`, `lon` | `lat` -> `location?.latitude ?? 0`, `lon` -> `location?.longitude ?? 0`, severity/type enum mapping for display |
| **DeckGLMap** | `lon`, `lat`, `tempDelta`, `precipDelta` | `getPosition: d => [d.location?.longitude ?? 0, d.location?.latitude ?? 0]`, `getWeight` unchanged |
| **MapContainer** | just passes through | Type change only |
| **country-instability** | `severity`, `zone` | `severity === 'normal'` -> `severity === 'ANOMALY_SEVERITY_NORMAL'` |
| **conflict-impact** | `zone`, `severity` | severity enum mapping |
| **App.ts** | `.ok`, `.anomalies` | Import path change |

### ClimateAnomalyPanel: Severity/Type Display Mapping

The panel renders severity as `severity-${a.severity}` CSS class and uses `t('components.climate.severity.${a.severity}')` for display text. With proto enums, these become `'ANOMALY_SEVERITY_EXTREME'` instead of `'extreme'`.

**Options:**
1. **Map in service module**: Export a `MapClimateAnomaly` type with `lat`/`lon` and lowercase severity/type, similar to wildfires' `toMapFires()` approach
2. **Map in panel**: Panel maps enum to display string inline
3. **Add helpers to service module**: Export `severityLabel(severity)` and update CSS classes

**Recommendation: Option 1 -- Map in service module.** Export a `DisplayAnomaly` type that the panel and map use, with `lat`/`lon` fields and lowercase severity/type strings. This minimizes changes to panel, map, CII, and conflict-impact. The service module acts as the adapter layer, translating proto shapes to the shapes consumers already expect.

```typescript
export interface DisplayAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: 'normal' | 'moderate' | 'extreme';
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}

export function toDisplayAnomalies(anomalies: ClimateAnomaly[]): DisplayAnomaly[];
```

This maps proto enums to the lowercase strings consumers expect, and `location.latitude/longitude` to `lat`/`lon`. Consumers barely change -- they just get their `ClimateAnomaly` from a different import path, and the type is now `DisplayAnomaly` (or we can even name it `ClimateAnomaly` in the service module to minimize diffs).

**Actually, best approach:** The service module re-exports its own `ClimateAnomaly` interface (matching the legacy shape exactly) and performs the mapping internally. This means:
- Panel, DeckGLMap, MapContainer, country-instability, conflict-impact all just change their import path
- The type shape stays identical to what they already expect
- Zero logic changes in consumers

This is the approach used by wildfires (where `FetchResult`, `FireRegionStats`, `MapFire` were defined in the service module with consumer-friendly shapes).

### Import Path Changes

| Consumer | Old import | New import |
|---|---|---|
| `App.ts` | `import { fetchClimateAnomalies } from '@/services/climate'` | Same path (file rewritten in place) |
| `ClimateAnomalyPanel.ts` | `import type { ClimateAnomaly } from '@/types'` + `import { getSeverityIcon, formatDelta } from '@/services/climate'` | `import type { ClimateAnomaly } from '@/services/climate'` + `import { getSeverityIcon, formatDelta } from '@/services/climate'` |
| `DeckGLMap.ts` | `import { ClimateAnomaly } from '@/types'` | `import type { ClimateAnomaly } from '@/services/climate'` |
| `MapContainer.ts` | `import { ClimateAnomaly } from '@/types'` | `import type { ClimateAnomaly } from '@/services/climate'` |
| `country-instability.ts` | `import type { ClimateAnomaly } from '@/types'` | `import type { ClimateAnomaly } from '@/services/climate'` |
| `conflict-impact.ts` | `import type { ClimateAnomaly } from '@/types'` | `import type { ClimateAnomaly } from '@/services/climate'` |

## Gateway Integration

`api/[[...path]].ts`:
- Import `createClimateServiceRoutes` from generated server
- Import `climateHandler` from handler
- Add to `allRoutes` array

Also rebuild sidecar bundle (`npm run build:sidecar-sebuf`).

## Cleanup

Delete:
- `api/climate-anomalies.js` -- replaced by handler

**Note:** `src/services/climate.ts` is rewritten in place (not deleted) since it becomes the new port/adapter. No separate legacy file to delete for the service.

Remove `ClimateAnomaly` and `AnomalySeverity` from `src/types/index.ts` -- but only if no other file still imports them from `@/types`. After rewiring all consumers to import from `@/services/climate`, the type in `@/types` becomes dead code.

Check `vite.config.ts` -- confirmed no climate proxy exists (endpoint was a direct fetch to `/api/climate-anomalies`).

## Architecture Patterns

### Established Migration Pattern (from 2C/2D)

Each domain migration has two plans:
1. **Plan 01: Handler + gateway wiring**
   - Implement handler at `api/server/worldmonitor/{domain}/v1/handler.ts`
   - Wire into `api/[[...path]].ts` gateway
   - Rebuild sidecar bundle
2. **Plan 02: Service module + consumer rewiring + legacy deletion**
   - Rewrite/create service module at `src/services/{domain}.ts` (or `src/services/{domain}/index.ts` for complex modules)
   - Rewire all consumers to import from service module
   - Delete legacy endpoint

### Handler Pattern
```typescript
// api/server/worldmonitor/climate/v1/handler.ts
import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
  AnomalySeverity,
  AnomalyType,
} from '../../../../../src/generated/server/worldmonitor/climate/v1/service_server';

export const climateHandler: ClimateServiceHandler = {
  async listClimateAnomalies(
    _ctx: ServerContext,
    _req: ListClimateAnomaliesRequest,
  ): Promise<ListClimateAnomaliesResponse> {
    // Fetch all 15 zones, compute baselines, classify, return proto-typed anomalies
  },
};
```

### Service Module Port/Adapter Pattern
```typescript
// src/services/climate.ts (rewritten)
import {
  ClimateServiceClient,
  type ClimateAnomaly as ProtoClimateAnomaly,
  type AnomalySeverity,
  type AnomalyType,
} from '@/generated/client/worldmonitor/climate/v1/service_client';

// Re-export consumer-friendly type (matches legacy shape)
export interface ClimateAnomaly {
  zone: string;
  lat: number;
  lon: number;
  tempDelta: number;
  precipDelta: number;
  severity: 'normal' | 'moderate' | 'extreme';
  type: 'warm' | 'cold' | 'wet' | 'dry' | 'mixed';
  period: string;
}

const client = new ClimateServiceClient('');

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  // Call client, map proto to consumer shape, filter out 'normal'
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Proto type generation | Manual TS interfaces | Generated `service_server.ts` and `service_client.ts` | Already generated, type-safe |
| HTTP routing | Express/custom router | `createClimateServiceRoutes` from generated server | Consistent with other domains |
| Error handling | Custom error responses | `mapErrorToResponse` via `serverOptions.onError` | Gateway-wide error handling |

## Common Pitfalls

### Pitfall 1: Severity/Type Enum Mismatch
**What goes wrong:** Panel CSS classes and i18n keys use lowercase (`severity-extreme`, `t('components.climate.severity.extreme')`). Proto enums are uppercase prefixed (`ANOMALY_SEVERITY_EXTREME`).
**Why it happens:** Proto enum naming convention differs from legacy string union.
**How to avoid:** Service module maps proto enums to lowercase strings in the `ClimateAnomaly` interface it exports. Consumers never see proto enums directly.
**Warning signs:** Panel shows no severity badges, i18n keys resolve to fallback text.

### Pitfall 2: lat/lon vs location.latitude/longitude
**What goes wrong:** DeckGLMap's heatmap layer accesses `d.lon` and `d.lat` for positioning. Proto `ClimateAnomaly` has `location.latitude` / `location.longitude`.
**Why it happens:** Proto uses nested `GeoCoordinates` message, legacy used flat fields.
**How to avoid:** Service module's exported `ClimateAnomaly` includes flat `lat`/`lon` fields mapped from `location`. DeckGLMap code unchanged.
**Warning signs:** Heatmap layer renders at [0,0] (null island) for all anomalies.

### Pitfall 3: Empty Response Heuristic
**What goes wrong:** Unlike wildfires (where empty = missing API key), climate uses a free API. Empty results legitimately mean no data.
**Why it happens:** Open-Meteo may return insufficient data for some zones (< 14 data points), leading to zones being skipped.
**How to avoid:** Do NOT treat empty response as "skipped" -- this is unlike the wildfire pattern. If zero anomalies return, it means all zones were either normal-severity (filtered out) or had insufficient data. Just return empty list.
**Warning signs:** False "API not configured" messages in panel.

### Pitfall 4: Floating Point Rounding
**What goes wrong:** Legacy endpoint rounds tempDelta and precipDelta to 1 decimal place. If handler omits rounding, values may differ slightly from legacy.
**Why it happens:** `Math.round(value * 10) / 10` in legacy but might be forgotten in handler.
**How to avoid:** Apply same rounding in handler: `Math.round(tempDelta * 10) / 10`.
**Warning signs:** Panel shows values with excessive decimal places.

### Pitfall 5: Minimum Data Check
**What goes wrong:** Legacy requires at least 14 data points before computing a zone's anomaly. Missing this check causes division by zero or misleading results from very small samples.
**Why it happens:** Open-Meteo may not have complete data for very recent dates.
**How to avoid:** Handler must check `temps.length < 14` and skip the zone if insufficient.
**Warning signs:** Zones showing extreme anomalies based on 1-2 data points.

## Key Differences from Prior Migrations

| Aspect | Seismology (2C) | Wildfires (2D) | Climate (2E) |
|--------|----------------|----------------|--------------|
| API authentication | None | NASA_FIRMS_API_KEY | None |
| API format | JSON | CSV | JSON |
| Graceful degradation | N/A | Empty on missing key | N/A |
| Business logic in handler | Simple map | CSV parse, map | Baseline comparison, classification |
| Service module complexity | Thin port/adapter | Real business logic | Thin port/adapter + helpers |
| Shape mismatch | `lat`/`lon` -> `location` | `lat`/`lon` -> `location` + more | `lat`/`lon` -> `location` + enum mapping |
| Consumer count | 7 files | 5 files | 6 files |
| Proto changes needed | INT64 annotation | Added fields | None |

## Open Questions

1. **`AnomalySeverity` type in `@/types/index.ts` after migration**
   - What we know: After rewiring all consumers to import from `@/services/climate`, the `ClimateAnomaly` and `AnomalySeverity` types in `@/types/index.ts` become dead code.
   - What's unclear: Should we delete them now or defer to Phase 2T (type cleanup phase) like seismology did?
   - Recommendation: Delete them in Plan 02 since climate is fully self-contained. Unlike `Earthquake` which had 7+ consumers some of which might use the type elsewhere, `ClimateAnomaly` in `@/types` is only imported by 4 files (all being rewired). Verify with grep before deleting.

2. **conflict-impact.ts dependency on ClimateAnomaly shape**
   - What we know: `correlateConflictImpact` receives `ClimateAnomaly[]` and accesses `a.zone` and `a.severity`.
   - What's unclear: Is this function actually called anywhere? It's exported but may be dead code.
   - Recommendation: Grep for `correlateConflictImpact` usage. If called, rewire. If dead code, note but still rewire the import (it still must compile).

## Sources

### Primary (HIGH confidence)
- `proto/worldmonitor/climate/v1/climate_anomaly.proto` -- ClimateAnomaly message, enums
- `proto/worldmonitor/climate/v1/list_climate_anomalies.proto` -- Request/Response messages
- `proto/worldmonitor/climate/v1/service.proto` -- Service definition with HTTP annotations
- `src/generated/server/worldmonitor/climate/v1/service_server.ts` -- Generated handler interface
- `src/generated/client/worldmonitor/climate/v1/service_client.ts` -- Generated client class
- `api/climate-anomalies.js` -- Legacy endpoint (complete source examined)
- `src/services/climate.ts` -- Legacy frontend service (complete source examined)
- `src/types/index.ts` -- Legacy ClimateAnomaly type definition
- All 6 consumer files examined in full for field access patterns

### Secondary (MEDIUM confidence)
- [Open-Meteo Historical Weather API documentation](https://open-meteo.com/en/docs/historical-weather-api) -- API parameters, response format

### Prior phase summaries (HIGH confidence)
- `.planning/phases/2C-seismology-migration/2C-02-SUMMARY.md` -- Port/adapter pattern establishment
- `.planning/phases/2D-wildfire-migration/2D-RESEARCH.md` -- Migration pattern, service module design
- `.planning/phases/2D-wildfire-migration/2D-01-PLAN.md` -- Handler implementation pattern
- `.planning/phases/2D-wildfire-migration/2D-02-PLAN.md` -- Consumer rewiring pattern

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries/patterns already established in 2C/2D, no new dependencies
- Architecture: HIGH -- handler and service module patterns well-established, all source files examined
- Pitfalls: HIGH -- all consumer field access patterns verified by reading source code, enum mapping identified from type definitions

**Research date:** 2026-02-18
**Valid until:** 2026-03-18 (stable domain, no external library changes expected)
