# Phase 2K: Conflict Migration - Research

**Researched:** 2026-02-19
**Domain:** Conflict domain migration to sebuf (ACLED armed conflicts + UCDP georeferenced violence events + HAPI humanitarian summaries) -- handler proxying three upstream APIs with cross-source deduplication, service module with port/adapter pattern, consumer rewiring, legacy endpoint deletion
**Confidence:** HIGH

## Summary

The conflict migration is the 9th domain in the sebuf migration series (2C through 2K). It follows the established 2-plan pattern (Plan 01: handler + gateway wiring; Plan 02: service module + consumer rewiring + legacy deletion) and is the most complex handler in the series due to THREE distinct RPCs proxying THREE different upstream APIs: ACLED (armed conflicts -- battles, explosions, violence against civilians), UCDP (georeferenced violence events), and HAPI/HDX (humanitarian country summaries).

The proto definition is already complete at `proto/worldmonitor/conflict/v1/service.proto` with three RPCs: `ListAcledEvents`, `ListUcdpEvents`, and `GetHumanitarianSummary`. Generated server types (`ConflictServiceHandler` interface) and client code (`ConflictServiceClient` class) already exist. The handler needs to implement all three RPCs, each proxying a different upstream API. ACLED requires `Bearer` auth from `ACLED_ACCESS_TOKEN` env var. UCDP is public but requires version discovery (trying `{year}.1` then `{year-1}.1`). HAPI is public but uses a base64 app identifier.

The conflict domain has FOUR legacy service files (`src/services/conflicts.ts`, `src/services/ucdp.ts`, `src/services/ucdp-events.ts`, `src/services/hapi.ts`) and one correlation module (`src/services/conflict-impact.ts`), plus THREE legacy API endpoints (`api/acled-conflict.js`, `api/ucdp.js`, `api/ucdp-events.js`, `api/hapi.js`). These are consumed by `App.ts` (direct imports, NOT through the barrel) and `country-instability.ts` (imports types from the legacy services). The `UcdpGeoEvent` interface from `src/types/index.ts` is used by map components (`DeckGLMap.ts`, `MapContainer.ts`, `UcdpEventsPanel.ts`). The service module must maintain backward compatibility with all legacy type shapes while routing through the new proto-typed handler.

**Primary recommendation:** Implement a 3-RPC handler (`listAcledEvents`, `listUcdpEvents`, `getHumanitarianSummary`) that proxies the three upstream APIs. The service module wraps `ConflictServiceClient` and provides adapter functions mapping proto types to legacy types (`ConflictEvent`, `UcdpConflictStatus`, `UcdpGeoEvent`, `HapiConflictSummary`). The `deduplicateAgainstAcled` function and `correlateConflictImpact` function move to the service module. Consumer rewiring updates `App.ts` imports. Legacy files are deleted (4 services + 3 API endpoints).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DOMAIN-07 | Geopolitical domain proto (ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees) with service RPCs and HTTP annotations | The conflict proto files are fully defined: `service.proto` (3 RPCs with HTTP annotations), `acled_event.proto` (`AcledConflictEvent` with id, eventType, country, location, occurredAt, fatalities, actors, source, admin1), `ucdp_event.proto` (`UcdpViolenceEvent` with id, dateStart, dateEnd, location, country, sideA, sideB, deathsBest/Low/High, violenceType enum, sourceOriginal), `humanitarian_summary.proto` (`HumanitarianCountrySummary` with countryCode, countryName, populationAffected, peopleInNeed, internallyDisplaced, foodInsecurityLevel, waterAccessPct, updatedAt), and request/response wrappers with TimeRange, Pagination, and country filters. Generated server (`ConflictServiceHandler` with 3 RPCs) and client (`ConflictServiceClient`) exist. Handler implementation is the remaining work. This phase covers the conflict+UCDP+HAPI portions of DOMAIN-07. |
| SERVER-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | Handler must implement `ConflictServiceHandler` with 3 RPCs: `listAcledEvents` (proxies `https://acleddata.com/api/acled/read` with Bearer auth for battles/explosions/violence), `listUcdpEvents` (proxies `https://ucdpapi.pcr.uu.se/api/gedevents/{version}` with version discovery, paginated fetching, trailing-window filtering), `getHumanitarianSummary` (proxies `https://hapi.humdata.org/api/v2/coordination-context/conflict-events` with base64 app identifier, filters by country). All RPCs follow established graceful degradation pattern (return empty on failure). |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none new) | - | All infrastructure already exists | No new dependencies needed for this migration |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | All infrastructure is existing project code (generated server/client, circuit breaker, CORS, error mapper) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Three separate RPCs | Single unified conflict RPC | Three RPCs map cleanly to three upstream APIs, allow independent request filtering (time range, country, pagination). A single RPC would require complex conditional logic and mixed response types. |
| UCDP version discovery in handler | Hardcoded version | Legacy code discovers version dynamically (tries `{year}.1`, `{year-1}.1`, etc.) which is more robust across year boundaries. Keep this pattern. |
| Server-side deduplication (UCDP vs ACLED) | Client-side deduplication | Legacy uses client-side `deduplicateAgainstAcled` with haversine distance + date proximity. Keep this in service module (not handler) because it requires data from BOTH RPCs (ACLED and UCDP responses). |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
api/
  server/
    worldmonitor/
      conflict/
        v1/
          handler.ts              # Plan 01: ConflictServiceHandler with 3 RPCs
  [[...path]].ts                  # Plan 01: Mount conflict routes (add import + spread)
  acled-conflict.js               # Plan 02: DELETE (legacy ACLED conflict proxy)
  ucdp.js                         # Plan 02: DELETE (legacy UCDP classifications proxy)
  ucdp-events.js                  # Plan 02: DELETE (legacy UCDP events proxy)
  hapi.js                         # Plan 02: DELETE (legacy HAPI proxy)

