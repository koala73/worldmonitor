---
phase: 2J-unrest-migration
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - api/server/worldmonitor/unrest/v1/handler.ts
  - api/[[...path]].ts
autonomous: true
requirements:
  - DOMAIN-07
  - SERVER-02

must_haves:
  truths:
    - "POST /api/unrest/v1/list-unrest-events returns JSON with events array containing id, title, summary, eventType, city, country, region, location, occurredAt, severity, fatalities, sources, sourceType, tags, actors, confidence fields"
    - "Handler fetches from ACLED API (Protests event_type only) using Bearer token from ACLED_ACCESS_TOKEN env var and from GDELT GEO API (no auth) in parallel"
    - "When ACLED_ACCESS_TOKEN is missing, handler returns GDELT events only (graceful degradation, no error thrown)"
    - "Events are deduplicated using 0.5-degree grid + date key, with ACLED preferred over GDELT on collision"
    - "Events are sorted by severity (high first) then recency (newest first)"
    - "Clusters are returned as empty array (future enhancement)"
  artifacts:
    - path: "api/server/worldmonitor/unrest/v1/handler.ts"
      provides: "UnrestServiceHandler with listUnrestEvents RPC"
      exports: ["unrestHandler"]
    - path: "api/[[...path]].ts"
      provides: "Unrest routes mounted in catch-all gateway"
      contains: "createUnrestServiceRoutes"
  key_links:
    - from: "api/[[...path]].ts"
      to: "api/server/worldmonitor/unrest/v1/handler.ts"
      via: "import unrestHandler"
      pattern: "import.*unrestHandler.*from.*handler"
    - from: "api/server/worldmonitor/unrest/v1/handler.ts"
      to: "src/generated/server/worldmonitor/unrest/v1/service_server.ts"
      via: "implements UnrestServiceHandler interface"
      pattern: "UnrestServiceHandler"
---

<objective>
Implement the unrest domain handler with 1 RPC (listUnrestEvents) that proxies ACLED API for protest events and enriches with GDELT GEO data, then mount routes in the catch-all gateway.

Purpose: Server-side consolidation of three legacy data flows (api/acled.js ACLED proxy, api/gdelt-geo.js GDELT proxy, src/services/protests.ts client-side merge/deduplicate) into a single proto-typed handler that returns ready-to-use deduplicated, severity-classified, sorted events.
Output: Working handler at api/server/worldmonitor/unrest/v1/handler.ts, routes mounted in gateway, sidecar rebuilt.
</objective>

<execution_context>
@/Users/sebastienmelki/.claude/get-shit-done/workflows/execute-plan.md
@/Users/sebastienmelki/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/2J-unrest-migration/2J-RESEARCH.md

# Reference handlers (patterns to follow)
@api/server/worldmonitor/prediction/v1/handler.ts
@api/server/worldmonitor/displacement/v1/handler.ts

# Generated server types (handler interface)
@src/generated/server/worldmonitor/unrest/v1/service_server.ts

# Legacy code to port logic FROM (do NOT modify these files)
@api/acled.js
@api/gdelt-geo.js
@src/services/protests.ts

# Gateway to modify
@api/[[...path]].ts

# Sidecar build script
@scripts/build-sidecar-sebuf.mjs
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement UnrestServiceHandler with ACLED + GDELT dual-fetch</name>
  <files>api/server/worldmonitor/unrest/v1/handler.ts</files>
  <action>
Create `api/server/worldmonitor/unrest/v1/handler.ts` implementing the generated `UnrestServiceHandler` interface with 1 RPC method: `listUnrestEvents`.

**Imports:**
- Types from `../../../../../src/generated/server/worldmonitor/unrest/v1/service_server`: `UnrestServiceHandler`, `ServerContext`, `ListUnrestEventsRequest`, `ListUnrestEventsResponse`, `UnrestEvent`, `UnrestEventType`, `UnrestSourceType`, `SeverityLevel`, `ConfidenceLevel`

**Constants:**
- `ACLED_API_URL = 'https://acleddata.com/api/acled/read'`
- `GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo'`

**RPC: listUnrestEvents** -- Dual-fetch from ACLED + GDELT, merge, deduplicate, sort, return

