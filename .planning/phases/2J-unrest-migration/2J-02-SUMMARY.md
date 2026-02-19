---
phase: 2J-unrest-migration
plan: 02
subsystem: api
tags: [sebuf, unrest, protests, acled, gdelt, port-adapter, circuit-breaker]

requires:
  - phase: 2J-01
    provides: Unrest handler with ACLED + GDELT dual-fetch, routes mounted in gateway
  - phase: 2B
    provides: Server infrastructure (router, CORS, error mapper, gateway plugin)
  - phase: 2C-01
    provides: INT64_ENCODING_NUMBER for epoch-ms time fields

provides:
  - Port/adapter service module mapping proto UnrestEvent to legacy SocialUnrestEvent
  - fetchProtestEvents() returning ProtestData (events, byCountry, highSeverityCount, sources)
  - getProtestStatus() with ACLED configuration heuristic
  - Services barrel re-export from './unrest' replacing './protests'
  - Legacy code deletion (api/acled.js, api/gdelt-geo.js, src/services/protests.ts)
  - Vite dev proxy cleanup (/api/acled, /api/gdelt-geo entries removed)

affects: [conflict-migration, consumer-modules]

tech-stack:
  added: []
  patterns: [full-adapter-service-module, enum-mapping, acled-config-heuristic]

key-files:
  created:
    - src/services/unrest/index.ts
  modified:
    - src/services/index.ts
  deleted:
    - api/acled.js
    - api/gdelt-geo.js
    - src/services/protests.ts
    - vite.config.ts (proxy entries removed)

key-decisions:
  - "acledConfigured heuristic: infer ACLED config status from response events (ACLED events present = true, only GDELT = false, empty = null)"
  - "relatedHotspots, imageUrl, sentiment fields dropped from adapter (optional, never populated meaningfully or client-side enrichment)"
  - "Dedup/sort logic moved server-side into handler; service module maps events without client-side dedup"

patterns-established:
  - "Full adapter pattern: 4 enum mappers + toSocialUnrestEvent converter for proto->legacy type mapping"
  - "ACLED config heuristic: module-level let variable updated by fetchProtestEvents based on response analysis"

requirements-completed: [DOMAIN-07, SERVER-02]

duration: 2min
completed: 2026-02-19
---

# Phase 2J Plan 02: Unrest Service Module Summary

**Port/adapter service module mapping proto UnrestEvent to legacy SocialUnrestEvent with 4 enum mappers, circuit breaker, and ACLED configuration heuristic**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T11:26:31Z
- **Completed:** 2026-02-19T11:28:15Z
- **Tasks:** 2
- **Files modified:** 5 (1 created, 1 modified, 3 deleted)

## Accomplishments
- Full adapter service module maps all proto UnrestEvent fields to legacy SocialUnrestEvent shape (lat/lon, Date, string severity/eventType/sourceType)
- Services barrel updated, 3 legacy files deleted, Vite proxy entries cleaned up
- 15+ consumer files continue working without modification via unchanged SocialUnrestEvent type

## Task Commits

Each task was committed atomically:

1. **Task 1: Create unrest service module with proto-to-legacy type mapping** - `3f63134` (feat)
2. **Task 2: Update services barrel, remove vite proxy entries, and delete legacy files** - `95a1dbf` (feat)

## Files Created/Modified
- `src/services/unrest/index.ts` - Port/adapter service module with full proto-to-legacy type mapping, circuit breaker, ACLED config heuristic
- `src/services/index.ts` - Barrel re-export changed from './protests' to './unrest'
- `vite.config.ts` - Removed /api/acled and /api/gdelt-geo dev proxy entries
- `api/acled.js` - DELETED (replaced by handler's ACLED fetch)
- `api/gdelt-geo.js` - DELETED (replaced by handler's GDELT fetch)
- `src/services/protests.ts` - DELETED (replaced by src/services/unrest/index.ts)

## Decisions Made
- ACLED configuration heuristic infers status from response event sources rather than a separate config check -- if ACLED-sourced events present in response, acledConfigured=true; if only GDELT events, acledConfigured=false; empty response leaves it null
- relatedHotspots field dropped from adapter (was client-side enrichment using INTEL_HOTSPOTS config, not in proto, per research recommendation)
- imageUrl and sentiment fields also omitted (both optional, never populated meaningfully)
- Deduplication and sorting logic not replicated in service module -- handler handles data aggregation server-side

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Unrest domain migration complete (handler + service module + legacy cleanup)
- Phase 2J fully complete -- all 2 plans executed
- api/acled-conflict.js preserved for future conflict domain migration
- SocialUnrestEvent type preserved in src/types/index.ts for 15+ consumers

## Self-Check: PASSED

- FOUND: src/services/unrest/index.ts
- FOUND: .planning/phases/2J-unrest-migration/2J-02-SUMMARY.md
- FOUND: commit 3f63134
- FOUND: commit 95a1dbf

---
*Phase: 2J-unrest-migration*
*Completed: 2026-02-19*