src/
  services/
    conflict/
      index.ts                    # Plan 02: Port/adapter service module
    conflicts.ts                  # Plan 02: DELETE (legacy ACLED conflict client)
    ucdp.ts                       # Plan 02: DELETE (legacy UCDP classifications client)
    ucdp-events.ts                # Plan 02: DELETE (legacy UCDP events client)
    hapi.ts                       # Plan 02: DELETE (legacy HAPI client)
    conflict-impact.ts            # Plan 02: DELETE (move to conflict module)
  types/
    index.ts                      # Plan 02: Keep UcdpGeoEvent, UcdpEventType (used by map components)
```

### Pattern 1: Three-RPC Handler Proxying Distinct Upstream APIs
**What:** A single handler file implementing `ConflictServiceHandler` with three RPC methods, each independently proxying a different upstream API.
**When to use:** For the `listAcledEvents`, `listUcdpEvents`, and `getHumanitarianSummary` RPCs.
**Key insight:** Unlike the unrest handler (which merged two sources into one RPC), the conflict handler keeps each upstream API as a separate RPC. This is because:
1. The data shapes are fundamentally different (ACLED events vs UCDP events vs HAPI summaries)
2. Clients need to filter independently (e.g., UCDP data covers different time ranges than ACLED)
3. The proto already defines three separate RPCs
4. Each upstream API has different auth requirements and pagination patterns

```typescript
// api/server/worldmonitor/conflict/v1/handler.ts
import type {
  ConflictServiceHandler,
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
  GetHumanitarianSummaryRequest,
  GetHumanitarianSummaryResponse,
  HumanitarianCountrySummary,
} from '../../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

export const conflictHandler: ConflictServiceHandler = {
  async listAcledEvents(_ctx, req) { /* ... */ },
  async listUcdpEvents(_ctx, req) { /* ... */ },
  async getHumanitarianSummary(_ctx, req) { /* ... */ },
};
```

### Pattern 2: UCDP Version Discovery (from legacy `api/ucdp-events.js`)
**What:** Dynamically discovers the correct UCDP GED API version by trying year-based candidates.
**When to use:** For `listUcdpEvents` RPC.
**Key insight:** The UCDP API versions follow a `{year}.1` pattern (e.g., `26.1`, `25.1`). The version may change annually. The legacy code builds candidate list `[{year}.1, {year-1}.1, '25.1', '24.1']` and tries each until one returns valid data.

```typescript
function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([
    `${year}.1`,
    `${year - 1}.1`,
    '25.1',
    '24.1',
  ]));
}

