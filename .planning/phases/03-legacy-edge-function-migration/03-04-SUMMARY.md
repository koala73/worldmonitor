---
phase: 03-legacy-edge-function-migration
plan: 04
subsystem: api
tags: [protobuf, sebuf, ics-parsing, rss-parsing, geocoding, research-service]

# Dependency graph
requires:
  - phase: 02-domain-handlers
    provides: ResearchService with arXiv/GitHub/HackerNews RPCs
provides:
  - ListTechEvents RPC in ResearchService (ICS + RSS + curated events)
  - 360-city geocoding lookup table (api/data/city-coords.ts)
  - TechEventsPanel and App.ts rewired to ResearchServiceClient
affects: [03-05-PLAN, final-cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns: [large-data-table-extraction, multi-source-aggregation-rpc]

key-files:
  created:
    - proto/worldmonitor/research/v1/list_tech_events.proto
    - api/data/city-coords.ts
  modified:
    - proto/worldmonitor/research/v1/service.proto
    - api/server/worldmonitor/research/v1/handler.ts
    - src/components/TechEventsPanel.ts
    - src/App.ts
    - src/generated/client/worldmonitor/research/v1/service_client.ts
    - src/generated/server/worldmonitor/research/v1/service_server.ts

key-decisions:
  - "Extracted 360-city CITY_COORDS table to separate api/data/city-coords.ts to keep handler manageable"
  - "CURATED_EVENTS defined as typed TechEvent[] constant inside handler"
  - "Used --path flag for buf generate to avoid pre-existing intelligence proto error"

patterns-established:
  - "Data table extraction: large lookup tables go to api/data/*.ts, imported by handlers"

requirements-completed: [CLEAN-02, DOMAIN-10]

# Metrics
duration: 8min
completed: 2026-02-20
---

# Phase 03 Plan 04: Tech Events Migration Summary

**Tech events migrated to ResearchService.ListTechEvents RPC with ICS/RSS parsing, 360-city geocoding, curated events, and deduplication**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-19T23:05:55Z
- **Completed:** 2026-02-19T23:14:07Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Created ListTechEvents proto with TechEvent and TechEventCoords messages
- Ported all 737 lines of legacy tech-events.js logic into typed handler: ICS parsing (Techmeme), RSS parsing (dev.events), curated events, normalizeLocation with 360-city geocoding, deduplication, filtering
- Extracted 360-city geocoding table to api/data/city-coords.ts for reuse and maintainability
- Rewired both TechEventsPanel and App.ts to use ResearchServiceClient.listTechEvents()
- Deleted legacy api/tech-events.js

## Task Commits

Each task was committed atomically:

1. **Task 1: Add ListTechEvents proto + city-coords data + implement handler** - `d4391e6` (feat)
2. **Task 2: Rewire TechEventsPanel + App consumers + delete legacy file** - `4adb19f` (feat)

## Files Created/Modified
- `proto/worldmonitor/research/v1/list_tech_events.proto` - ListTechEventsRequest/Response with TechEvent, TechEventCoords messages
- `proto/worldmonitor/research/v1/service.proto` - Added ListTechEvents RPC
- `api/data/city-coords.ts` - 360-city geocoding lookup table with CityCoord interface
- `api/server/worldmonitor/research/v1/handler.ts` - listTechEvents handler with ICS+RSS parsing, geocoding, dedup, filtering
- `src/components/TechEventsPanel.ts` - Rewired from fetch() to ResearchServiceClient
- `src/App.ts` - loadTechEvents() rewired from fetch() to ResearchServiceClient
- `src/generated/client/worldmonitor/research/v1/service_client.ts` - Regenerated with listTechEvents
- `src/generated/server/worldmonitor/research/v1/service_server.ts` - Regenerated with listTechEvents
- `docs/api/ResearchService.openapi.yaml` - Updated with ListTechEvents endpoint
- `docs/api/ResearchService.openapi.json` - Updated version

## Decisions Made
- Extracted 360-city CITY_COORDS table to separate `api/data/city-coords.ts` to keep handler under ~400 lines. This follows the pattern established by military-hex-db.js in the same directory.
- Used `buf generate --path worldmonitor/research/v1` to work around a pre-existing lint error in intelligence proto (sebuf/ts/options.proto import).
- CURATED_EVENTS defined inside handler as typed constant (5 entries) rather than separate file since it's small.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `buf generate` (full) fails due to pre-existing intelligence proto lint error (`sebuf/ts/options.proto` import missing). Used `--path worldmonitor/research/v1` to generate only the research service protos. This is a known pre-existing issue and out of scope for this plan.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Step 7 (tech-events) complete
- ResearchService now has 4 RPCs: arXiv, GitHub trending, HackerNews, and TechEvents
- Ready for step 8 (temporal-baseline) or remaining migration steps

## Self-Check: PASSED

- list_tech_events.proto: FOUND
- city-coords.ts: FOUND
- handler.ts (with listTechEvents): FOUND
- tech-events.js deleted: CONFIRMED
- Commit d4391e6 (Task 1): FOUND
- Commit 4adb19f (Task 2): FOUND

---
*Phase: 03-legacy-edge-function-migration*
*Completed: 2026-02-20*