The top-level RPC wraps everything in try/catch returning empty on failure (established graceful degradation pattern):

```typescript
async listUnrestEvents(
  _ctx: ServerContext,
  req: ListUnrestEventsRequest,
): Promise<ListUnrestEventsResponse> {
  try {
    const [acledEvents, gdeltEvents] = await Promise.all([
      fetchAcledProtests(req),
      fetchGdeltEvents(),
    ]);
    const merged = deduplicateEvents([...acledEvents, ...gdeltEvents]);
    const sorted = sortBySeverityAndRecency(merged);
    return { events: sorted, clusters: [], pagination: undefined };
  } catch {
    return { events: [], clusters: [], pagination: undefined };
  }
}
```

**Helper 1: fetchAcledProtests(req)** -- Port from `api/acled.js` + `src/services/protests.ts`
- Access `process.env.ACLED_ACCESS_TOKEN`. If missing, return `[]` (graceful degradation -- do NOT throw).
- Compute date range: `startMs = req.timeRange?.start ?? (Date.now() - 30 * 24 * 60 * 60 * 1000)`, `endMs = req.timeRange?.end ?? Date.now()`. Convert to ISO date strings (`YYYY-MM-DD`) for ACLED query params.
- Build URLSearchParams: `event_type: 'Protests'`, `event_date: '${startDate}|${endDate}'`, `event_date_where: 'BETWEEN'`, `limit: '500'`, `_format: 'json'`. If `req.country` is non-empty, add `country: req.country`.
- Fetch with `{ headers: { Accept: 'application/json', Authorization: 'Bearer ${token}' }, signal: AbortSignal.timeout(15000) }`.
- If `!response.ok`, return `[]`.
- Parse JSON. Extract `data` array: `Array.isArray(rawData?.data) ? rawData.data : []`.
- Filter events with valid coordinates (parseFloat, check isFinite, check -90..90 lat, -180..180 lon). Port exact logic from `src/services/protests.ts` lines 100-103.
- Map each ACLED event to `UnrestEvent`:
  - `id`: `'acled-' + e.event_id_cnty`
  - `title`: `e.notes?.slice(0, 200) || '${e.sub_event_type} in ${e.location}'`
  - `summary`: `typeof e.notes === 'string' ? e.notes.substring(0, 500) : ''`
  - `eventType`: use `mapAcledEventType(e.event_type, e.sub_event_type)` helper
  - `city`: `e.location || ''`
  - `country`: `e.country || ''`
  - `region`: `e.admin1 || ''`
  - `location`: `{ latitude: parseFloat(e.latitude), longitude: parseFloat(e.longitude) }`
  - `occurredAt`: `new Date(e.event_date).getTime()`
  - `severity`: use `classifySeverity(fatalities, e.event_type)` helper
  - `fatalities`: `parseInt(e.fatalities, 10) || 0`
  - `sources`: `[e.source].filter(Boolean)`
  - `sourceType`: `'UNREST_SOURCE_TYPE_ACLED'` (cast as `UnrestSourceType`)
  - `tags`: `e.tags?.split(';').map((t: string) => t.trim()).filter(Boolean) ?? []`
  - `actors`: `[e.actor1, e.actor2].filter(Boolean)`
  - `confidence`: `'CONFIDENCE_LEVEL_HIGH'` (cast as `ConfidenceLevel`)
- Wrap in try/catch, return `[]` on any error.

