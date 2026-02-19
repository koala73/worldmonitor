---
phase: 2K-conflict-migration
plan: 01
subsystem: api
tags: [acled, ucdp, hapi, conflict, humanitarian, handler, sebuf]

# Dependency graph
requires:
  - phase: 2B-server-infra
    provides: Gateway router, CORS, error-mapper, sidecar build
provides:
  - ConflictServiceHandler with 3 RPCs (listAcledEvents, listUcdpEvents, getHumanitarianSummary)
  - Conflict routes mounted in catch-all gateway
  - Sidecar bundle rebuilt with conflict endpoints
affects: [2K-02-conflict-consumer-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [three-rpc-handler, ucdp-version-discovery, trailing-window-pagination, iso-code-mapping]

key-files:
  created:
    - api/server/worldmonitor/conflict/v1/handler.ts
  modified:
    - api/[[...path]].ts

key-decisions:
  - "declare const process for edge runtime env access (matching wildfire/unrest handler pattern)"
  - "UCDP version discovery probes year-based candidates dynamically (no hardcoding)"
  - "HAPI humanitarian data maps ISO-2 to ISO-3 via lookup table for API query"
  - "populationAffected/peopleInNeed set as String() matching generated int64 types without INT64_ENCODING_NUMBER"
  - "No error logging on upstream failures following established 2F-01 pattern"

patterns-established:
  - "Three-RPC handler: single handler file implementing 3 independent RPCs proxying different upstream APIs"
  - "UCDP trailing window: fetch newest pages backward, stop when events fall outside 365-day window"

requirements-completed: [DOMAIN-07, SERVER-02]

# Metrics
duration: 2min
completed: 2026-02-19
---

# Phase 2K Plan 01: Conflict Handler Summary

**Three-RPC ConflictServiceHandler proxying ACLED (armed conflicts with Bearer auth), UCDP GED (version discovery + paginated backward fetch with 365-day trailing window), and HAPI (humanitarian conflict events with ISO-2/ISO-3 mapping)**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T18:16:33Z
- **Completed:** 2026-02-19T18:19:15Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Implemented ConflictServiceHandler with 3 RPCs: listAcledEvents, listUcdpEvents, getHumanitarianSummary
- ACLED RPC proxies acleddata.com with Bearer auth from ACLED_ACCESS_TOKEN env var, filtering battles/explosions/violence
- UCDP RPC discovers GED API version dynamically, fetches newest pages backward with 365-day trailing window
- HAPI RPC proxies hapi.humdata.org with ISO-2 to ISO-3 country code mapping, aggregates conflict event counts per country
- All 3 RPCs have graceful degradation returning empty/default on upstream failure
- Conflict routes mounted in catch-all gateway, sidecar rebuilt

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement ConflictServiceHandler with 3 RPCs** - `2aa0a50` (feat)
2. **Task 2: Mount conflict routes in gateway and rebuild sidecar** - `f4b03ca` (feat)

## Files Created/Modified
- `api/server/worldmonitor/conflict/v1/handler.ts` - ConflictServiceHandler with listAcledEvents, listUcdpEvents, getHumanitarianSummary RPCs
- `api/[[...path]].ts` - Added conflict route imports and spread into allRoutes array

## Decisions Made
- Used `declare const process` for edge runtime env access (matching wildfire/unrest handler pattern)
- UCDP version discovery probes `[{year}.1, {year-1}.1, '25.1', '24.1']` dynamically -- no hardcoded version
- HAPI ISO-2 to ISO-3 mapping covers 28 tier-1 countries; proceeds without filter if mapping not found
- `populationAffected`, `peopleInNeed`, `internallyDisplaced` set as `String()` matching generated int64 types without `INT64_ENCODING_NUMBER`
- HAPI aggregation ports exactly from `api/hapi.js` lines 82-108: per-country monthly aggregation with newer-month reset
- No error logging on upstream failures following established 2F-01 pattern

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. ACLED_ACCESS_TOKEN is a pre-existing env var.

## Next Phase Readiness
- Handler complete with 3 RPCs ready for consumer wiring in Plan 02
- Service module can wrap ConflictServiceClient to call listAcledEvents, listUcdpEvents, getHumanitarianSummary
- Proto types ready for adapter functions mapping to legacy ConflictEvent, UcdpGeoEvent, HapiConflictSummary shapes

## Self-Check: PASSED

- FOUND: api/server/worldmonitor/conflict/v1/handler.ts
- FOUND: .planning/phases/2K-conflict-migration/2K-01-SUMMARY.md
- FOUND: commit 2aa0a50 (Task 1: handler)
- FOUND: commit f4b03ca (Task 2: gateway + sidecar)

---
*Phase: 2K-conflict-migration*
*Completed: 2026-02-19*
