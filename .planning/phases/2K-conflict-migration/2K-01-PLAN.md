---
phase: 2K-conflict-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/conflict/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements:
  - DOMAIN-07
  - SERVER-02

must_haves:
  truths:
    - "POST /api/conflict/v1/list-acled-events returns JSON with events array containing id, eventType, country, location (lat/lon), occurredAt, fatalities, actors, source, admin1 fields"
    - "Handler fetches from ACLED API (Battles|Explosions/Remote violence|Violence against civilians event_types) using Bearer token from ACLED_ACCESS_TOKEN env var"
    - "When ACLED_ACCESS_TOKEN is missing, listAcledEvents returns empty events (graceful degradation, no error thrown)"
    - "POST /api/conflict/v1/list-ucdp-events returns JSON with events array containing id, dateStart, dateEnd, location, country, sideA, sideB, deathsBest/Low/High, violenceType, sourceOriginal fields"
    - "listUcdpEvents discovers UCDP GED API version dynamically by probing year-based candidates, then fetches newest pages backward with trailing-window filtering"
    - "POST /api/conflict/v1/get-humanitarian-summary returns JSON with summary object containing countryCode, countryName, populationAffected, peopleInNeed, internallyDisplaced, foodInsecurityLevel, waterAccessPct, updatedAt fields"
    - "getHumanitarianSummary maps ISO-2 country code to ISO-3 for the HAPI API query, then maps results back to proto shape"
    - "All three RPCs return empty/default responses on upstream failure (graceful degradation)"
  artifacts:
    - path: "api/server/worldmonitor/conflict/v1/handler.ts"
      provides: "ConflictServiceHandler with listAcledEvents, listUcdpEvents, getHumanitarianSummary RPCs"
      exports: ["conflictHandler"]
    - path: "api/[[...path]].ts"
      provides: "Conflict routes mounted in catch-all gateway"
      contains: "createConflictServiceRoutes"
  key_links:
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/conflict/v1/handler.ts"
      via: "import conflictHandler"
      pattern: "import.*conflictHandler.*from.*handler"
    - from: "api/server/worldmonitor/conflict/v1/handler.ts"
      to: "src/generated/server/worldmonitor/conflict/v1/service_server.ts"
      via: "implements ConflictServiceHandler interface"
      pattern: "ConflictServiceHandler"
---

<objective>
Implement the conflict domain handler with 3 RPCs (listAcledEvents, listUcdpEvents, getHumanitarianSummary) that proxy three distinct upstream APIs, then mount routes in the catch-all gateway.

Purpose: Server-side consolidation of four legacy data flows (api/acled-conflict.js ACLED conflict proxy, api/ucdp-events.js UCDP GED events proxy, api/ucdp.js UCDP classifications proxy, api/hapi.js HAPI humanitarian proxy) into a single proto-typed handler. This is the most complex handler in the migration series due to three RPCs with different upstream APIs, auth methods, and data processing patterns.
Output: Working handler at api/server/worldmonitor/conflict/v1/handler.ts, routes mounted in gateway, sidecar rebuilt.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2K-conflict-migration/2K-RESEARCH.md

# Reference handlers (patterns to follow)
@api/server/worldmonitor/unrest/v1/handler.ts
@api/server/worldmonitor/displacement/v1/handler.ts

# Generated server types (handler interface)
@src/generated/server/worldmonitor/conflict/v1/service_server.ts

# Legacy code to port logic FROM (do NOT modify these files)
@api/acled-conflict.js
@api/ucdp-events.js
@api/hapi.js

# Gateway to modify
@api/[[...path]].ts

# Sidecar build script
@scripts/build-sidecar-sebuf.mjs
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement ConflictServiceHandler with 3 RPCs proxying ACLED, UCDP, and HAPI</name>
  <files>api/server/worldmonitor/conflict/v1/handler.ts</files>
  <action>
Create `api/server/worldmonitor/conflict/v1/handler.ts` implementing the generated `ConflictServiceHandler` interface with 3 RPC methods: `listAcledEvents`, `listUcdpEvents`, `getHumanitarianSummary`.

**Process declaration (edge runtime):**
```typescript
declare const process: { env: Record<string, string | undefined> };
```