async function discoverGedVersion(): Promise<{ version: string; page0: any }> {
  const candidates = buildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await fetchGedPage(version, 0);
      if (Array.isArray(page0?.Result)) return { version, page0 };
    } catch { /* try next */ }
  }
  throw new Error('Unable to discover UCDP GED API version');
}
```

### Pattern 3: UCDP Paginated Fetching with Trailing Window
**What:** Fetches UCDP events from the newest pages backward, stopping when events fall outside a 1-year trailing window.
**When to use:** For `listUcdpEvents` RPC.
**Key insight:** The UCDP GED API has hundreds of pages ordered oldest-to-newest. The legacy code (`api/ucdp-events.js`) fetches from the last page backward (up to `MAX_PAGES = 12`) and filters events within a 365-day trailing window from the newest event date. This efficiently fetches only recent events without reading the entire dataset.

```typescript
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 12;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

// Start from newest page, walk backward
for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
  const page = newestPage - offset;
  const rawData = await fetchGedPage(version, page);
  // ... accumulate events, check trailing window cutoff
}
```

### Pattern 4: HAPI Humanitarian API with Country Aggregation
**What:** Fetches HAPI conflict event data and aggregates by country (keeping most recent month per country).
**When to use:** For `getHumanitarianSummary` RPC.
**Key insight:** The HAPI API returns per-country, per-event-type, per-month records. The legacy code (`api/hapi.js`) aggregates across event types for the most recent month per country. The proto `GetHumanitarianSummaryRequest` takes a `country_code` (ISO-2), so the handler can filter to a single country rather than fetching all. However, the HAPI API uses ISO-3 codes, requiring ISO-2 to ISO-3 mapping in the handler.

### Pattern 5: Service Module with Multiple Client Calls
**What:** Service module wraps `ConflictServiceClient` and exposes functions matching legacy API surfaces.
**When to use:** For the service module in Plan 02.
**Key insight:** Unlike previous migrations where the service module called ONE client method, the conflict service module calls THREE client methods and must orchestrate responses. It also hosts the `deduplicateAgainstAcled` logic (which needs both ACLED and UCDP data) and the `correlateConflictImpact` function (moved from `conflict-impact.ts`).

### Anti-Patterns to Avoid
- **Merging all three upstreams into one RPC:** The data shapes are too different. Keep three RPCs as the proto defines.
- **Server-side ACLED-vs-UCDP deduplication:** The deduplication needs both data sets simultaneously. Since they come from different RPCs, deduplication stays in the service module (client side), not the handler.
- **Hardcoding UCDP API version:** Always use version discovery. The API version changes annually.
- **Deleting `UcdpGeoEvent` from `src/types/index.ts`:** Map components (`DeckGLMap.ts`, `UcdpEventsPanel.ts`, `MapContainer.ts`) import this type directly. Keep it, and the service module maps proto types to it.
- **Deleting `ConflictEvent` from `src/services/conflicts.ts` without providing replacement:** `country-instability.ts` imports `ConflictEvent` type. The new service module must export this type.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UCDP version discovery | Hardcoded version strings | Dynamic version candidate probing (from legacy `api/ucdp-events.js`) | Versions change annually, hardcoding breaks at year boundaries |
| UCDP-ACLED deduplication | New deduplication algorithm | Port existing `deduplicateAgainstAcled` from `src/services/ucdp-events.ts` | Haversine distance + date proximity + fatality ratio matching is well-tuned and tested |
| ISO-2 to ISO-3 country mapping | Custom lookup | Port existing `ISO3_TO_ISO2` maps from legacy services | Already covers all tier-1 countries |
| HAPI per-country aggregation | Custom aggregation | Port existing aggregation logic from `api/hapi.js` | Handles month-based aggregation across event types correctly |
| Circuit breaker wrapping | Custom retry/fallback | Use existing `createCircuitBreaker` from `@/utils` | Established pattern across all service modules |

**Key insight:** This migration ports existing, working logic from legacy files. The value is in the migration to proto-typed interfaces, not in reimagining the algorithms.

## Common Pitfalls

### Pitfall 1: UCDP Violence Type Mapping Mismatch
**What goes wrong:** The legacy `ucdp-events.js` maps UCDP `type_of_violence` integer (1, 2, 3) to string ('state-based', 'non-state', 'one-sided'). The proto uses enum `UcdpViolenceType` ('UCDP_VIOLENCE_TYPE_STATE_BASED', etc.). The handler must map the integer to the proto enum, and the service module must map the proto enum back to the legacy string.
**Why it happens:** Double mapping (API integer -> proto enum -> legacy string) is error-prone.
**How to avoid:** Create explicit mapping functions at both levels. In the handler: `{ 1: 'UCDP_VIOLENCE_TYPE_STATE_BASED', 2: 'UCDP_VIOLENCE_TYPE_NON_STATE', 3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED' }`. In the service module: reverse mapping to legacy strings.
**Warning signs:** Map layer shows wrong violence type icons or colors.

### Pitfall 2: HumanitarianCountrySummary int64 Fields Rendered as Strings
**What goes wrong:** The generated server type for `HumanitarianCountrySummary` has `populationAffected: string`, `peopleInNeed: string`, `internallyDisplaced: string` because these are proto `int64` fields WITHOUT the `INT64_ENCODING_NUMBER` annotation. Only `updatedAt` has the annotation (yielding `number`).
**Why it happens:** Proto `int64` defaults to string encoding in the sebuf TypeScript generator unless annotated.
**How to avoid:** The handler must set these fields as string representations of numbers (e.g., `String(value)`). The service module must parse them back to numbers using `Number()`. Alternatively, add `INT64_ENCODING_NUMBER` to the proto fields and regenerate -- but this requires a proto change.
**Warning signs:** TypeScript type errors if you try to assign a number to a string-typed field.

### Pitfall 3: HAPI API Country Code Mismatch (ISO-3 vs ISO-2)
**What goes wrong:** The `GetHumanitarianSummaryRequest` takes `country_code` as ISO-2 (e.g., "YE"). The HAPI API uses ISO-3 (e.g., "YEM"). The legacy `api/hapi.js` fetches all countries and returns them by ISO-3; the legacy `src/services/hapi.ts` client maps ISO-3 to ISO-2 using a lookup table.
**Why it happens:** Different data sources use different country code standards.
**How to avoid:** In the handler, implement ISO-2 to ISO-3 mapping. Fetch from HAPI using ISO-3, return results mapped to the requested ISO-2 code. Port the existing ISO mapping tables from legacy code.
**Warning signs:** Empty humanitarian summary for a country that should have data.

### Pitfall 4: UCDP Deaths Field Name Discrepancy
**What goes wrong:** The UCDP API returns `best`, `low`, `high` for death counts. The proto uses `deaths_best`, `deaths_low`, `deaths_high` (mapped to camelCase in TS: `deathsBest`, `deathsLow`, `deathsHigh`). The legacy `api/ucdp-events.js` already maps `e.best -> deaths_best`, but the handler must do this mapping explicitly.
**Why it happens:** UCDP API field names differ from proto field names.
**How to avoid:** Map explicitly in the handler: `deathsBest: Number(e.best) || 0`.
**Warning signs:** All death counts show as 0.

### Pitfall 5: Consumer Dependency on Direct Imports (Not Barrel)
**What goes wrong:** Unlike the unrest migration where consumers imported via the barrel (`@/services`), the conflict consumers import directly: `import { fetchConflictEvents } from '@/services/conflicts'`. Updating the barrel alone is insufficient.
**Why it happens:** Legacy conflict services were never re-exported through the barrel.
**How to avoid:** Plan 02 must update ALL direct imports in `App.ts` (lines 30-33) and `country-instability.ts` (lines 5-7) to import from the new `@/services/conflict` module.
**Warning signs:** TypeScript compilation errors after deleting legacy files.

### Pitfall 6: UcdpGeoEvent Shape Compatibility
**What goes wrong:** The legacy `UcdpGeoEvent` in `src/types/index.ts` uses `date_start: string`, `latitude: number`, `longitude: number` (flat fields), `type_of_violence: UcdpEventType` (string union). The proto `UcdpViolenceEvent` uses `dateStart: number` (epoch ms), `location?: GeoCoordinates`, `violenceType: UcdpViolenceType` (enum string). The service module adapter must bridge these completely.
**Why it happens:** Proto uses nested GeoCoordinates and epoch milliseconds; legacy uses flat lat/lon and date strings.
**How to avoid:** The service module must map: `dateStart` (number) -> `date_start` (ISO string), `location.latitude` -> `latitude` (flat), `violenceType` enum -> `type_of_violence` string union. Exhaustive mapping function needed.
**Warning signs:** Map components crash or show events at (0, 0).

## Code Examples

### Handler: listAcledEvents RPC (porting from `api/acled-conflict.js`)
```typescript
// Source: api/acled-conflict.js lines 104-148
// Key differences from unrest handler: event_type filter uses 'Battles|Explosions/Remote violence|Violence against civilians'
// instead of 'Protests'. Field mapping targets AcledConflictEvent proto shape.

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  try {
    const token = process.env.ACLED_ACCESS_TOKEN;
    if (!token) return [];

    const now = Date.now();
    const startMs = req.timeRange?.start ?? (now - 30 * 24 * 60 * 60 * 1000);
    const endMs = req.timeRange?.end ?? now;
    const startDate = new Date(startMs).toISOString().split('T')[0];
    const endDate = new Date(endMs).toISOString().split('T')[0];

    const params = new URLSearchParams({
      event_type: 'Battles|Explosions/Remote violence|Violence against civilians',
      event_date: `${startDate}|${endDate}`,
      event_date_where: 'BETWEEN',
      limit: '500',
      _format: 'json',
    });

    if (req.country) params.set('country', req.country);

    const response = await fetch(`${ACLED_API_URL}?${params}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const rawData = await response.json();
    const events: unknown[] = Array.isArray(rawData?.data) ? rawData.data : [];

    return events
      .filter((e: any) => {
        const lat = parseFloat(e.latitude);
        const lon = parseFloat(e.longitude);
        return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
      })
      .map((e: any): AcledConflictEvent => ({
        id: `acled-${e.event_id_cnty}`,
        eventType: e.event_type || '',
        country: e.country || '',
        location: { latitude: parseFloat(e.latitude), longitude: parseFloat(e.longitude) },
        occurredAt: new Date(e.event_date).getTime(),
        fatalities: parseInt(e.fatalities, 10) || 0,
        actors: [e.actor1, e.actor2].filter(Boolean),
        source: e.source || '',
        admin1: e.admin1 || '',
      }));
  } catch { return []; }
}
```

### Handler: listUcdpEvents RPC (porting from `api/ucdp-events.js`)
```typescript
// Source: api/ucdp-events.js lines 38-206
// Key complexity: version discovery + paginated fetching + trailing window filtering

