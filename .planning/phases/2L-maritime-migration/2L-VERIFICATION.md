---
phase: 2L-maritime-migration
verified: 2026-02-20T07:00:00Z
status: passed
score: "12/12 must-haves verified"
re_verification: true
human_verification:
  - test: "Call POST /api/maritime/v1/get-vessel-snapshot with WS_RELAY_URL configured"
    expected: "Response contains snapshot with disruptions and densityZones arrays, each with typed enum values and GeoCoordinates"
    why_human: "Requires live WS relay endpoint; automated checks confirm logic is wired but cannot exercise upstream AIS path"
  - test: "Call POST /api/maritime/v1/list-navigational-warnings"
    expected: "Response contains warnings array from NGA MSI API with id, title, text, area, issuedAt fields; area filter works"
    why_human: "Requires live NGA MSI API; military date parsing can only be confirmed with real NGA response data"
---

# Phase 2L: Maritime Migration Verification Report

**Phase Goal:** Migrate maritime domain (AIS vessel snapshot + NGA navigational warnings) to sebuf -- implement 2-RPC handler proxying WS relay for AIS data and NGA MSI API for navigational warnings, create service module with port/adapter pattern preserving polling/callback architecture and hybrid fetch strategy (proto RPC for snapshot, raw relay for candidateReports), rewire cable-activity and all consumers, delete legacy endpoints
**Verified:** 2026-02-20T07:00:00Z
**Status:** PASSED
**Re-verification:** Yes -- retroactive verification from 2L-01-SUMMARY.md and 2L-02-SUMMARY.md evidence + direct code inspection

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | POST /api/maritime/v1/get-vessel-snapshot returns JSON with snapshot containing disruptions and densityZones arrays | VERIFIED | handler.ts lines 77-111: densityZones and disruptions arrays mapped from upstream data; lines 107-111: returned as `{ snapshot: { snapshotAt, densityZones, disruptions } }` |
| 2 | Handler proxies WS relay for AIS data with wss->https URL conversion and Railway/localhost fallback chain | VERIFIED | handler.ts lines 37-44: getRelayBaseUrl() converts wss:// to https:// and strips trailing slash; maritime/index.ts lines 134-139: RAILWAY_SNAPSHOT_URL and LOCAL_SNAPSHOT_FALLBACK for raw relay path |
| 3 | POST /api/maritime/v1/list-navigational-warnings returns JSON with warnings array from NGA MSI API | VERIFIED | handler.ts lines 140-176: fetchNgaWarnings() fetches from NGA_WARNINGS_URL, maps to NavigationalWarning[], supports optional area filter |
| 4 | Handler parses NGA military date format (DDHHmmZ MMM YYYY) correctly | VERIFIED | handler.ts lines 123-138: parseNgaDate() with regex `/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i`, month lookup table, Date.UTC construction |
| 5 | Maritime service module preserves polling/callback architecture for live vessel tracking | VERIFIED | maritime/index.ts lines 106-113: positionCallbacks Set + lastCallbackTimestampByMmsi Map; lines 287-325: pollSnapshot() with interval-based polling at SNAPSHOT_POLL_INTERVAL_MS (10s); lines 327-334: startPolling(); lines 338-348: registerAisCallback/unregisterAisCallback |
| 6 | Service module implements hybrid fetch strategy (proto RPC for snapshot data, raw relay for candidateReports) | VERIFIED | maritime/index.ts lines 193-221: fetchSnapshotPayload() uses proto client.getVesselSnapshot({}) when includeCandidates=false, falls back to fetchRawRelaySnapshot(true) when candidates needed |
| 7 | Proto-to-legacy type mapping implemented for AisDisruptionEvent and AisDensityZone | VERIFIED | maritime/index.ts lines 15-41: toDisruptionEvent() with DISRUPTION_TYPE_REVERSE and SEVERITY_REVERSE Record maps, GeoCoordinates to flat lat/lon; lines 43-54: toDensityZone() with GeoCoordinates flattening |
| 8 | cable-activity.ts fetches NGA warnings via proto RPC (MaritimeServiceClient.listNavigationalWarnings) | VERIFIED | cable-activity.ts line 3: `import { MaritimeServiceClient, type NavigationalWarning } from '@/generated/client/worldmonitor/maritime/v1/service_client'`; line 5: client instantiation |
| 9 | All consumer imports rewired from ais.ts to maritime/index.ts | VERIFIED | Grep for `from.*ais` in src/ returns no matches; military-vessels.ts imports from './maritime'; barrel (index.ts) exports from './maritime' |
| 10 | Legacy files deleted (api/ais-snapshot.js, api/nga-warnings.js, src/services/ais.ts) | VERIFIED | All 3 files confirmed absent via ls check (No such file or directory) |
| 11 | Gateway mounts maritime routes; sidecar includes maritime endpoints | VERIFIED | api/[[...path]].ts lines 31-32: imports maritimeHandler and createMaritimeServiceRoutes; line 62: spreads routes into allRoutes. vite.config.ts lines 234-235: imports maritime server and handler modules; line 263: creates maritime routes for dev sidecar |
| 12 | Requirements covered: DOMAIN-06, SERVER-02 | VERIFIED | DOMAIN-06 satisfied by maritime proto definition + handler + service module; SERVER-02 satisfied by handler proxying WS relay and NGA MSI upstream APIs |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `api/server/worldmonitor/maritime/v1/handler.ts` | MaritimeServiceHandler with getVesselSnapshot and listNavigationalWarnings RPCs | VERIFIED | 206 lines; exports `maritimeHandler: MaritimeServiceHandler`; both RPCs substantively implemented with graceful degradation |
| `api/[[...path]].ts` | Maritime routes mounted in catch-all gateway | VERIFIED | Lines 31-32: handler + route creator imported; line 62: maritime routes spread into allRoutes |
| `src/services/maritime/index.ts` | Port/adapter service module with hybrid fetch and polling/callback architecture | VERIFIED | 389 lines; exports 8 functions (isAisConfigured, registerAisCallback, unregisterAisCallback, initAisStream, disconnectAisStream, getAisStatus, fetchAisSignals, AisPositionData type) |
| `src/generated/server/worldmonitor/maritime/v1/service_server.ts` | Generated MaritimeServiceHandler interface | VERIFIED | Exists; defines interface with getVesselSnapshot and listNavigationalWarnings |
| `src/generated/client/worldmonitor/maritime/v1/service_client.ts` | Generated MaritimeServiceClient | VERIFIED | Exists; used by maritime/index.ts and cable-activity.ts |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `api/[[...path]].ts` | `api/server/worldmonitor/maritime/v1/handler.ts` | `import maritimeHandler` | WIRED | Line 32: `import { maritimeHandler } from './server/worldmonitor/maritime/v1/handler'` |
| `api/[[...path]].ts` | generated service_server | `import createMaritimeServiceRoutes` | WIRED | Line 31: imported; spread at line 62 |
| `api/server/worldmonitor/maritime/v1/handler.ts` | generated service_server | `implements MaritimeServiceHandler` | WIRED | Line 182: `export const maritimeHandler: MaritimeServiceHandler = {...}` |
| `src/services/maritime/index.ts` | generated service_client | `import MaritimeServiceClient` | WIRED | Line 2: imported; `new MaritimeServiceClient('')` at line 11 |
| `src/services/cable-activity.ts` | generated service_client | `import MaritimeServiceClient` | WIRED | Line 3: imported; client instantiated at line 5 |
| `src/services/military-vessels.ts` | `src/services/maritime/index.ts` | `import from './maritime'` | WIRED | Import confirmed rewired from ais to maritime |
| `src/services/index.ts` (barrel) | `src/services/maritime/index.ts` | `export * from './maritime'` | WIRED | Barrel re-exports maritime module |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DOMAIN-06 | 2L-01, 2L-02 | Infrastructure domain proto (maritime AIS + NGA warnings) with service RPCs and HTTP annotations | SATISFIED | Proto defines MaritimeService with 2 RPCs; handler proxies WS relay and NGA MSI; service module maps proto to legacy types |
| SERVER-02 | 2L-01, 2L-02 | Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses | SATISFIED | handler.ts proxies WS relay (AIS snapshot) and NGA MSI API (navigational warnings) with graceful degradation |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/services/desktop-readiness.ts` | 72 | Stale string references to deleted files (`src/services/conflicts.ts`, `api/acled-conflict.js`, `/api/acled-conflict`, `src/services/outages.ts`, `api/opensky.js`) in DESKTOP_PARITY_FEATURES metadata for `map-layers-core` entry | Warning | Display strings in UI status panel; do not cause runtime errors but incorrectly describe desktop readiness status |

No stub implementations found. No empty handlers. No console.log-only implementations. No TODO/FIXME/placeholder comments in key files.

### Human Verification Required

#### 1. AIS Vessel Snapshot Live Path

**Test:** With WS_RELAY_URL configured, call POST /api/maritime/v1/get-vessel-snapshot
**Expected:** Response contains snapshot with densityZones array (id, name, location, intensity, deltaPct, shipsPerDay, note) and disruptions array (id, name, type enum, location, severity enum, changePct, windowHours, darkShips, vesselCount, region, description)
**Why human:** Requires live WS relay endpoint; automated checks confirm wss->https conversion logic but cannot verify upstream returns valid AIS data

#### 2. NGA Navigational Warnings Live Path

**Test:** Call POST /api/maritime/v1/list-navigational-warnings (optionally with area filter)
**Expected:** Response contains warnings array; each warning has id (navArea-msgYear-msgNumber format), title, text, area, issuedAt (Unix ms from military date parse), authority fields
**Why human:** Requires live NGA MSI API; military date format parsing (DDHHmmZ MMM YYYY) can only be confirmed end-to-end with real NGA response data

### Gaps Summary

No gaps found. All automated checks pass.

One warning noted: `src/services/desktop-readiness.ts` contains stale string metadata referencing deleted legacy paths for the `map-layers-core` and `market-panel` entries. This is addressed in Phase 4 Plan 01 cleanup (this plan).

The phase goal is fully achieved:
- 2-RPC handler implemented at `api/server/worldmonitor/maritime/v1/handler.ts` (206 lines)
- Service module with hybrid fetch and polling/callback at `src/services/maritime/index.ts` (389 lines)
- cable-activity.ts rewired to MaritimeServiceClient
- All consumer imports rewired from ais.ts to maritime/index.ts
- All 3 legacy files deleted (2 API endpoints + 1 service file)
- Routes mounted in gateway and sidecar
- Full project TypeScript compilation passes
- All 4 commits (cbde258, 7375f25, d8780b7, bbc57d4) confirmed in git history

---

_Verified: 2026-02-20T07:00:00Z_
_Verifier: Claude (gsd-executor, retroactive)_