**Imports:**
- Types from `../../../../../src/generated/server/worldmonitor/conflict/v1/service_server`: `ConflictServiceHandler`, `ServerContext`, `ListAcledEventsRequest`, `ListAcledEventsResponse`, `AcledConflictEvent`, `ListUcdpEventsRequest`, `ListUcdpEventsResponse`, `UcdpViolenceEvent`, `UcdpViolenceType`, `GetHumanitarianSummaryRequest`, `GetHumanitarianSummaryResponse`, `HumanitarianCountrySummary`

---

**RPC 1: listAcledEvents** -- Port from `api/acled-conflict.js` lines 104-148

Top-level RPC wraps in try/catch returning empty on failure:

```typescript
async listAcledEvents(_ctx: ServerContext, req: ListAcledEventsRequest): Promise<ListAcledEventsResponse> {
  try {
    const events = await fetchAcledConflicts(req);
    return { events, pagination: undefined };
  } catch {
    return { events: [], pagination: undefined };
  }
}
```

**Helper: fetchAcledConflicts(req)** -- Port from `api/acled-conflict.js`
- Constants: `ACLED_API_URL = 'https://acleddata.com/api/acled/read'`
- Access `process.env.ACLED_ACCESS_TOKEN`. If missing, return `[]` (graceful degradation -- do NOT throw).
- Compute date range: `startMs = req.timeRange?.start ?? (Date.now() - 30 * 24 * 60 * 60 * 1000)`, `endMs = req.timeRange?.end ?? Date.now()`. Convert to ISO date strings (`YYYY-MM-DD`) for ACLED query params.
- Build URLSearchParams: `event_type: 'Battles|Explosions/Remote violence|Violence against civilians'`, `event_date: '${startDate}|${endDate}'`, `event_date_where: 'BETWEEN'`, `limit: '500'`, `_format: 'json'`. If `req.country` is non-empty, add `country: req.country`.
- Fetch with `{ headers: { Accept: 'application/json', Authorization: 'Bearer ${token}' }, signal: AbortSignal.timeout(15000) }`.
- If `!response.ok`, return `[]`.
- Parse JSON. Extract `data` array: `Array.isArray(rawData?.data) ? rawData.data : []`.
- Filter events with valid coordinates (parseFloat, check isFinite, check -90..90 lat, -180..180 lon).
- Map each event to `AcledConflictEvent`:
  - `id`: `'acled-' + e.event_id_cnty`
  - `eventType`: `e.event_type || ''`
  - `country`: `e.country || ''`
  - `location`: `{ latitude: parseFloat(e.latitude), longitude: parseFloat(e.longitude) }`
  - `occurredAt`: `new Date(e.event_date).getTime()`
  - `fatalities`: `parseInt(e.fatalities, 10) || 0`
  - `actors`: `[e.actor1, e.actor2].filter(Boolean)`
  - `source`: `e.source || ''`
  - `admin1`: `e.admin1 || ''`
- Wrap in try/catch, return `[]` on any error.

---

**RPC 2: listUcdpEvents** -- Port from `api/ucdp-events.js` lines 38-206

This is the most complex RPC: version discovery + paginated backward fetch + trailing window.

Top-level RPC wraps in try/catch returning empty on failure:

```typescript
async listUcdpEvents(_ctx: ServerContext, req: ListUcdpEventsRequest): Promise<ListUcdpEventsResponse> {
  try {
    const events = await fetchUcdpGedEvents(req);
    return { events, pagination: undefined };
  } catch {
    return { events: [], pagination: undefined };
  }
}
```

**Constants:**
- `UCDP_PAGE_SIZE = 1000`
- `MAX_PAGES = 12`
- `TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000`

**VIOLENCE_TYPE_MAP** (integer to proto enum):
```typescript
const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceType> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};
```

**Helper: buildVersionCandidates()** -- Port exactly from `api/ucdp-events.js` line 61-68:
```typescript
function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}
```

