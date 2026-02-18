---
phase: 2C-seismology-migration
verified: 2026-02-18T15:45:00Z
status: passed
score: 12/12 must-haves verified
re_verification: false
gaps: []
human_verification:
  - test: "Load the app in a browser, observe the earthquake layer on the map"
    expected: "Earthquake circles appear on SVG and DeckGL map, popup shows depth in km, coordinates, time ago, and USGS link"
    why_human: "Visual rendering and popup UX cannot be verified by static analysis"
  - test: "Toggle time range filter while earthquakes are visible"
    expected: "Earthquake layer filters correctly based on occurredAt (number epoch ms) in both Map.ts inline filter and DeckGLMap filterByTime"
    why_human: "Runtime behavior of time filtering with the new number type requires a live browser session"
---

# Phase 2C: Seismology Migration Verification Report

**Phase Goal:** First end-to-end domain migration -- enable INT64_ENCODING_NUMBER project-wide, wire frontend to generated SeismologyServiceClient via port/adapter pattern, adapt components to proto types, delete legacy endpoint
**Verified:** 2026-02-18T15:45:00Z
**Status:** PASSED
**Re-verification:** No -- initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | All int64 time fields (suffix _at) generate as TypeScript `number`, not `string` | VERIFIED | `detectedAt: number` in wildfire client, `publishedAt: number` in news client, `occurredAt: number` in seismology client |
| 2 | Non-time int64 fields (population counts, etc.) NOT annotated | VERIFIED | Grep for INT64_ENCODING_NUMBER shows only temporal fields; displacement/humanitarian counts absent |
| 3 | Seismology handler compiles without type errors after occurredAt becomes number | VERIFIED | `occurredAt: f.properties.time` (no `String()` wrapper); handler confirmed clean |
| 4 | Frontend calls SeismologyServiceClient via adapter instead of legacy fetch | VERIFIED | `earthquakes.ts` instantiates `new SeismologyServiceClient('')` and calls `client.listEarthquakes()` |
| 5 | Earthquake data wired to all map implementations using proto field names | VERIFIED | `DeckGLMap.ts` uses `location?.longitude ?? 0`, `location?.latitude ?? 0`; `Map.ts` uses same pattern |
| 6 | Earthquake popup shows correct depth, coordinates, time, and USGS link | VERIFIED | `MapPopup.ts` uses `earthquake.depthKm`, `earthquake.occurredAt`, `earthquake.sourceUrl`, `earthquake.location?.latitude` |
| 7 | Geo-convergence ingestion works with proto earthquake types | VERIFIED | `geo-convergence.ts` calls `ingestGeoEvent(q.location?.latitude ?? 0, q.location?.longitude ?? 0, 'earthquake', new Date(q.occurredAt))` |
| 8 | Legacy api/earthquakes.js is deleted | VERIFIED | `ls api/earthquakes.js` returns "DELETED" |
| 9 | Vite proxy for /api/earthquake is removed | VERIFIED | No matches for `/api/earthquake` in `vite.config.ts` |
| 10 | No code imports Earthquake from @/types in migrated files | VERIFIED | All 7 consuming files import `Earthquake` from `@/services/earthquakes`; zero hits for `from '@/types'` with earthquake in migrated set |
| 11 | ~34 int64 time fields annotated with INT64_ENCODING_NUMBER across 20+ proto files | VERIFIED | 35 annotations confirmed across 20 domain proto files (excludes vendored annotations.proto) |
| 12 | API_URLS.earthquakes config entry removed | VERIFIED | No `earthquakes` key in `src/config/variants/base.ts` |

**Score:** 12/12 truths verified

---

## Required Artifacts

### Plan 2C-01 Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/seismology/v1/earthquake.proto` | INT64_ENCODING_NUMBER on occurred_at | VERIFIED | Line 26: `int64 occurred_at = 6 [(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER]` |
| `src/generated/client/worldmonitor/seismology/v1/service_client.ts` | occurredAt: number | VERIFIED | Line 31: `occurredAt: number;` |
| `api/server/worldmonitor/seismology/v1/handler.ts` | occurredAt returned as number, no String() | VERIFIED | `occurredAt: f.properties.time` -- no String() wrapper |
| `proto/sebuf/http/annotations.proto` | Vendored Int64Encoding extension (50010) | VERIFIED | File exists; contains `Int64Encoding` enum with `INT64_ENCODING_NUMBER = 2` at extension 50010 |

