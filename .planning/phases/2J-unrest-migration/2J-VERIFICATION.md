---
phase: 2J-unrest-migration
verified: 2026-02-19T12:00:00Z
status: passed
score: 13/13 must-haves verified
re_verification: false
---

# Phase 2J: Unrest Migration Verification Report

**Phase Goal:** Migrate unrest domain (ACLED protests/riots/strikes) to sebuf -- implement handler proxying ACLED API with auth token, optional GDELT enrichment, event clustering, severity classification, create service module with port/adapter pattern, rewire all consumers, delete legacy endpoint
**Verified:** 2026-02-19T12:00:00Z
**Status:** PASSED
**Re-verification:** No -- initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | POST /api/unrest/v1/list-unrest-events returns JSON with events array containing id, title, summary, eventType, city, country, region, location, occurredAt, severity, fatalities, sources, sourceType, tags, actors, confidence fields | VERIFIED | Generated server type at service_server.ts line 32 defines ListUnrestEventsResponse with UnrestEvent[] containing all listed fields. Route mounted at exactly that path (service_server.ts line 137). |
| 2 | Handler fetches from ACLED API using Bearer token from ACLED_ACCESS_TOKEN env var and from GDELT GEO API (no auth) in parallel | VERIFIED | handler.ts lines 80-107 (ACLED with Bearer auth), lines 160-172 (GDELT no auth), lines 296-299 use Promise.all for parallel fetch |
| 3 | When ACLED_ACCESS_TOKEN is missing, handler returns GDELT events only (graceful degradation, no error thrown) | VERIFIED | handler.ts line 81: `if (!token) return []` inside fetchAcledProtests. RPC-level try/catch at line 303 returns empty on total failure. |
| 4 | Events are deduplicated using 0.5-degree grid + date key, with ACLED preferred over GDELT on collision | VERIFIED | handler.ts lines 233-268: deduplicateEvents uses `Math.round(lat*2)/2` key, ACLED preference check at line 250-254 |
| 5 | Events are sorted by severity (high first) then recency (newest first) | VERIFIED | handler.ts lines 272-286: sortBySeverityAndRecency with severityOrder map, sorts by sevDiff then `b.occurredAt - a.occurredAt` |
| 6 | Clusters are returned as empty array | VERIFIED | handler.ts line 302: `return { events: sorted, clusters: [], pagination: undefined }` |
| 7 | Service module exports fetchProtestEvents and getProtestStatus with same API surface as legacy protests.ts | VERIFIED | src/services/unrest/index.ts lines 98 and 143 export both functions. App.ts line 16 imports both from @/services barrel, calls them at lines 3655, 3667, 4017, 4032, 4043. |
| 8 | fetchProtestEvents returns ProtestData with events (SocialUnrestEvent[]), byCountry, highSeverityCount, sources | VERIFIED | src/services/unrest/index.ts lines 79-84 define ProtestData interface; lines 98-139 implement return of all four fields |
| 9 | Proto UnrestEvent fields mapped to legacy SocialUnrestEvent shape (location.latitude->lat, occurredAt->Date, SEVERITY_LEVEL_HIGH->'high', etc.) | VERIFIED | toSocialUnrestEvent at lines 54-75: lat/lon from location.latitude/longitude, time: new Date(e.occurredAt), mapSeverity/mapEventType/mapSourceType all present |
| 10 | getProtestStatus infers ACLED configuration from response events | VERIFIED | acledConfigured module-level let at line 88, updated in fetchProtestEvents lines 121-127 based on source counts |
| 11 | Services barrel re-exports from './unrest' instead of './protests' | VERIFIED | src/services/index.ts line 17: `export * from './unrest'` |
| 12 | Legacy files deleted: api/acled.js, api/gdelt-geo.js, src/services/protests.ts | VERIFIED | All three paths return "No such file or directory". No direct import references remain in codebase. |
| 13 | api/acled-conflict.js is NOT deleted (belongs to conflict domain migration) | VERIFIED | File exists at api/acled-conflict.js |