**Helper 2: fetchGdeltEvents()** -- Port from `api/gdelt-geo.js` + `src/services/protests.ts`
- Build URLSearchParams: `query: 'protest'`, `format: 'geojson'`, `maxrecords: '250'`, `timespan: '7d'`.
- Fetch with `{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }`.
- If `!response.ok`, return `[]`.
- Parse JSON. Extract `features` array: `data?.features || []`.
- Track seen locations with `Set<string>` to skip duplicates by name.
- For each feature:
  - Get `name = feature.properties?.name || ''`. Skip if empty or already seen.
  - Get `count = feature.properties?.count || 1`. Skip if `count < 5` (filter noise, matching legacy `protests.ts` line 177).
  - Get coordinates: `feature.geometry?.coordinates`. Validate array with >= 2 elements. **CRITICAL:** Destructure as `[lon, lat]` (GeoJSON order, NOT lat/lon). Validate both are finite and in valid ranges.
  - Add name to seen set.
  - Derive country: `name.split(',').pop()?.trim() || name`
  - Derive severity: use `classifyGdeltSeverity(count, name)` -- if `count > 100` or name includes 'riot'/'clash' -> HIGH, if `count < 25` -> LOW, else MEDIUM.
  - Derive eventType: use `classifyGdeltEventType(name)` -- if name includes 'riot' -> RIOT, 'strike' -> STRIKE, 'demonstration' -> DEMONSTRATION, else PROTEST.
  - Map to `UnrestEvent`:
    - `id`: `'gdelt-' + lat.toFixed(2) + '-' + lon.toFixed(2) + '-' + Date.now()` (deterministic, no client-side generateId)
    - `title`: `'${name} (${count} reports)'`
    - `summary`: `''`
    - `eventType`: from classifier above
    - `city`: `name.split(',')[0]?.trim() || ''`
    - `country`: from derivation above
    - `region`: `''`
    - `location`: `{ latitude: lat, longitude: lon }`
    - `occurredAt`: `Date.now()`
    - `severity`: from classifier above
    - `fatalities`: `0`
    - `sources`: `['GDELT']`
    - `sourceType`: `'UNREST_SOURCE_TYPE_GDELT'` (cast as `UnrestSourceType`)
    - `tags`: `[]`
    - `actors`: `[]`
    - `confidence`: `count > 20 ? 'CONFIDENCE_LEVEL_HIGH' : 'CONFIDENCE_LEVEL_MEDIUM'` (cast as `ConfidenceLevel`)
- Wrap in try/catch, return `[]` on any error.

**Helper 3: mapAcledEventType(eventType, subEventType)** -- Port from `src/services/protests.ts` line 39-46
- Concatenate and lowercase: `const lower = (eventType + ' ' + subEventType).toLowerCase()`
- if includes 'riot' or 'mob violence' -> `'UNREST_EVENT_TYPE_RIOT'`
- if includes 'strike' -> `'UNREST_EVENT_TYPE_STRIKE'`
- if includes 'demonstration' -> `'UNREST_EVENT_TYPE_DEMONSTRATION'`
- if includes 'protest' -> `'UNREST_EVENT_TYPE_PROTEST'`
- default -> `'UNREST_EVENT_TYPE_CIVIL_UNREST'`

**Helper 4: classifySeverity(fatalities, eventType)** -- Port from `src/services/protests.ts` line 49-53
- if `fatalities > 0 || eventType.toLowerCase().includes('riot')` -> `'SEVERITY_LEVEL_HIGH'`
- if `eventType.toLowerCase().includes('protest')` -> `'SEVERITY_LEVEL_MEDIUM'`
- default -> `'SEVERITY_LEVEL_LOW'`

**Helper 5: classifyGdeltSeverity(count, name)**
- `const lowerName = name.toLowerCase()`
- if `count > 100 || lowerName.includes('riot') || lowerName.includes('clash')` -> `'SEVERITY_LEVEL_HIGH'`
- if `count < 25` -> `'SEVERITY_LEVEL_LOW'`
- default -> `'SEVERITY_LEVEL_MEDIUM'`

**Helper 6: classifyGdeltEventType(name)**
- `const lowerName = name.toLowerCase()`
- if includes 'riot' -> `'UNREST_EVENT_TYPE_RIOT'`
- if includes 'strike' -> `'UNREST_EVENT_TYPE_STRIKE'`
- if includes 'demonstration' -> `'UNREST_EVENT_TYPE_DEMONSTRATION'`
- default -> `'UNREST_EVENT_TYPE_PROTEST'`

**Helper 7: deduplicateEvents(events)** -- Port exact algorithm from `src/services/protests.ts` lines 226-258
- Use `Map<string, UnrestEvent>` keyed by `${latKey}:${lonKey}:${dateKey}` where `latKey = Math.round(lat * 2) / 2`, `lonKey = Math.round(lon * 2) / 2`, `dateKey = new Date(event.occurredAt).toISOString().split('T')[0]`.
- Access lat/lon via `event.location?.latitude ?? 0` and `event.location?.longitude ?? 0`.
- On collision: prefer ACLED over GDELT (check sourceType). Merge sources arrays (unique via Set). When ACLED replaces GDELT, carry over GDELT's sources. When GDELT hits existing ACLED, add GDELT sources to ACLED entry. When both GDELT, combine sources and upgrade confidence to HIGH if 2+ sources.
- Return `Array.from(unique.values())`.