const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 12;
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceType> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

// Map raw UCDP API events to proto UcdpViolenceEvent
function mapUcdpEvent(e: any): UcdpViolenceEvent {
  return {
    id: String(e.id || ''),
    dateStart: Date.parse(e.date_start) || 0,
    dateEnd: Date.parse(e.date_end) || 0,
    location: { latitude: Number(e.latitude) || 0, longitude: Number(e.longitude) || 0 },
    country: e.country || '',
    sideA: (e.side_a || '').substring(0, 200),
    sideB: (e.side_b || '').substring(0, 200),
    deathsBest: Number(e.best) || 0,
    deathsLow: Number(e.low) || 0,
    deathsHigh: Number(e.high) || 0,
    violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
    sourceOriginal: (e.source_original || '').substring(0, 300),
  };
}
```

### Handler: getHumanitarianSummary RPC (porting from `api/hapi.js`)
```typescript
// Source: api/hapi.js lines 62-116
// Key: HAPI uses ISO-3 codes, proto request uses ISO-2, mapping required

const ISO2_TO_ISO3: Record<string, string> = {
  US: 'USA', RU: 'RUS', CN: 'CHN', UA: 'UKR', IR: 'IRN',
  IL: 'ISR', TW: 'TWN', KP: 'PRK', SA: 'SAU', TR: 'TUR',
  PL: 'POL', DE: 'DEU', FR: 'FRA', GB: 'GBR', IN: 'IND',
  PK: 'PAK', SY: 'SYR', YE: 'YEM', MM: 'MMR', VE: 'VEN',
  // Extend as needed for all countries HAPI covers
  AF: 'AFG', SD: 'SDN', SS: 'SSD', SO: 'SOM', CD: 'COD',
  ET: 'ETH', IQ: 'IRQ', CO: 'COL', NG: 'NGA', PS: 'PSE',
  BR: 'BRA', AE: 'ARE',
};

