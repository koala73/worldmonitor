---
phase: 2G-displacement-migration
plan: 02
subsystem: api
tags: [unhcr, displacement, refugees, service-module, port-adapter, circuit-breaker, consumer-wiring]

# Dependency graph
requires:
  - phase: 2G-displacement-migration
    provides: "DisplacementServiceHandler with UNHCR API pagination, aggregation, flow corridors"
  - phase: 2B-server-infrastructure
    provides: "Gateway router, sidecar bundle pipeline"
  - phase: 2A-domain-protos
    provides: "displacement/v1 proto definitions and generated client types"
provides:
  - "Displacement service port/adapter module at src/services/displacement/index.ts"
  - "Proto int64 string-to-number mapping and GeoCoordinates-to-flat-lat/lon mapping"
  - "Consumer-friendly DisplacementFlow, CountryDisplacement, UnhcrSummary types"
  - "All 6 consumer files rewired to @/services/displacement"
  - "Legacy endpoint and service deleted, dead types removed"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: ["port/adapter directory module with proto-to-legacy type mapping", "int64 string-to-number conversion via Number()", "GeoCoordinates unpacking to flat lat/lon"]

key-files:
  created:
    - src/services/displacement/index.ts
  modified:
    - src/App.ts
    - src/components/DisplacementPanel.ts
    - src/components/MapContainer.ts
    - src/components/DeckGLMap.ts
    - src/services/conflict-impact.ts
    - src/services/country-instability.ts
    - src/types/index.ts

key-decisions:
  - "Preserved circuit breaker from legacy for upstream failure protection"
  - "Dropped cachedAt field (never set by sebuf handler) but kept in interface for type compat"
  - "ok heuristic uses data !== emptyResult && countries.length > 0"
  - "flowLimit 50 matching legacy top-flows count"

patterns-established:
  - "Displacement service module follows same directory pattern as climate and wildfires"

requirements-completed: [DOMAIN-07, SERVER-02]

# Metrics
duration: 3min
completed: 2026-02-19
---

# Phase 2G Plan 02: Displacement Consumer Wiring Summary

**Displacement port/adapter service module with int64-to-number and GeoCoordinates-to-flat-lat/lon mapping, all 6 consumers rewired, legacy endpoint and service deleted, dead types removed**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-19T09:07:44Z
- **Completed:** 2026-02-19T09:10:55Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Created src/services/displacement/index.ts as port/adapter using DisplacementServiceClient with circuit breaker
- All proto int64 string fields mapped to number, all GeoCoordinates unpacked to flat lat/lon
- Presentation helpers (getDisplacementColor, getDisplacementBadge, formatPopulation, getOriginCountries, getHostCountries) preserved verbatim
- All 6 consumer files (App.ts, DisplacementPanel, MapContainer, DeckGLMap, conflict-impact, country-instability) rewired to @/services/displacement
- Legacy api/unhcr-population.js endpoint deleted
- Legacy src/services/unhcr.ts deleted
- Dead DisplacementFlow, CountryDisplacement, UnhcrSummary types removed from src/types/index.ts
- Full build passes (tsc, Vite, sidecar)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create displacement service module and rewire all consumers** - `a6ce39c` (feat)
2. **Task 2: Delete legacy endpoint, remove dead types, and verify full build** - `0a900d7` (chore)

## Files Created/Modified
- `src/services/displacement/index.ts` - Port/adapter service module with DisplacementServiceClient, proto-to-legacy type mapping, circuit breaker, presentation helpers
- `src/App.ts` - Import rewired from @/services/unhcr to @/services/displacement
- `src/components/DisplacementPanel.ts` - Types and formatPopulation imports rewired to @/services/displacement
- `src/components/MapContainer.ts` - DisplacementFlow import moved from @/types to @/services/displacement
- `src/components/DeckGLMap.ts` - DisplacementFlow import moved from @/types to @/services/displacement
- `src/services/conflict-impact.ts` - CountryDisplacement import moved from @/types to @/services/displacement
- `src/services/country-instability.ts` - CountryDisplacement import moved from @/types to @/services/displacement
- `src/types/index.ts` - Dead DisplacementFlow, CountryDisplacement, UnhcrSummary interfaces removed
- `api/unhcr-population.js` - Deleted (replaced by displacement handler from 2G-01)
- `src/services/unhcr.ts` - Deleted (replaced by displacement service module)

## Decisions Made
- Preserved circuit breaker from legacy service for upstream failure protection (UNHCR API can be slow/down)
- Dropped cachedAt field value (sebuf handler does not return cached_at) but kept field in interface for type compatibility
- ok heuristic: `data !== emptyResult && data.countries.length > 0` (circuit breaker returns emptyResult on failure)
- flowLimit set to 50 matching legacy top-flows count
- year: 0 tells handler to use year fallback logic (try current, then -1, then -2)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused ProtoGlobalTotals import**
- **Found during:** Task 1 (type check)
- **Issue:** ProtoGlobalTotals was imported but never used directly (accessed via proto.summary!.globalTotals! instead)
- **Fix:** Removed the unused import to satisfy strict TypeScript
- **Files modified:** src/services/displacement/index.ts
- **Verification:** tsc --noEmit passes with zero errors
- **Committed in:** a6ce39c (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Trivial unused import cleanup. No scope creep.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Displacement domain is fully migrated to sebuf end-to-end
- All data flows through DisplacementServiceClient -> sebuf gateway -> displacement handler pipeline
- Phase 2G complete -- all plans executed
- Ready for next migration phase or milestone completion