**Score:** 13/13 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `api/server/worldmonitor/unrest/v1/handler.ts` | UnrestServiceHandler with listUnrestEvents RPC | VERIFIED | 308 lines. Exports `unrestHandler`. Implements UnrestServiceHandler. ACLED fetch (lines 78-154), GDELT fetch (lines 158-229), dedup (lines 233-268), sort (lines 272-286), RPC (lines 290-307). |
| `api/[[...path]].ts` | Unrest routes mounted in catch-all gateway | VERIFIED | Lines 27-28: imports `createUnrestServiceRoutes` and `unrestHandler`. Line 42: `...createUnrestServiceRoutes(unrestHandler, serverOptions)` in allRoutes. |
| `src/services/unrest/index.ts` | Port/adapter service module mapping proto UnrestEvent to legacy SocialUnrestEvent | VERIFIED | 146 lines. Exports `fetchProtestEvents`, `getProtestStatus`, `ProtestData`. Full adapter with 4 enum mappers and toSocialUnrestEvent. Circuit breaker wrapped. |
| `src/services/index.ts` | Updated barrel export with unrest replacing protests | VERIFIED | Line 17: `export * from './unrest'` |
| `src/generated/server/worldmonitor/unrest/v1/service_server.ts` | Generated server interface UnrestServiceHandler | VERIFIED | Exports UnrestServiceHandler interface (line 126), ListUnrestEventsRequest/Response, createUnrestServiceRoutes, route at `/api/unrest/v1/list-unrest-events` |
| `src/generated/client/worldmonitor/unrest/v1/service_client.ts` | Generated client UnrestServiceClient | VERIFIED | Exports UnrestServiceClient class (line 119) |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `api/[[...path]].ts` | `api/server/worldmonitor/unrest/v1/handler.ts` | `import unrestHandler` | WIRED | Lines 27-28: imports unrestHandler; line 42: used in allRoutes spread |
| `api/server/worldmonitor/unrest/v1/handler.ts` | `src/generated/server/worldmonitor/unrest/v1/service_server.ts` | `implements UnrestServiceHandler interface` | WIRED | Line 27: type import. Line 290: `export const unrestHandler: UnrestServiceHandler = {...}` |
| `src/services/unrest/index.ts` | `src/generated/client/worldmonitor/unrest/v1/service_client.ts` | `import UnrestServiceClient` | WIRED | Line 2: imports UnrestServiceClient; line 11: `const client = new UnrestServiceClient('')`; line 100: `client.listUnrestEvents(...)` called inside breaker |
| `src/services/unrest/index.ts` | `@/utils` | `import createCircuitBreaker` | WIRED | Line 7: import; line 12: `const unrestBreaker = createCircuitBreaker<ListUnrestEventsResponse>(...)`; line 99: `unrestBreaker.execute(...)` |
| `src/services/index.ts` | `src/services/unrest/index.ts` | barrel re-export | WIRED | Line 17: `export * from './unrest'` -- fetchProtestEvents, getProtestStatus, ProtestData all re-exported |
| `src/App.ts` | `src/services/unrest/index.ts` | via barrel `@/services` | WIRED | App.ts line 16: imports fetchProtestEvents and getProtestStatus from @/services; called at lines 3655, 3667, 4017, 4032, 4043 |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DOMAIN-07 | 2J-01, 2J-02 | Geopolitical domain proto (ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees) with service RPCs and HTTP annotations | SATISFIED | Unrest domain proto types generated (UnrestEvent, UnrestServiceHandler, RPCs). Handler implements the server interface. Route registered at /api/unrest/v1/list-unrest-events. Generated types include all required field shapes. REQUIREMENTS.md marks DOMAIN-07 as Complete. |
| SERVER-02 | 2J-01, 2J-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | SATISFIED | UnrestServiceHandler implementation proxies ACLED API (Protests event_type, Bearer auth) and GDELT GEO API (no auth), returns proto-typed ListUnrestEventsResponse. Graceful degradation on missing token or upstream failure. REQUIREMENTS.md marks SERVER-02 as Complete. |

**No orphaned requirements detected** -- both DOMAIN-07 and SERVER-02 appear in both plans' frontmatter and are fully implemented.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| handler.ts | 302 | `clusters: []` always empty | INFO | Intentional per plan spec: "Clusters returned as empty array (future enhancement, client-side Supercluster handles clustering)" |

No TODOs, FIXMEs, placeholder returns, or stub implementations found.

---

## Commit Verification

All four commits from summaries verified to exist in git history:

| Commit | Plan | Description |
|--------|------|-------------|
| `42a2bfc` | 2J-01 Task 1 | feat(2J-01): implement UnrestServiceHandler with ACLED + GDELT dual-fetch |
| `59898b6` | 2J-01 Task 2 | feat(2J-01): mount unrest routes in gateway and rebuild sidecar |
| `3f63134` | 2J-02 Task 1 | feat(2J-02): create unrest service module with proto-to-legacy type mapping |
| `95a1dbf` | 2J-02 Task 2 | feat(2J-02): update services barrel, remove vite proxies, delete legacy files |

---

## Human Verification Required

### 1. Live ACLED + GDELT dual-fetch integration

**Test:** With ACLED_ACCESS_TOKEN set, POST to /api/unrest/v1/list-unrest-events and inspect the events array.
**Expected:** Events from both ACLED (sourceType: ACLED) and GDELT (sourceType: GDELT) appear, deduplication removes near-duplicate locations, severity ordering is high -> medium -> low.
**Why human:** Cannot execute live HTTP calls against external APIs in static verification.

### 2. Graceful degradation with missing token

**Test:** With ACLED_ACCESS_TOKEN unset, POST to /api/unrest/v1/list-unrest-events.
**Expected:** Response contains GDELT-sourced events only, no error thrown, HTTP 200.
**Why human:** Requires runtime environment manipulation.

### 3. Consumer backward compatibility (App.ts map rendering)

**Test:** Run the app, navigate to the protests/unrest map layer, observe protest markers on the map.
**Expected:** Map markers appear using the new sebuf-backed data, popup data (severity, country, actors, time) renders correctly.
**Why human:** Visual rendering and data pipeline through SocialUnrestEvent -> DeckGLMap -> MapPopup chain requires the browser.

---

## Gaps Summary

No gaps. All 13 observable truths are verified. All artifacts exist, are substantive (not stubs), and are fully wired. Both requirements (DOMAIN-07, SERVER-02) are satisfied. Legacy files deleted. Scope guards respected (api/acled-conflict.js preserved, SocialUnrestEvent preserved in src/types/index.ts).

---

_Verified: 2026-02-19T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