### Plan 2C-02 Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/services/earthquakes.ts` | Port/adapter wrapping SeismologyServiceClient | VERIFIED | Imports `SeismologyServiceClient`, instantiates with `''`, calls `client.listEarthquakes()`, re-exports `Earthquake` type |
| `src/App.ts` | loadNatural() calling fetchEarthquakes() | VERIFIED | Line 3364: `fetchEarthquakes()` called in Promise.allSettled; earthquakes passed to `setEarthquakes()` and `ingestEarthquakes()` |
| `src/components/DeckGLMap.ts` | Earthquake layer using proto field names (location?.longitude) | VERIFIED | Lines 906, 973, 1422: `location?.longitude ?? 0`, `location?.latitude ?? 0`, `eq.occurredAt` |
| `src/components/MapPopup.ts` | Popup using depthKm, location, occurredAt, sourceUrl | VERIFIED | Lines 636, 649, 653, 660: all four proto fields confirmed |
| `api/earthquakes.js` | DELETED | VERIFIED | File does not exist |
| `vite.config.ts` | /api/earthquake proxy block removed | VERIFIED | No matches for `/api/earthquake` |
| `src/config/variants/base.ts` | API_URLS.earthquakes entry removed | VERIFIED | No `earthquakes` key present |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `proto/seismology/earthquake.proto` | `src/generated/client/.../service_client.ts` | buf generate code generation | VERIFIED | `occurredAt: number` confirmed in generated file |
| `api/server/.../handler.ts` | `src/generated/server/.../service_server.ts` | implements SeismologyServiceHandler | VERIFIED | Handler imports `SeismologyServiceHandler` from generated server; no `String()` wrapper |
| `src/services/earthquakes.ts` | `src/generated/client/.../service_client.ts` | SeismologyServiceClient import and instantiation | VERIFIED | `import { SeismologyServiceClient }` + `new SeismologyServiceClient('')` confirmed |
| `src/App.ts` | `src/services/earthquakes.ts` | fetchEarthquakes() via @/services barrel | VERIFIED | App.ts imports from `@/services` barrel (line 15); barrel exports `fetchEarthquakes` from `./earthquakes` (line 5 of index.ts) |
| `src/components/DeckGLMap.ts` | `src/generated/client/.../service_client.ts` | Earthquake type import (proto type) | VERIFIED | Imports `Earthquake from '@/services/earthquakes'`; uses `location?.longitude` pattern (line 973, 1422) |
| `src/services/geo-convergence.ts` | `src/generated/client/.../service_client.ts` | Earthquake type for ingestEarthquakes | VERIFIED | Imports `Earthquake from '@/services/earthquakes'`; uses `q.location?.latitude ?? 0`, `new Date(q.occurredAt)` (line 87) |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CLIENT-01 | 2C-01 | TypeScript sebuf clients generated for all 9 domain services | SATISFIED | 35 INT64_ENCODING_NUMBER annotations across 20 protos; generated clients confirmed with `number` time types |
| SERVER-02 | 2C-01 | Handler implementations that proxy requests to upstream external APIs | SATISFIED | `api/server/worldmonitor/seismology/v1/handler.ts` proxies USGS GeoJSON API, returns proto-typed response |
| CLIENT-02 | 2C-02 | Generated clients use relative URLs (/api/v1/...) across Vercel, Vite dev, and Tauri | SATISFIED | `SeismologyServiceClient('')` with empty baseURL; generated client uses path `/api/seismology/v1/list-earthquakes` (relative); baseURL concatenates as `'' + path` = relative URL |
| CLIENT-04 | 2C-02 | Generated client response types align with existing TypeScript interfaces used by components | SATISFIED | All 7 consuming files use proto `Earthquake` type imported from port; no type errors (tsc passes per SUMMARY) |
| CLEAN-01 | 2C-02 | Legacy service files deleted after verified parity | SATISFIED | `api/earthquakes.js` confirmed deleted; `src/services/earthquakes.ts` fully replaced with adapter |
| CLEAN-02 | 2C-02 | Legacy api/*.js Vercel edge functions removed after catch-all handler covers their functionality | SATISFIED | `api/earthquakes.js` deleted; catch-all gateway at `api/[[...path]].ts` handles seismology via sebuf handler |

**Traceability Note:** REQUIREMENTS.md traceability table lists CLIENT-02, CLIENT-04, CLEAN-01, CLEAN-02 as "Phase 3" or "Phase 8" -- but these IDs are claimed in the 2C-02 plan frontmatter and verified as satisfied by 2C work. The traceability table appears to have been pre-populated with future-phase assignments before 2C advanced them. This is an annotation discrepancy in the table, not a gap in implementation.

**Orphaned requirements check:** No additional requirement IDs map to Phase 2C in REQUIREMENTS.md beyond what the plans claim.

---

## Anti-Patterns Scan

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| None found | -- | -- | -- |

**Summary:** No TODO/FIXME/PLACEHOLDER comments, no empty implementations, no `return null` stubs, no `String()` wrappers on numeric fields found in any key file. The `earthquakes.ts` adapter is substantive (14 lines, real client wiring). The handler proxies a live external API.

---

## Spot-Check: Non-Time int64 Fields

Confirmed NOT annotated (correct behavior):
- `refugees`, `asylum_seekers`, `total_displaced`, `population_affected` in humanitarian/displacement protos -- these are population counts, not timestamps. Remain as `string` encoding (JavaScript-safe for large values).

---

## Human Verification Required

### 1. Earthquake Layer Visual Rendering

**Test:** Open the app in a browser, enable the Natural/Earthquakes layer, observe the map
**Expected:** Earthquake circles appear on both the SVG map (D3 projection) and DeckGL scatterplot; magnitude drives circle size; color indicates severity
**Why human:** Visual rendering correctness, layer toggle behavior, and SVG projection accuracy cannot be verified by static analysis

### 2. Time Range Filtering with Number Epoch

**Test:** With earthquakes visible, toggle between time ranges (e.g., "Last 24h" vs "Last 7d")
**Expected:** Map.ts inline filter (`occurredAt >= Date.now() - getTimeRangeMs()`) and DeckGLMap `filterByTime(this.earthquakes, (eq) => eq.occurredAt)` both correctly filter using the number epoch value
**Why human:** Runtime behavior of the generic `filterByTime` method with number input (goes through `parseTime()`) requires live verification

### 3. Earthquake Popup Content

**Test:** Click an earthquake circle on the map
**Expected:** Popup displays: depth in km (e.g., "12.5 km"), lat/lng coordinates (e.g., "34.12°, -118.23°"), time ago string (e.g., "3 hours ago"), and a working "View on USGS" link
**Why human:** Popup HTML rendering, i18n string formatting, and link correctness require visual inspection

---

## Commit Verification

All three phase commits confirmed present in git log:
- `b154282` -- feat(2C-01): annotate all int64 time fields with INT64_ENCODING_NUMBER
- `624e7f0` -- feat(2C-02): rewrite earthquake adapter to use SeismologyServiceClient and adapt all consumers to proto types
- `a9088bb` -- chore(2C-02): delete legacy earthquake endpoint, remove Vite proxy, clean API_URLS config

---

## Summary

Phase 2C achieved its goal. All 12 observable truths verified against the actual codebase:

1. **INT64_ENCODING_NUMBER is live:** 35 annotations across 20 proto files. Generated TypeScript uses `number` for all time fields -- confirmed in seismology, wildfire, and news generated clients.

2. **Port/adapter pattern is real:** `src/services/earthquakes.ts` is 14 lines of substantive code -- no placeholders, no circuit breaker residue. It imports the generated `SeismologyServiceClient`, instantiates it with an empty baseURL (yielding relative URLs), calls `listEarthquakes()`, and re-exports the proto `Earthquake` type as the port interface.

3. **All 7 consumers adapted:** `App.ts`, `Map.ts`, `DeckGLMap.ts`, `MapPopup.ts`, `MapContainer.ts`, `geo-convergence.ts`, and `map-harness.ts` all import `Earthquake` from `@/services/earthquakes` (the port), not from `@/types`. All use proto field names (`location?.latitude`, `depthKm`, `occurredAt`, `sourceUrl`). No legacy field names (`eq.lat`, `eq.lon`, `eq.depth`, `eq.time`, `eq.url`) remain in any of these files.

4. **Legacy deleted cleanly:** `api/earthquakes.js` gone, Vite proxy gone, `API_URLS.earthquakes` gone. No dangling references in `src/`.

5. **Handler correct:** `occurredAt: f.properties.time` -- the USGS `time` field is already a number (epoch ms), no `String()` wrapper.

Three items flagged for human verification (visual rendering, time filter runtime behavior, popup content) -- these are standard browser tests, not blockers.

---

_Verified: 2026-02-18T15:45:00Z_
_Verifier: Claude (gsd-verifier)_