**Helper: fetchGedPage(version, page)** -- Port from `api/ucdp-events.js` line 71-86:
- URL: `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`
- Fetch with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }`
- If `!response.ok`, throw.
- Return `response.json()`.

**Helper: discoverGedVersion()** -- Port from `api/ucdp-events.js` line 88-101:
- Try each candidate from `buildVersionCandidates()`.
- For each: fetch page 0, check if `Array.isArray(page0?.Result)`.
- Return `{ version, page0 }` on first success.
- Throw if all candidates fail.

**Helper: fetchUcdpGedEvents(req)** -- Port from `api/ucdp-events.js` handler body lines 152-205:
- Call `discoverGedVersion()` to get `{ version, page0 }`.
- `totalPages = Math.max(1, Number(page0?.TotalPages) || 1)`, `newestPage = totalPages - 1`.
- Walk backward from newestPage: `for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++)`.
  - For page 0, reuse `page0`; for others, call `fetchGedPage(version, page)`.
  - Accumulate events from `rawData.Result`.
  - Track `latestDatasetMs` from the first page's max date.
  - Stop when page's max date falls below `latestDatasetMs - TRAILING_WINDOW_MS`.
- Filter events within trailing window.
- Map to `UcdpViolenceEvent`:
  - `id`: `String(e.id || '')`
  - `dateStart`: `Date.parse(e.date_start) || 0`
  - `dateEnd`: `Date.parse(e.date_end) || 0`
  - `location`: `{ latitude: Number(e.latitude) || 0, longitude: Number(e.longitude) || 0 }`
  - `country`: `e.country || ''`
  - `sideA`: `(e.side_a || '').substring(0, 200)`
  - `sideB`: `(e.side_b || '').substring(0, 200)`
  - `deathsBest`: `Number(e.best) || 0` (**CRITICAL: UCDP uses `best` not `deaths_best`**)
  - `deathsLow`: `Number(e.low) || 0`
  - `deathsHigh`: `Number(e.high) || 0`
  - `violenceType`: `VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED'`
  - `sourceOriginal`: `(e.source_original || '').substring(0, 300)`
- If `req.country` is non-empty, filter events to that country only.
- Sort by dateStart descending (newest first).
- Return the array of `UcdpViolenceEvent`.
- Wrap in try/catch, return `[]` on any error.

**Helper: parseDateMs(value)** -- Port from `api/ucdp-events.js`:
```typescript
function parseDateMs(value: unknown): number {
  if (!value) return NaN;
  return Date.parse(String(value));
}
```

**Helper: getMaxDateMs(events)** -- Port from `api/ucdp-events.js`:
- Iterate events, parse `date_start` with `parseDateMs`, track max.

---

**RPC 3: getHumanitarianSummary** -- Port from `api/hapi.js` lines 62-116

Top-level RPC wraps in try/catch returning empty:

```typescript
async getHumanitarianSummary(_ctx: ServerContext, req: GetHumanitarianSummaryRequest): Promise<GetHumanitarianSummaryResponse> {
  try {
    const summary = await fetchHapiSummary(req.countryCode);
    return { summary };
  } catch {
    return { summary: undefined };
  }
}
```

**ISO2_TO_ISO3 mapping** -- Reverse of `src/services/hapi.ts` ISO3_TO_ISO2 plus additional entries:
```typescript
const ISO2_TO_ISO3: Record<string, string> = {
  US: 'USA', RU: 'RUS', CN: 'CHN', UA: 'UKR', IR: 'IRN',
  IL: 'ISR', TW: 'TWN', KP: 'PRK', SA: 'SAU', TR: 'TUR',
  PL: 'POL', DE: 'DEU', FR: 'FRA', GB: 'GBR', IN: 'IND',
  PK: 'PAK', SY: 'SYR', YE: 'YEM', MM: 'MMR', VE: 'VEN',
  AF: 'AFG', SD: 'SDN', SS: 'SSD', SO: 'SOM', CD: 'COD',
  ET: 'ETH', IQ: 'IRQ', CO: 'COL', NG: 'NGA', PS: 'PSE',
  BR: 'BRA', AE: 'ARE',
};
```

