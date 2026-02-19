---
phase: 2G-displacement-migration
plan: 01
subsystem: api
tags: [unhcr, displacement, refugees, pagination, aggregation, geospatial]

# Dependency graph
requires:
  - phase: 2B-server-infrastructure
    provides: "Gateway router, error mapper, CORS, sidecar bundle pipeline"
  - phase: 2A-domain-protos
    provides: "displacement/v1 proto definitions and generated server types"
provides:
  - "DisplacementServiceHandler proxying UNHCR Population API with full pagination"
  - "POST /api/displacement/v1/get-displacement-summary endpoint"
  - "Per-country displacement aggregation (origin + asylum perspectives)"
  - "Global displacement totals computation"
  - "Refugee flow corridor building with geographic coordinates"
affects: [2G-displacement-migration]

# Tech tracking
tech-stack:
  added: []
  patterns: ["UNHCR API pagination with year fallback", "dual-perspective country aggregation (origin + asylum)"]

key-files:
  created:
    - api/server/worldmonitor/displacement/v1/handler.ts
  modified:
    - "api/[[...path]].ts"

key-decisions:
  - "Port exact UNHCR pagination logic from legacy unhcr-population.js with 10,000/page limit and 25-page guard"
  - "Year fallback tries current year, then current-1, then current-2 until data found"
  - "All int64 fields returned as String() matching generated DisplacementServiceHandler interface"
  - "Graceful empty response on ANY fetch failure following established 2F-01 pattern"

patterns-established:
  - "Heavy data-processing handler pattern: paginate -> aggregate -> merge -> sort -> limit -> return proto-shaped"

requirements-completed: [DOMAIN-07, SERVER-02]

# Metrics
duration: 2min
completed: 2026-02-19
---

# Phase 2G Plan 01: Displacement Handler Summary

**UNHCR Population API handler with full pagination (250K records), dual-perspective country aggregation, global totals, flow corridors with centroid coordinates, and gateway wiring**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T09:01:52Z
- **Completed:** 2026-02-19T09:03:54Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- DisplacementServiceHandler implemented with UNHCR Population API pagination (10,000 records/page, 25-page guard)
- Per-country displacement aggregation from origin and asylum perspectives with unified merge
- Global totals, flow corridors sorted by refugees, country centroids for geographic coordinates
- Gateway wired with displacement routes alongside seismology, wildfire, climate, prediction
- Sidecar bundle rebuilt (31.0 KB) with displacement included

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement displacement handler** - `a9f365d` (feat)
2. **Task 2: Wire displacement routes into gateway and rebuild sidecar** - `4c80a67` (feat)

## Files Created/Modified
- `api/server/worldmonitor/displacement/v1/handler.ts` - DisplacementServiceHandler implementation with UNHCR API pagination, aggregation, flow computation, and centroid mapping
- `api/[[...path]].ts` - Gateway with displacement routes mounted alongside all other domain services

## Decisions Made
- Ported exact UNHCR pagination logic from legacy `api/unhcr-population.js` with 10,000/page limit and 25-page guard
- Year fallback tries current year, then current-1, then current-2 until data found (matching legacy behavior)
- All int64 fields (refugees, asylumSeekers, idps, stateless, totals) returned as `String()` matching generated interface types
- Graceful empty response on ANY fetch failure following established 2F-01 pattern (no error logging on external API failures)
- 40-entry COUNTRY_CENTROIDS map ported exactly from legacy for geographic coordinate lookup

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript errors in wildfire handler detected during type check (9 errors in `api/server/worldmonitor/wildfire/v1/handler.ts`). These are out of scope -- the displacement handler and gateway compile cleanly with zero errors.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Displacement endpoint is fully routable at POST /api/displacement/v1/get-displacement-summary
- Ready for Plan 02: consumer wiring (service module, adapter layer, legacy endpoint deletion)
- Handler returns proto-typed response compatible with generated client

## Self-Check: PASSED

- FOUND: api/server/worldmonitor/displacement/v1/handler.ts
- FOUND: .planning/phases/2G-displacement-migration/2G-01-SUMMARY.md
- FOUND: a9f365d (Task 1 commit)
- FOUND: 4c80a67 (Task 2 commit)

---
*Phase: 2G-displacement-migration*
*Completed: 2026-02-19*
