---
phase: 2D-wildfire-migration
plan: 02
subsystem: frontend
tags: [nasa-firms, wildfire, proto, service-module, consumer-wiring]

# Dependency graph
requires:
  - phase: 2D-wildfire-migration plan 01
    provides: WildfireServiceHandler, gateway wiring, sidecar with wildfire endpoint
  - phase: 2C-seismology-migration plan 02
    provides: Port/adapter pattern for domain service modules
provides:
  - Wildfire service module (src/services/wildfires/index.ts) with fetchAllFires, computeRegionStats, flattenFires, toMapFires
  - All frontend consumers rewired from legacy firms-satellite to proto-backed wildfires service
  - Legacy api/firms-fires.js and src/services/firms-satellite.ts deleted
affects: [future domain migrations, frontend wildfire consumers]

# Tech tracking
tech-stack:
  added: []
  patterns: [directory-per-service module with business logic, MapFire adapter for map layer compatibility, confidenceToNumber enum-to-numeric mapper]

key-files:
  created:
    - src/services/wildfires/index.ts
  modified:
    - src/App.ts
    - src/components/SatelliteFiresPanel.ts
    - src/services/signal-aggregator.ts
  deleted:
    - api/firms-fires.js
    - src/services/firms-satellite.ts

key-decisions:
  - "toMapFires adapter preserves map layer's { lat, lon, brightness, frp, confidence, region, acq_date, daynight } shape without modifying 3 map components"
  - "Empty response heuristic: zero fireDetections treated as skipped (API key missing) matching legacy behavior"
  - "confidenceToNumber maps FIRE_CONFIDENCE_HIGH->95, NOMINAL->50, LOW->20 for map rendering thresholds"

patterns-established:
  - "Directory service module: src/services/wildfires/index.ts with real business logic (region grouping, stats computation)"
  - "MapFire adapter pattern: proto types -> map-compatible shape via toMapFires(), avoids changing shared map component signatures"

requirements-completed: [DOMAIN-01, SERVER-02]

# Metrics
duration: 3min
completed: 2026-02-18
---

# Phase 2D Plan 02: Wildfire Consumer Wiring Summary

**Wildfire service module with region grouping, stats computation, and MapFire adapter, all frontend consumers rewired from legacy firms-satellite to WildfireServiceClient, legacy files deleted**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-18T16:21:44Z
- **Completed:** 2026-02-18T16:24:51Z
- **Tasks:** 2
- **Files modified:** 6 (1 created, 3 modified, 2 deleted)

## Accomplishments
- Created wildfires service module with fetchAllFires, computeRegionStats, flattenFires, and toMapFires functions
- Rewired App.ts, SatelliteFiresPanel.ts, and signal-aggregator.ts to import from @/services/wildfires
- Deleted legacy api/firms-fires.js endpoint and src/services/firms-satellite.ts service
- Full build passes (tsc, vite, sidecar) with zero errors and zero dangling references

## Task Commits

Each task was committed atomically:

1. **Task 1: Create wildfires service module and rewire all consumers** - `46d727a` (feat)
2. **Task 2: Delete legacy wildfire files and rebuild** - `4568030` (chore)

## Files Created/Modified
- `src/services/wildfires/index.ts` - Wildfire service module with fetchAllFires, computeRegionStats, flattenFires, toMapFires, FireRegionStats
- `src/App.ts` - Import rewired from @/services/firms-satellite to @/services/wildfires, proto field mappings for signal aggregator and map layer
- `src/components/SatelliteFiresPanel.ts` - FireRegionStats import rewired to @/services/wildfires
- `src/services/signal-aggregator.ts` - Source comment updated to reference src/services/wildfires
- `api/firms-fires.js` - DELETED (replaced by api/server/worldmonitor/wildfire/v1/handler.ts)
- `src/services/firms-satellite.ts` - DELETED (replaced by src/services/wildfires/index.ts)

## Decisions Made
- Used toMapFires adapter to convert proto FireDetection[] to map-compatible shape, avoiding changes to MapContainer, Map, and DeckGLMap components that share the same setFires signature
- Empty fireDetections response treated as skipped (API key missing) -- matches legacy behavior where empty meant misconfigured
- FireConfidence enum mapped to numeric values (HIGH=95, NOMINAL=50, LOW=20) for backward compatibility with map rendering thresholds

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. NASA_FIRMS_API_KEY is an existing env var.

## Next Phase Readiness
- Wildfire domain is fully migrated end-to-end: proto -> handler -> gateway -> sidecar -> service module -> all consumers
- Phase 2D (Wildfire Migration) is complete
- Legacy wildfire code fully removed from codebase
- Pattern established for remaining domain migrations

## Self-Check: PASSED

All files verified present. Both task commits (46d727a, 4568030) confirmed in git log.

---
*Phase: 2D-wildfire-migration*
*Completed: 2026-02-18*