**Helper: fetchHapiSummary(countryCode)** -- Port from `api/hapi.js` handler body:
- Build HAPI URL: `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}` where `appId = btoa('worldmonitor:monitor@worldmonitor.app')`.
- Optionally filter by country: if `countryCode` is non-empty, map to ISO-3 via `ISO2_TO_ISO3[countryCode.toUpperCase()]` and append `&location_code=${iso3}` to the URL. If no mapping exists, proceed without country filter (let HAPI return all).
- Fetch with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }`.
- If `!response.ok`, return `undefined`.
- Parse JSON. Get records: `rawData.data || []`.
- Aggregate per country (port exactly from `api/hapi.js` lines 82-108): track `byCountry` map keyed by ISO-3, for each record aggregate `eventsTotal`, `eventsPoliticalViolence`, `eventsCivilianTargeting`, `eventsDemonstrations`, `fatalitiesTotalPoliticalViolence`, `fatalitiesTotalCivilianTargeting`. On newer month, reset counters.
- Build `HumanitarianCountrySummary` from aggregated data. If `countryCode` was provided, pick that country's entry. Otherwise pick the first entry (summary is single-country by design).
  - `countryCode`: the ISO-2 code from the request (or derived from ISO-3)
  - `countryName`: `entry.locationName`
  - `populationAffected`: `String(entry.eventsTotal)` (**NOTE: int64 field is `string` type in generated code**)
  - `peopleInNeed`: `String(entry.eventsPoliticalViolence + entry.eventsCivilianTargeting)`
  - `internallyDisplaced`: `String(0)` (HAPI conflict events endpoint does not provide displacement data)
  - `foodInsecurityLevel`: `''` (not available from this endpoint)
  - `waterAccessPct`: `0` (not available from this endpoint)
  - `updatedAt`: `Date.now()`
- Wrap in try/catch, return `undefined` on any error.

**Export:** `export const conflictHandler: ConflictServiceHandler = { ... }`

**All helpers are individually wrapped in try/catch returning empty on error.** The top-level RPCs also have try/catch for safety. No error logging on upstream failures (following established 2F-01 pattern).
  </action>
  <verify>
Run `npx tsc --noEmit -p tsconfig.api.json` -- must pass with no type errors in the handler file. Verify the file exists at the expected path.
  </verify>
  <done>Handler file implements ConflictServiceHandler with 3 RPCs. listAcledEvents proxies ACLED API for battles/explosions/violence with Bearer auth from env var. listUcdpEvents discovers UCDP GED API version dynamically, fetches newest pages backward with 365-day trailing window. getHumanitarianSummary proxies HAPI API with ISO-2 to ISO-3 country code mapping. All RPCs have graceful degradation returning empty on failure.</done>
</task>

<task type="auto">
  <name>Task 2: Mount conflict routes in gateway and rebuild sidecar</name>
  <files>api/[[...path]].ts</files>
  <action>
**Gateway wiring** -- Add conflict to the catch-all gateway (`api/[[...path]].ts`):

1. Add import for route creator (after the unrest import):
   ```typescript
   import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
   ```

2. Add import for handler (after the unrestHandler import):
   ```typescript
   import { conflictHandler } from './server/worldmonitor/conflict/v1/handler';
   ```

3. Add to `allRoutes` array (after the unrest spread):
   ```typescript
   ...createConflictServiceRoutes(conflictHandler, serverOptions),
   ```

**Sidecar rebuild:**
Run `npm run build:sidecar-sebuf` to compile the updated gateway into the sidecar bundle. This ensures Tauri desktop app includes conflict routes.

**Verification:**
Run `npx tsc --noEmit -p tsconfig.api.json` to confirm all imports resolve and types align.
  </action>
  <verify>
1. `npx tsc --noEmit -p tsconfig.api.json` passes
2. `npm run build:sidecar-sebuf` succeeds with no errors
3. `grep -c 'createConflictServiceRoutes' api/[[...path]].ts` returns 1
  </verify>
  <done>Conflict routes mounted in catch-all gateway. Sidecar bundle rebuilt with conflict endpoints included. Three RPCs routable at POST /api/conflict/v1/list-acled-events, /api/conflict/v1/list-ucdp-events, /api/conflict/v1/get-humanitarian-summary.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit -p tsconfig.api.json` -- zero errors
2. `npm run build:sidecar-sebuf` -- successful build
3. Handler exports `conflictHandler` implementing `ConflictServiceHandler`
4. Gateway imports and mounts conflict routes
5. RPC paths /api/conflict/v1/list-acled-events, /api/conflict/v1/list-ucdp-events, /api/conflict/v1/get-humanitarian-summary reachable through the gateway router
</verification>

<success_criteria>
- ConflictServiceHandler implementation with 3 RPCs (listAcledEvents, listUcdpEvents, getHumanitarianSummary)
- listAcledEvents proxies ACLED API for battles/explosions/violence with Bearer auth from ACLED_ACCESS_TOKEN env var
- listUcdpEvents discovers UCDP GED version dynamically, fetches backward from newest page, applies 365-day trailing window
- getHumanitarianSummary proxies HAPI API with ISO-2 to ISO-3 mapping, aggregates per-country conflict event counts
- All three RPCs have graceful degradation: empty/default response on upstream failure
- HumanitarianCountrySummary int64 fields (populationAffected, peopleInNeed, internallyDisplaced) set as String() matching generated types
- Routes mounted in catch-all gateway
- Sidecar bundle rebuilt
- TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2K-conflict-migration/2K-01-SUMMARY.md`
</output>