// NOTE: populationAffected, peopleInNeed, internallyDisplaced are string in generated types (int64 without NUMBER annotation)
function buildHumanitarianSummary(iso2: string, records: any[]): HumanitarianCountrySummary {
  // Aggregate across event types for the most recent month
  // Port aggregation logic from api/hapi.js
  // ...
  return {
    countryCode: iso2,
    countryName: locationName,
    populationAffected: String(0), // int64 -> string in generated types
    peopleInNeed: String(0),
    internallyDisplaced: String(0),
    foodInsecurityLevel: '',
    waterAccessPct: 0,
    updatedAt: Date.now(),
  };
}
```

### Service Module: Adapter Functions (for Plan 02)
```typescript
// Source: src/services/conflict/index.ts
import {
  ConflictServiceClient,
  type AcledConflictEvent as ProtoAcledEvent,
  type UcdpViolenceEvent as ProtoUcdpEvent,
  type HumanitarianCountrySummary as ProtoHumanSummary,
  type UcdpViolenceType,
} from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { createCircuitBreaker } from '@/utils';

// Map proto AcledConflictEvent -> legacy ConflictEvent
function toConflictEvent(proto: ProtoAcledEvent): ConflictEvent {
  return {
    id: proto.id,
    eventType: mapEventType(proto.eventType), // 'Battles' -> 'battle', etc.
    subEventType: '',
    country: proto.country,
    region: proto.admin1,
    location: '',  // Not in proto, empty string
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    time: new Date(proto.occurredAt),
    fatalities: proto.fatalities,
    actors: proto.actors,
    source: proto.source,
  };
}

