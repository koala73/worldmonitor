---
phase: 71-renewable-installation-coal-retirement
plan: 01
subsystem: api
tags: [eia, protobuf, energy-capacity, solar, wind, coal, circuit-breaker, redis]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: sebuf RPC infrastructure, proto codegen pipeline
  - phase: 08-map-data-overlays
    provides: renewable energy panel foundation, map overlay data loading
provides:
  - GetEnergyCapacity RPC in EconomicService (proto + generated types)
  - Server handler fetching EIA state electricity profiles capability data
  - Coal sub-type fallback (COL -> BIT/SUB/LIG/RC)
  - Client fetchEnergyCapacity() with circuit breaker and feature gating
  - CapacitySeries/CapacityDataPoint domain types for panel consumption
affects: [71-02-visualization, renewable-energy-panel]

# Tech tracking
tech-stack:
  added: []
  patterns: [EIA capability API state-level aggregation, coal sub-type fallback pattern]

key-files:
  created:
    - proto/worldmonitor/economic/v1/get_energy_capacity.proto
    - server/worldmonitor/economic/v1/get-energy-capacity.ts
  modified:
    - proto/worldmonitor/economic/v1/service.proto
    - server/worldmonitor/economic/v1/handler.ts
    - src/services/economic/index.ts
    - src/services/renewable-energy-data.ts
    - src/generated/client/worldmonitor/economic/v1/service_client.ts
    - src/generated/server/worldmonitor/economic/v1/service_server.ts

key-decisions:
  - "Coal sub-type fallback: try COL first, if empty fetch BIT/SUB/LIG/RC and sum by year"
  - "24h Redis TTL for capacity data since it is annual and rarely changes"
  - "fetchEnergyCapacity requests 25 years of data for comprehensive trend visualization"

patterns-established:
  - "EIA capability API aggregation: fetch state-level data, group by year, sum to national totals"
  - "Coal sub-type fallback: handles endpoint variability in energy source code conventions"

requirements-completed: [ENERGY-01, ENERGY-03]

# Metrics
duration: 3min
completed: 2026-02-23
---

# Phase 7.1 Plan 01: EIA Energy Capacity Data Pipeline Summary

**GetEnergyCapacity RPC with EIA state electricity profile aggregation, coal sub-type fallback, Redis caching, and client circuit breaker**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-23T20:21:41Z
- **Completed:** 2026-02-23T20:24:50Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- GetEnergyCapacity RPC defined in proto with request/response messages for solar, wind, and coal capacity
- Server handler fetches EIA state electricity profiles, aggregates state-level data to national totals by year, with coal sub-type fallback
- Client-side fetchEnergyCapacity() calls RPC through circuit breaker with energyEia feature gating, returns typed CapacitySeries[]

## Task Commits

Each task was committed atomically:

1. **Task 1: Proto definition + server handler for EIA capacity data** - `0649d70` (feat)
2. **Task 2: Client service function for energy capacity data** - `31dd226` (feat)

## Files Created/Modified
- `proto/worldmonitor/economic/v1/get_energy_capacity.proto` - Proto messages for GetEnergyCapacity RPC
- `proto/worldmonitor/economic/v1/service.proto` - Added GetEnergyCapacity RPC to EconomicService
- `server/worldmonitor/economic/v1/get-energy-capacity.ts` - Server handler: EIA API fetch, state aggregation, coal fallback, Redis cache
- `server/worldmonitor/economic/v1/handler.ts` - Registered getEnergyCapacity in handler
- `src/services/economic/index.ts` - Added capacityBreaker and fetchEnergyCapacityRpc()
- `src/services/renewable-energy-data.ts` - Added fetchEnergyCapacity() with CapacitySeries types
- `src/generated/client/worldmonitor/economic/v1/service_client.ts` - Generated client code
- `src/generated/server/worldmonitor/economic/v1/service_server.ts` - Generated server code
- `docs/api/EconomicService.openapi.json` - Auto-generated OpenAPI spec update
- `docs/api/EconomicService.openapi.yaml` - Auto-generated OpenAPI spec update

## Decisions Made
- Coal sub-type fallback: try aggregate COL code first, if zero results fetch BIT/SUB/LIG/RC individually and merge -- handles EIA endpoint variability
- 24h Redis TTL (86400s) for capacity data since it is annual and changes infrequently
- 15s fetch timeout (longer than energy prices' 10s) since capability endpoint returns large state-level datasets
- fetchEnergyCapacity() requests 25 years of data to enable comprehensive trend visualization in the panel

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - uses existing EIA_API_KEY environment variable already configured for energy prices.

## Next Phase Readiness
- CapacitySeries data pipeline is complete and ready for 71-02 (visualization panel)
- fetchEnergyCapacity() returns typed data the RenewableEnergyPanel can directly consume
- No blockers for Plan 02

## Self-Check: PASSED

All files exist, all commits verified.

---
*Phase: 71-renewable-installation-coal-retirement*
*Completed: 2026-02-23*
