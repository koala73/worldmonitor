---
phase: 2K-conflict-migration
verified: 2026-02-19T18:45:00Z
status: passed
score: 22/22 must-haves verified
re_verification: false
human_verification:
  - test: "Call POST /api/conflict/v1/list-acled-events with a valid ACLED_ACCESS_TOKEN configured"
    expected: "Response contains events array with id, eventType, country, location, occurredAt, fatalities, actors, source, admin1 fields"
    why_human: "Requires live ACLED API key; automated checks confirm the logic is wired but cannot exercise the upstream path"
  - test: "Call POST /api/conflict/v1/list-ucdp-events"
    expected: "UCDP version discovery succeeds, events returned with dateStart, dateEnd, sideA, sideB, deathsBest, violenceType fields; results sorted newest-first"
    why_human: "Requires live UCDP GED API; dynamic version discovery cannot be exercised without network access"
  - test: "Call POST /api/conflict/v1/get-humanitarian-summary with countryCode=UA"
    expected: "Summary object returned with countryCode, countryName, populationAffected (string), peopleInNeed (string), updatedAt fields"
    why_human: "Requires live HAPI HDX API; ISO-2 to ISO-3 mapping path (UA -> UKR) can only be confirmed with live response"
---

# Phase 2K: Conflict Migration Verification Report

**Phase Goal:** Migrate conflict domain (ACLED armed conflicts + UCDP events + HAPI humanitarian) to sebuf -- implement 3-RPC handler proxying three upstream APIs, create service module with 4-shape port/adapter pattern, rewire all consumers, delete legacy endpoints
**Verified:** 2026-02-19T18:45:00Z
**Status:** PASSED
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | POST /api/conflict/v1/list-acled-events returns JSON with events array containing id, eventType, country, location, occurredAt, fatalities, actors, source, admin1 fields | VERIFIED | handler.ts lines 90-103: full field mapping present; gateway mounts route at that path |
| 2 | Handler fetches from ACLED API using Bearer token from ACLED_ACCESS_TOKEN env var | VERIFIED | handler.ts lines 43-44, 65-68: `process.env.ACLED_ACCESS_TOKEN`; `Authorization: Bearer ${token}` |
| 3 | When ACLED_ACCESS_TOKEN is missing, listAcledEvents returns empty events (graceful degradation) | VERIFIED | handler.ts line 44: `if (!token) return []` |
| 4 | POST /api/conflict/v1/list-ucdp-events returns JSON with events array containing id, dateStart, dateEnd, location, country, sideA, sideB, deathsBest/Low/High, violenceType, sourceOriginal fields | VERIFIED | handler.ts lines 212-228: complete UcdpViolenceEvent mapping |
| 5 | listUcdpEvents discovers UCDP GED API version dynamically by probing year-based candidates, fetches newest pages backward with trailing-window filtering | VERIFIED | handler.ts lines 140-143 (buildVersionCandidates), 159-172 (discoverGedVersion), 183-209 (backward pagination + trailing window) |
| 6 | POST /api/conflict/v1/get-humanitarian-summary returns JSON with summary object containing countryCode, countryName, populationAffected, peopleInNeed, internallyDisplaced, foodInsecurityLevel, waterAccessPct, updatedAt fields | VERIFIED | handler.ts lines 363-373: all fields mapped; String() used for int64 fields |
| 7 | getHumanitarianSummary maps ISO-2 country code to ISO-3 for HAPI API query | VERIFIED | handler.ts lines 248-256 (ISO2_TO_ISO3 map, 32 entries), line 277-279: maps and appends `&location_code=${iso3}` |
| 8 | All three RPCs return empty/default responses on upstream failure (graceful degradation) | VERIFIED | handler.ts lines 387-392, 398-404, 408-416: all RPCs wrapped in try/catch returning empty |
| 9 | Service module exports fetchConflictEvents returning ConflictData with events, byCountry, totalFatalities, count | VERIFIED | conflict/index.ts lines 237-260: full ConflictData returned |
| 10 | Service module exports fetchUcdpClassifications returning Map<string, UcdpConflictStatus> | VERIFIED | conflict/index.ts lines 262-268: heuristic derivation applied, Map returned |
| 11 | Service module exports fetchHapiSummary returning Map<string, HapiConflictSummary> | VERIFIED | conflict/index.ts lines 270-291: Promise.allSettled over 20 tier-1 countries, Map returned |
| 12 | Service module exports fetchUcdpEvents returning UcdpEventsResponse with data: UcdpGeoEvent[] | VERIFIED | conflict/index.ts lines 300-313: `{ success, count, data, cached_at }` shape |
| 13 | Service module exports deduplicateAgainstAcled with haversine + 7-day window + fatality ratio matching | VERIFIED | conflict/index.ts lines 315-347: full port with haversineKm, 7-day window, 50km radius, 0.5-2.0 ratio |
| 14 | Proto AcledConflictEvent mapped to legacy ConflictEvent shape (location.latitude->lat, occurredAt->Date, eventType string->ConflictEventType) | VERIFIED | conflict/index.ts lines 82-97: toConflictEvent adapter complete |
| 15 | Proto UcdpViolenceEvent mapped to legacy UcdpGeoEvent shape | VERIFIED | conflict/index.ts lines 107-123: toUcdpGeoEvent adapter; substring(0,10) for date strings |
| 16 | Proto HumanitarianCountrySummary mapped to legacy HapiConflictSummary shape (string int64 fields -> Number()) | VERIFIED | conflict/index.ts lines 136-150: toHapiSummary adapter; `Number(proto.populationAffected)` |
| 17 | UCDP classifications derived heuristically from GED events | VERIFIED | conflict/index.ts lines 154-206: deaths > 1000 or events > 100 = war, events > 10 = minor, else none |
| 18 | App.ts imports consolidated from 4 direct imports to single @/services/conflict import | VERIFIED | App.ts line 30: single import of 5 functions from `@/services/conflict` |
| 19 | country-instability.ts imports consolidated from 3 direct imports to ./conflict | VERIFIED | country-instability.ts line 5: `import type { ConflictEvent, UcdpConflictStatus, HapiConflictSummary } from './conflict'` |
| 20 | Legacy files deleted: 4 API endpoints (acled-conflict.js, ucdp-events.js, ucdp.js, hapi.js) | VERIFIED | All 4 files confirmed absent via ls check |
| 21 | Legacy service files deleted: conflicts.ts, ucdp.ts, ucdp-events.ts, hapi.ts, conflict-impact.ts | VERIFIED | All 5 files confirmed absent via ls check |
| 22 | UcdpGeoEvent type preserved in src/types/index.ts | VERIFIED | types/index.ts line 242: `export interface UcdpGeoEvent` |