**Helper 8: sortBySeverityAndRecency(events)** -- Port from `src/services/protests.ts` lines 262-273
- `const severityOrder: Record<string, number> = { SEVERITY_LEVEL_HIGH: 0, SEVERITY_LEVEL_MEDIUM: 1, SEVERITY_LEVEL_LOW: 2 }` (plus UNSPECIFIED: 3).
- Sort: first by severity order ascending, then by `occurredAt` descending (newest first).

Export: `export const unrestHandler: UnrestServiceHandler = { ... }`

**All helpers (fetchAcledProtests, fetchGdeltEvents) are each individually wrapped in try/catch returning `[]` on error.** The top-level RPC also has try/catch for safety. No error logging on upstream failures (following established 2F-01 pattern).
  </action>
  <verify>
Run `npx tsc --noEmit -p tsconfig.api.json` -- must pass with no type errors in the handler file. Verify the file exists at the expected path.
  </verify>
  <done>Handler file implements UnrestServiceHandler with listUnrestEvents RPC. ACLED fetches protest events with Bearer auth token from env var, GDELT fetches GeoJSON in parallel. Events are deduplicated using 0.5-degree grid, severity-classified, sorted. Graceful degradation returns empty on missing token or upstream failure.</done>
</task>

<task type="auto">
  <name>Task 2: Mount unrest routes in gateway and rebuild sidecar</name>
  <files>api/[[...path]].ts</files>
  <action>
**Gateway wiring** -- Add unrest to the catch-all gateway (`api/[[...path]].ts`):

1. Add import for route creator (after the research import):
   ```typescript
   import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
   ```

2. Add import for handler (after the researchHandler import):
   ```typescript
   import { unrestHandler } from './server/worldmonitor/unrest/v1/handler';
   ```

3. Add to `allRoutes` array (after the research spread):
   ```typescript
   ...createUnrestServiceRoutes(unrestHandler, serverOptions),
   ```

**Sidecar rebuild:**
Run `npm run build:sidecar-sebuf` to compile the updated gateway into the sidecar bundle. This ensures Tauri desktop app includes unrest routes.

**Verification:**
Run `npx tsc --noEmit -p tsconfig.api.json` to confirm all imports resolve and types align.
  </action>
  <verify>
1. `npx tsc --noEmit -p tsconfig.api.json` passes
2. `npm run build:sidecar-sebuf` succeeds with no errors
3. `grep -c 'createUnrestServiceRoutes' api/[[...path]].ts` returns 1
  </verify>
  <done>Unrest routes mounted in catch-all gateway. Sidecar bundle rebuilt with unrest endpoint included. RPC routable at POST /api/unrest/v1/list-unrest-events.</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit -p tsconfig.api.json` -- zero errors
2. `npm run build:sidecar-sebuf` -- successful build
3. Handler exports `unrestHandler` implementing `UnrestServiceHandler`
4. Gateway imports and mounts unrest routes
5. RPC path /api/unrest/v1/list-unrest-events reachable through the gateway router
</verification>

<success_criteria>
- UnrestServiceHandler implementation with listUnrestEvents RPC
- ACLED proxy fetches protest events with Bearer auth token from ACLED_ACCESS_TOKEN env var
- GDELT GEO proxy fetches protest GeoJSON events (no auth needed)
- Dual-fetch in parallel via Promise.all
- Deduplication uses 0.5-degree grid + date key, preferring ACLED over GDELT on collision
- Severity classification ports exact logic from legacy protests.ts
- Event type mapping ports exact logic from legacy protests.ts
- Graceful degradation: empty array when token missing or upstream fails
- Clusters returned as empty array (future enhancement)
- Routes mounted in catch-all gateway
- Sidecar bundle rebuilt
- TypeScript compilation passes
</success_criteria>

<output>
After completion, create `.planning/phases/2J-unrest-migration/2J-01-SUMMARY.md`
</output>