// Map proto UcdpViolenceEvent -> legacy UcdpGeoEvent
function toUcdpGeoEvent(proto: ProtoUcdpEvent): UcdpGeoEvent {
  return {
    id: proto.id,
    date_start: new Date(proto.dateStart).toISOString().split('T')[0],
    date_end: new Date(proto.dateEnd).toISOString().split('T')[0],
    latitude: proto.location?.latitude ?? 0,
    longitude: proto.location?.longitude ?? 0,
    country: proto.country,
    side_a: proto.sideA,
    side_b: proto.sideB,
    deaths_best: proto.deathsBest,
    deaths_low: proto.deathsLow,
    deaths_high: proto.deathsHigh,
    type_of_violence: mapViolenceType(proto.violenceType),
    source_original: proto.sourceOriginal,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy Vercel edge functions (api/acled-conflict.js, api/ucdp-events.js, api/ucdp.js, api/hapi.js) with Redis caching | Sebuf-generated routes with proto-typed handler | Phase 2K | Proto typing, consistent error handling, sidecar compatibility |
| Client-side ACLED/UCDP deduplication via `deduplicateAgainstAcled` in service module | Same approach (service module), but using proto-typed responses | Phase 2K | Deduplication stays client-side because it needs data from two separate RPCs |
| Four separate legacy service files (conflicts.ts, ucdp.ts, ucdp-events.ts, hapi.ts) | Single service module at src/services/conflict/index.ts | Phase 2K | Consolidated, single import path |
| Direct imports in App.ts (not through barrel) | Service module exported through barrel + direct import path from conflict module | Phase 2K | Cleaner imports |

**Deprecated/outdated:**
- `api/acled-conflict.js` -- replaced by `listAcledEvents` RPC handler
- `api/ucdp-events.js` -- replaced by `listUcdpEvents` RPC handler
- `api/ucdp.js` -- UCDP classifications endpoint; the proto `listUcdpEvents` replaces the geo-events use case. Note: UCDP classifications (war/minor/none per country) is a different data shape than GED events. The `listUcdpEvents` handler serves GED events. The classification data was used by `country-instability.ts` for floor scores. Decision needed: either add a `GetUcdpClassifications` RPC or derive classifications from the events data.
- `api/hapi.js` -- replaced by `getHumanitarianSummary` RPC handler
- `src/services/conflicts.ts` -- replaced by conflict service module
- `src/services/ucdp.ts` -- replaced by conflict service module
- `src/services/ucdp-events.ts` -- replaced by conflict service module
- `src/services/hapi.ts` -- replaced by conflict service module
- `src/services/conflict-impact.ts` -- moved to conflict service module

## Open Questions

1. **UCDP Classifications (api/ucdp.js) -- How to Handle?**
   - What we know: The proto `ConflictService` has `ListUcdpEvents` (GED events) but NOT a `GetUcdpClassifications` RPC. The legacy `api/ucdp.js` fetches from `ucdpapi.pcr.uu.se/api/ucdpprioconflict/{version}` (a DIFFERENT UCDP API endpoint than GED events). The `UcdpConflictStatus` type (intensity: war/minor/none per country) is consumed by `country-instability.ts` for UCDP floor scores.
   - What's unclear: Should the conflict handler fetch classifications data via the existing `listUcdpEvents` infrastructure, or should this data flow through a separate mechanism?
   - Recommendation: **Add a `ListUcdpClassifications` fetch within the `listUcdpEvents` handler** is NOT correct -- that conflates two different data sources. Instead, the service module should derive classification-equivalent data from the GED events: count events per country from the `listUcdpEvents` response and determine intensity (many recent events with high deaths = 'war', some events = 'minor', none = 'none'). This avoids needing a new proto RPC. Alternatively, the UCDP classifications data could remain as a separate legacy endpoint for now and be migrated in a future phase. **Recommended approach: Derive intensity heuristically from GED events in the service module.** The legacy `ucdp.ts` used the PRIO conflict dataset (annual, not event-level), while GED events are granular enough to derive similar classifications.

2. **HAPI API Data Mapping to Proto HumanitarianCountrySummary**
   - What we know: The proto `HumanitarianCountrySummary` has fields like `populationAffected`, `peopleInNeed`, `internallyDisplaced`, `foodInsecurityLevel`, `waterAccessPct`. The HAPI API returns conflict event counts (events, fatalities by type). These are different data shapes.
   - What's unclear: The legacy `api/hapi.js` and `src/services/hapi.ts` only return event counts (eventsTotal, eventsPoliticalViolence, eventsCivilianTargeting, eventsDemonstrations, fatalities). The proto expects a richer humanitarian summary.
   - Recommendation: For Phase 2K, populate the proto fields that can be derived from the HAPI conflict events API. Set `populationAffected`, `peopleInNeed`, `internallyDisplaced`, `foodInsecurityLevel`, `waterAccessPct` to sensible defaults (0 or empty string) unless the HAPI API provides additional endpoints for these. The handler maps the conflict event counts into the best available proxy metrics. The legacy `HapiConflictSummary` type (used by `country-instability.ts`) only used `eventsPoliticalViolence`, `eventsCivilianTargeting`, `eventsDemonstrations`, `fatalitiesTotalPoliticalViolence`, `fatalitiesTotalCivilianTargeting` -- so the service module adapter should expose these fields from what the handler returns.

3. **int64 Fields Without INT64_ENCODING_NUMBER Annotation**
   - What we know: `populationAffected`, `peopleInNeed`, `internallyDisplaced` in `humanitarian_summary.proto` are `int64` without `INT64_ENCODING_NUMBER`. The generated TypeScript types have these as `string`, not `number`.
   - What's unclear: Should the proto be updated to add the annotation?
   - Recommendation: **Update the proto** to add `[(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER]` to these fields, consistent with the project convention in MEMORY.md ("Time fields: Always use int64 (Unix epoch milliseconds)" and "int64 encoding: Use INT64_ENCODING_NUMBER on all time fields so TypeScript gets number not string"). Although these aren't time fields, the same principle applies -- simpler JS interop with `number`. This is a minor proto change that should be done as part of Plan 01. Alternatively, handle string<->number conversion at the handler/service module level, but this is more error-prone.

4. **conflict-impact.ts Disposition**
   - What we know: `src/services/conflict-impact.ts` exports `correlateConflictImpact` which takes `UcdpGeoEvent[]`, `CountryDisplacement[]`, `ClimateAnomaly[]`, `PopulationExposure[]` and produces `ConflictImpactLink[]`. It is NOT imported by any other file (grep confirms only its own definition references it).
   - What's unclear: Is this dead code?
   - Recommendation: Since no file imports `correlateConflictImpact`, this is dead code. Delete it in Plan 02 along with the other legacy files. Do NOT move it to the conflict service module.

## Sources

### Primary (HIGH confidence)
- `proto/worldmonitor/conflict/v1/service.proto` -- Conflict service definition with 3 RPCs, HTTP annotations
- `proto/worldmonitor/conflict/v1/acled_event.proto` -- AcledConflictEvent message definition
- `proto/worldmonitor/conflict/v1/ucdp_event.proto` -- UcdpViolenceEvent message + UcdpViolenceType enum
- `proto/worldmonitor/conflict/v1/humanitarian_summary.proto` -- HumanitarianCountrySummary message
- `proto/worldmonitor/conflict/v1/list_acled_events.proto` -- Request/response with TimeRange, Pagination, country filter
- `proto/worldmonitor/conflict/v1/list_ucdp_events.proto` -- Request/response with TimeRange, Pagination, country filter
- `proto/worldmonitor/conflict/v1/get_humanitarian_summary.proto` -- Request with country_code (validated), response with summary
- `src/generated/server/worldmonitor/conflict/v1/service_server.ts` -- Generated ConflictServiceHandler interface, route creator, types
- `src/generated/client/worldmonitor/conflict/v1/service_client.ts` -- Generated ConflictServiceClient class
- `api/acled-conflict.js` -- Legacy ACLED conflict proxy (battles/explosions/violence)
- `api/ucdp-events.js` -- Legacy UCDP GED events proxy (version discovery, paginated fetch)
- `api/ucdp.js` -- Legacy UCDP PRIO classifications proxy (war/minor/none per country)
- `api/hapi.js` -- Legacy HAPI humanitarian proxy (conflict event counts per country)
- `src/services/conflicts.ts` -- Legacy ACLED conflict client (ConflictEvent type, fetchConflictEvents)
- `src/services/ucdp.ts` -- Legacy UCDP classifications client (UcdpConflictStatus, fetchUcdpClassifications)
- `src/services/ucdp-events.ts` -- Legacy UCDP events client (fetchUcdpEvents, deduplicateAgainstAcled, groupByCountry)
- `src/services/hapi.ts` -- Legacy HAPI client (HapiConflictSummary, fetchHapiSummary)
- `src/services/conflict-impact.ts` -- Conflict impact correlation (dead code -- not imported)
- `src/services/country-instability.ts` -- CII consumer (imports ConflictEvent, UcdpConflictStatus, HapiConflictSummary)
- `src/App.ts` -- Primary consumer (imports fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled)
- `src/types/index.ts` -- UcdpGeoEvent, UcdpEventType types (used by map components)
- `src/components/DeckGLMap.ts`, `MapContainer.ts`, `UcdpEventsPanel.ts` -- Map consumers of UcdpGeoEvent
- `api/server/worldmonitor/unrest/v1/handler.ts` -- Reference handler (dual-upstream pattern)
- `src/services/unrest/index.ts` -- Reference service module (port/adapter pattern)
- `src/services/displacement/index.ts` -- Reference service module (proto-to-legacy mapping)
- `api/[[...path]].ts` -- Gateway catch-all (where to add conflict routes)
- `.planning/phases/2J-unrest-migration/2J-01-PLAN.md` -- Reference plan for handler pattern
- `.planning/phases/2J-unrest-migration/2J-02-PLAN.md` -- Reference plan for service module pattern

### Secondary (MEDIUM confidence)
- `src/services/index.ts` -- Services barrel; conflict services NOT re-exported (direct imports used instead)

### Tertiary (LOW confidence)
- (none)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies, all infrastructure exists and is well-documented by 8 prior migration phases
- Architecture: HIGH - 3-RPC handler + service module follows established pattern verified across 8 previous phases; proto definitions are complete and generated code exists
- Pitfalls: HIGH - All pitfalls identified from direct codebase analysis (field name mismatches, type shape differences, import patterns, ISO code mappings)

**Research date:** 2026-02-19
**Valid until:** 2026-03-19 (stable -- all upstream APIs are long-lived government/academic data sources)
