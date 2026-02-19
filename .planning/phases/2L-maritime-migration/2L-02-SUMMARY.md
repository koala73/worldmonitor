---
phase: 2L-maritime-migration
plan: 02
subsystem: services
tags: [maritime, ais, vessel-tracking, cable-activity, polling, callback, hybrid-fetch, proto-mapping, service-module]

# Dependency graph
requires:
  - phase: 2L-01
    provides: Maritime handler with getVesselSnapshot and listNavigationalWarnings RPCs
  - phase: 2B-server-infrastructure
    provides: Gateway router, CORS, error-mapper, sidecar build
provides:
  - Maritime service module with full polling/callback architecture and hybrid fetch
  - cable-activity.ts fetching NGA warnings via proto RPC
  - All consumer imports rewired from ais.ts to maritime/index.ts
  - 3 legacy files deleted (api/ais-snapshot.js, api/nga-warnings.js, src/services/ais.ts)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [hybrid-fetch-strategy, proto-to-legacy-type-mapping, polling-callback-preservation]

key-files:
  created:
    - src/services/maritime/index.ts
  modified:
    - src/services/cable-activity.ts
    - src/services/military-vessels.ts
    - src/services/index.ts
    - src/services/desktop-readiness.ts
  deleted:
    - api/ais-snapshot.js
    - api/nga-warnings.js
    - src/services/ais.ts

key-decisions:
  - "Hybrid fetch: proto RPC for snapshot-only (no candidates), raw WS relay for candidates (military vessel tracking)"
  - "Proto-to-legacy mapping done in fetchSnapshotPayload so parseSnapshot receives legacy shapes unchanged"
  - "Removed VERCEL_SNAPSHOT_API strategy since proto RPC replaces that path; Railway+localhost raw relay kept for candidate path"
  - "cable-activity NgaWarning reconstruction: id split for navArea/msgYear/msgNumber, area split for subregion"
  - "formatNgaDate produces military date format (DDHHmmZ MON YYYY) matching parseIssueDate expectations"

patterns-established:
  - "Hybrid fetch: use proto RPC when type-safe path sufficient, fallback to raw HTTP when proto lacks fields"
  - "Proto-to-legacy type mapping before storing in module state, so consumers never see proto types"

requirements-completed: [DOMAIN-06, SERVER-02]

# Metrics
duration: 4min
completed: 2026-02-19
---

# Phase 2L Plan 02: Maritime Service Module Summary

**Maritime service module with hybrid proto/raw fetch, full polling/callback architecture, cable-activity rewired to NGA proto RPC, 3 legacy files deleted**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-19T19:04:56Z
- **Completed:** 2026-02-19T19:08:56Z
- **Tasks:** 2
- **Files modified:** 8 (1 created, 4 modified, 3 deleted)

## Accomplishments
- Maritime service module preserving full polling/callback architecture from legacy ais.ts with hybrid fetch strategy (proto RPC for snapshot-only, raw WS relay for candidate reports)
- Proto-to-legacy type mapping for AisDisruptionEvent (enum reversal + GeoCoordinates flattening) and AisDensityZone (GeoCoordinates flattening)
- cable-activity.ts rewired from /api/nga-warnings fetch to MaritimeServiceClient.listNavigationalWarnings() with NgaWarning shape reconstruction from proto fields
- Consumer imports rewired (military-vessels, barrel, desktop-readiness), 3 legacy files deleted, full TypeScript compilation passes

## Task Commits

Each task was committed atomically:

1. **Task 1: Create maritime service module with hybrid fetch and polling/callback preservation** - `d8780b7` (feat)
2. **Task 2: Rewire cable-activity, military-vessels, barrel, desktop-readiness, and delete legacy files** - `bbc57d4` (feat)

## Files Created/Modified
- `src/services/maritime/index.ts` - Port/adapter service module with polling/callback architecture, hybrid fetch, proto-to-legacy type mapping
- `src/services/cable-activity.ts` - Updated to fetch NGA warnings via MaritimeServiceClient with proto-to-NgaWarning conversion
- `src/services/military-vessels.ts` - Import updated from './ais' to './maritime'
- `src/services/index.ts` - Barrel updated from './ais' to './maritime'
- `src/services/desktop-readiness.ts` - Service/API references updated to maritime handler paths
- `api/ais-snapshot.js` - DELETED (replaced by proto RPC /api/maritime/v1/get-vessel-snapshot)
- `api/nga-warnings.js` - DELETED (replaced by proto RPC /api/maritime/v1/list-navigational-warnings)
- `src/services/ais.ts` - DELETED (replaced by src/services/maritime/index.ts)

## Decisions Made
- Hybrid fetch strategy: proto RPC via MaritimeServiceClient.getVesselSnapshot() for snapshot-only path (density + disruptions), raw WS relay HTTP for candidate reports path (military vessel tracking) because proto VesselSnapshot lacks candidateReports field
- Proto-to-legacy mapping applied in fetchSnapshotPayload so parseSnapshot() receives legacy AisDisruptionEvent/AisDensityZone shapes unchanged -- all downstream code (pollSnapshot, latestDisruptions, latestDensity) works without modification
- Removed VERCEL_SNAPSHOT_API ('/api/ais-snapshot') fetch strategy since proto RPC replaces that path; Railway snapshot URL and localhost fallback kept only for raw candidate reports path
- cable-activity NgaWarning reconstruction: id parsed as "navArea-msgYear-msgNumber" (split from end to handle multi-part navArea), area parsed as "navArea subregion" (space split)
- formatNgaDate produces military date format "DDHHmmZ MON YYYY" that parseIssueDate already knows how to parse, maintaining the existing date pipeline

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Maritime domain migration complete (both handler and service module)
- All 8 functions exported from maritime service module with identical signatures to legacy ais.ts
- Full project TypeScript compilation passes with zero errors
- AisDisruptionEvent/AisDensityZone/AisDisruptionType preserved in src/types/index.ts for map component consumers

## Self-Check: PASSED

- [x] src/services/maritime/index.ts exists
- [x] src/services/ais.ts deleted
- [x] api/ais-snapshot.js deleted
- [x] api/nga-warnings.js deleted
- [x] Commit d8780b7 exists (Task 1)
- [x] Commit bbc57d4 exists (Task 2)

---
*Phase: 2L-maritime-migration*
*Completed: 2026-02-19*
