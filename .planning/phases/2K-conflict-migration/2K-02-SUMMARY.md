---
phase: 2K-conflict-migration
plan: 02
subsystem: api
tags: [acled, ucdp, hapi, conflict, humanitarian, service-module, port-adapter, sebuf]

# Dependency graph
requires:
  - phase: 2K-01
    provides: ConflictServiceHandler with 3 RPCs (listAcledEvents, listUcdpEvents, getHumanitarianSummary)
provides:
  - Conflict service module mapping proto types to 4 legacy type shapes (ConflictEvent, UcdpConflictStatus, HapiConflictSummary, UcdpGeoEvent)
  - 5 exported fetch functions + deduplicateAgainstAcled + groupByCountry/groupByType
  - Consumer imports consolidated (App.ts, country-instability.ts)
  - 9 legacy files deleted (4 API endpoints + 4 service files + 1 dead code)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [four-shape-proto-adapter, heuristic-classification-derivation, per-country-parallel-rpc]

key-files:
  created:
    - src/services/conflict/index.ts
  modified:
    - src/App.ts
    - src/services/country-instability.ts

key-decisions:
  - "UCDP classifications derived heuristically from GED events (deaths>1000 or events>100 = war, events>10 = minor, else none)"
  - "fetchHapiSummary calls RPC per tier-1 country via Promise.allSettled (20 parallel calls) since proto response is single-country"
  - "noUncheckedIndexedAccess fix: used substring(0,10) instead of split('T')[0] for ISO date extraction"
  - "UcdpGeoEvent and UcdpEventType preserved in src/types/index.ts (scope guard for map components)"

patterns-established:
  - "Four-shape proto adapter: single service module producing 4 distinct legacy type shapes from 3 proto RPCs"
  - "Heuristic classification derivation: derive aggregate status from raw event data rather than direct API mapping"

requirements-completed: [DOMAIN-07, SERVER-02]

# Metrics
duration: 3min
completed: 2026-02-19
---

# Phase 2K Plan 02: Conflict Service Module Summary

**Port/adapter service module mapping 3 proto RPCs to 4 legacy type shapes (ConflictEvent, UcdpConflictStatus, HapiConflictSummary, UcdpGeoEvent) with UCDP heuristic classification derivation, consumer consolidation, and 9 legacy file deletions**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-19T18:22:42Z
- **Completed:** 2026-02-19T18:25:49Z
- **Tasks:** 2
- **Files modified:** 12 (1 created, 2 modified, 9 deleted)

## Accomplishments
- Created conflict service module with 4-shape proto-to-legacy type mapping and 3 circuit breakers
- UCDP classifications derived heuristically from GED violence events (trailing 2-year window, deaths/events thresholds)
- deduplicateAgainstAcled ported exactly with haversine distance + 7-day window + fatality ratio matching
- Consumer imports consolidated: App.ts from 4 imports to 1, country-instability.ts from 3 imports to 1
- 9 legacy files deleted: 4 API endpoints + 4 service files + 1 dead code file (conflict-impact.ts)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create conflict service module with 4-shape proto-to-legacy type mapping** - `5ba73ae` (feat)
2. **Task 2: Rewire consumer imports and delete legacy files** - `ac31607` (feat)

## Files Created/Modified
- `src/services/conflict/index.ts` - Port/adapter service module with 4 type adapters, 5 fetch functions, deduplication, grouping helpers
- `src/App.ts` - Consolidated 4 conflict imports to single `@/services/conflict` import
- `src/services/country-instability.ts` - Consolidated 3 type imports to single `./conflict` import
- `api/acled-conflict.js` - DELETED (legacy API endpoint)
- `api/ucdp-events.js` - DELETED (legacy API endpoint)
- `api/ucdp.js` - DELETED (legacy API endpoint)
- `api/hapi.js` - DELETED (legacy API endpoint)
- `src/services/conflicts.ts` - DELETED (legacy service)
- `src/services/ucdp.ts` - DELETED (legacy service)
- `src/services/ucdp-events.ts` - DELETED (legacy service)
- `src/services/hapi.ts` - DELETED (legacy service)
- `src/services/conflict-impact.ts` - DELETED (dead code)

## Decisions Made
- UCDP classifications derived heuristically from GED events: deaths > 1000 or events > 100 in trailing 2 years = 'war', events > 10 = 'minor', else 'none'
- fetchHapiSummary calls RPC per tier-1 country individually via Promise.allSettled (20 parallel calls) since proto GetHumanitarianSummaryResponse returns a single country summary
- Used `substring(0, 10)` instead of `split('T')[0]` for ISO date extraction to satisfy `noUncheckedIndexedAccess` TypeScript config
- UcdpGeoEvent and UcdpEventType preserved in `src/types/index.ts` as scope guard (used by DeckGLMap.ts, MapContainer.ts, UcdpEventsPanel.ts)
- Services barrel `src/services/index.ts` NOT modified since conflict services were never re-exported through it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed noUncheckedIndexedAccess type error with split()[0]**
- **Found during:** Task 1 (conflict service module creation)
- **Issue:** `new Date().toISOString().split('T')[0]` returns `string | undefined` under `noUncheckedIndexedAccess: true` tsconfig
- **Fix:** Changed to `new Date().toISOString().substring(0, 10)` which always returns `string`
- **Files modified:** src/services/conflict/index.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** `5ba73ae` (part of Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Trivial string operation fix for TypeScript strictness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2K (Conflict Migration) is now complete -- handler + service module + consumer wiring all done
- All conflict domain code now flows through proto/sebuf pipeline
- No remaining legacy API endpoints or service files for conflict domain

## Self-Check: PASSED

- FOUND: src/services/conflict/index.ts
- FOUND: commit 5ba73ae (Task 1: service module)
- FOUND: commit ac31607 (Task 2: import rewiring + deletions)
- VERIFIED: 9 legacy files deleted (all return "No such file")
- VERIFIED: UcdpGeoEvent exists in src/types/index.ts (count: 1)
- VERIFIED: npx tsc --noEmit passes with zero errors

---
*Phase: 2K-conflict-migration*
*Completed: 2026-02-19*