**Score:** 22/22 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `api/server/worldmonitor/conflict/v1/handler.ts` | ConflictServiceHandler with listAcledEvents, listUcdpEvents, getHumanitarianSummary RPCs | VERIFIED | 418 lines; exports `conflictHandler: ConflictServiceHandler`; all 3 RPCs substantively implemented |
| `api/[[...path]].ts` | Conflict routes mounted in catch-all gateway | VERIFIED | Lines 29-30 import handler + route creator; line 45 spreads conflict routes into allRoutes |
| `src/services/conflict/index.ts` | Port/adapter service module mapping proto types to legacy shapes | VERIFIED | 365 lines; exports 7 functions + 6 types; 3 circuit breakers; 4 adapter functions |
| `src/generated/server/worldmonitor/conflict/v1/service_server.ts` | Generated ConflictServiceHandler interface | VERIFIED | Exists; defines interface with listAcledEvents, listUcdpEvents, getHumanitarianSummary |
| `src/generated/client/worldmonitor/conflict/v1/service_client.ts` | Generated ConflictServiceClient | VERIFIED | Exists; used by conflict/index.ts |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `api/[[...path]].ts` | `api/server/worldmonitor/conflict/v1/handler.ts` | `import conflictHandler` | WIRED | Line 30: `import { conflictHandler } from './server/worldmonitor/conflict/v1/handler'`; used at line 45 |
| `api/[[...path]].ts` | generated service_server | `import createConflictServiceRoutes` | WIRED | Line 29: imported; spread at line 45 with `...createConflictServiceRoutes(conflictHandler, serverOptions)` |
| `api/server/worldmonitor/conflict/v1/handler.ts` | generated service_server | `implements ConflictServiceHandler` | WIRED | Line 382: `export const conflictHandler: ConflictServiceHandler = {...}` |
| `src/services/conflict/index.ts` | generated service_client | `import ConflictServiceClient` | WIRED | Line 2: imported; `new ConflictServiceClient('')` at line 15 |
| `src/services/conflict/index.ts` | `@/utils` | `import createCircuitBreaker` | WIRED | Line 11: imported; 3 breakers instantiated at lines 16-18 |
| `src/App.ts` | `src/services/conflict/index.ts` | `import fetchConflictEvents, fetchUcdpClassifications, fetchHapiSummary, fetchUcdpEvents, deduplicateAgainstAcled` | WIRED | Line 30: single consolidated import confirmed |
| `src/services/country-instability.ts` | `src/services/conflict/index.ts` | `import type ConflictEvent, UcdpConflictStatus, HapiConflictSummary` | WIRED | Line 5: type-only import confirmed |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DOMAIN-07 | 2K-01, 2K-02 | Geopolitical domain proto (ACLED conflicts, UCDP events, HAPI humanitarian) with service RPCs and HTTP annotations | SATISFIED | Proto already existed (prior phase); 2K implements the handler and service module against it. Three RPCs fully implemented in handler.ts. Service module maps all proto types to legacy shapes. |
| SERVER-02 | 2K-01, 2K-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | SATISFIED | handler.ts proxies ACLED (Bearer auth), UCDP GED (version discovery + pagination), and HAPI (ISO mapping + aggregation). All three upstream APIs hit with graceful degradation. |

No orphaned requirements found -- both IDs declared in both plan frontmatters, both satisfied by implementation evidence.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/services/desktop-readiness.ts` | 71-73 | Stale string references to deleted files (`src/services/conflicts.ts`, `api/acled-conflict.js`, `/api/acled-conflict`) in DESKTOP_PARITY_FEATURES metadata | Warning | These are display strings in a UI status panel (ServiceStatusPanel.ts), not import statements. They do not cause runtime errors or TypeScript failures, but they incorrectly describe the desktop readiness status. The `map-layers-core` feature entry still points to deleted paths. |

No stub implementations found. No empty handlers. No console.log-only implementations. No TODO/FIXME/placeholder comments in key files.

### Human Verification Required

#### 1. ACLED Live Path

**Test:** With ACLED_ACCESS_TOKEN configured, call POST /api/conflict/v1/list-acled-events
**Expected:** Response contains events array; each event has id (prefixed `acled-`), eventType, country, location (lat/lon), occurredAt (Unix ms number), fatalities (integer), actors (array), source, admin1
**Why human:** Requires live ACLED API credentials; automated checks confirm logic is wired but cannot exercise upstream

#### 2. UCDP Dynamic Version Discovery

**Test:** Call POST /api/conflict/v1/list-ucdp-events
**Expected:** Handler successfully discovers UCDP GED API version, fetches pages backward from newest, returns events sorted newest-first within 365-day window
**Why human:** Requires live UCDP GED API; version candidate probe (`26.1`, `25.1`, `24.1`) cannot be verified without network

#### 3. HAPI ISO Code Mapping

**Test:** Call POST /api/conflict/v1/get-humanitarian-summary with `{ "countryCode": "UA" }`
**Expected:** Summary returned with countryCode="UA", countryName reflecting Ukraine, populationAffected and peopleInNeed as numeric strings
**Why human:** Requires live HAPI HDX API; ISO-2 to ISO-3 mapping (UA -> UKR) exercises the `&location_code=UKR` filter path

### Gaps Summary

No gaps found. All automated checks pass.

One warning noted: `src/services/desktop-readiness.ts` contains stale string metadata referencing deleted legacy paths. This is not a goal blocker (TypeScript compiles cleanly, runtime behavior unaffected) but represents stale documentation that should be updated in a future cleanup pass.

The phase goal is fully achieved:
- 3-RPC handler implemented at `api/server/worldmonitor/conflict/v1/handler.ts` (418 lines)
- Service module with 4-shape port/adapter at `src/services/conflict/index.ts` (365 lines)
- All consumers rewired (App.ts consolidated from 4 to 1 import; country-instability.ts consolidated from 3 to 1)
- All 9 legacy files deleted (4 API endpoints + 4 service files + 1 dead code)
- Routes mounted in gateway and sidecar rebuilt
- Full project TypeScript compilation passes with zero errors
- All 4 commits (2aa0a50, f4b03ca, 5ba73ae, ac31607) confirmed in git history

---

_Verified: 2026-02-19T18:45:00Z_
_Verifier: Claude (gsd-verifier)_
