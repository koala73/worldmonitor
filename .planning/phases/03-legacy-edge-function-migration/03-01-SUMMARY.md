---
phase: 03-legacy-edge-function-migration
plan: 01
subsystem: api
tags: [proto, sebuf, military, intelligence, gdelt, wingbits, rpc]

# Dependency graph
requires:
  - phase: 02-server-runtime
    provides: sebuf proto codegen pipeline, handler registration pattern
provides:
  - Wingbits migration committed (3 RPCs in military domain)
  - SearchGdeltDocuments RPC in intelligence domain
  - Dead _ip-rate-limit.js removed
affects: [03-02, 03-03, 03-04, 03-05]

# Tech tracking
tech-stack:
  added: []
  patterns: [intelligence service RPC for GDELT API proxy]

key-files:
  created:
    - proto/worldmonitor/military/v1/get_aircraft_details.proto
    - proto/worldmonitor/military/v1/get_aircraft_details_batch.proto
    - proto/worldmonitor/military/v1/get_wingbits_status.proto
    - proto/worldmonitor/intelligence/v1/search_gdelt_documents.proto
  modified:
    - api/server/worldmonitor/intelligence/v1/handler.ts
    - api/server/worldmonitor/military/v1/handler.ts
    - src/services/wingbits.ts
    - src/services/gdelt-intel.ts
    - src/services/desktop-readiness.ts

key-decisions:
  - "Removed sebuf/ts/options.proto import from SearchGdeltDocuments proto -- no int64 fields, not needed"
  - "Error responses returned in-band via error field (matching legacy behavior) rather than HTTP error codes"

patterns-established:
  - "GDELT API proxy pattern: handler fetches upstream, maps to proto shape, returns error in response field"

requirements-completed: [CLEAN-02, DOMAIN-10]

# Metrics
duration: 4min
completed: 2026-02-20
---

# Phase 03 Plan 01: Wingbits Commit + GDELT Doc Migration Summary

**Wingbits 3-RPC migration committed, GDELT doc search migrated to IntelligenceService.SearchGdeltDocuments RPC, dead _ip-rate-limit.js deleted**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-19T23:05:46Z
- **Completed:** 2026-02-19T23:09:51Z
- **Tasks:** 2
- **Files modified:** 22

## Accomplishments
- Committed wingbits migration (step 3) with 3 new RPCs in military domain: GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus
- Migrated GDELT document search from legacy api/gdelt-doc.js to IntelligenceService.SearchGdeltDocuments RPC
- Rewired src/services/gdelt-intel.ts from fetch('/api/gdelt-doc') to IntelligenceServiceClient.searchGdeltDocuments()
- Deleted dead api/_ip-rate-limit.js (first shared utility cleanup)
- Deleted 3 legacy api/wingbits/ edge functions and api/gdelt-doc.js

## Task Commits

Each task was committed atomically:

1. **Task 1: Commit wingbits migration + verify step 3** - `1342730` (feat)
2. **Task 2: Migrate GDELT doc search to intelligence domain + delete _ip-rate-limit.js** - `dc087d3` (feat)

## Files Created/Modified
- `proto/worldmonitor/military/v1/get_aircraft_details.proto` - Aircraft details request/response messages
- `proto/worldmonitor/military/v1/get_aircraft_details_batch.proto` - Batch aircraft details request/response
- `proto/worldmonitor/military/v1/get_wingbits_status.proto` - Wingbits API status check
- `proto/worldmonitor/intelligence/v1/search_gdelt_documents.proto` - GDELT document search request/response messages
- `proto/worldmonitor/intelligence/v1/service.proto` - Added SearchGdeltDocuments RPC
- `api/server/worldmonitor/intelligence/v1/handler.ts` - Added searchGdeltDocuments handler method
- `api/server/worldmonitor/military/v1/handler.ts` - Added 3 wingbits RPC handlers
- `src/services/wingbits.ts` - Rewired to MilitaryServiceClient
- `src/services/gdelt-intel.ts` - Rewired to IntelligenceServiceClient
- `src/services/desktop-readiness.ts` - Updated API routes for wingbits
- `api/wingbits/[[...path]].js` - DELETED (legacy proxy)
- `api/wingbits/details/[icao24].js` - DELETED (legacy proxy)
- `api/wingbits/details/batch.js` - DELETED (legacy proxy)
- `api/gdelt-doc.js` - DELETED (legacy edge function)
- `api/_ip-rate-limit.js` - DELETED (dead code, zero importers)

## Decisions Made
- Removed `sebuf/ts/options.proto` import from SearchGdeltDocuments proto since it only uses string/int32/double fields (no int64)
- GDELT errors returned in-band via response `error` field rather than HTTP error codes, matching legacy behavior
- Proto GdeltArticle maps empty strings to undefined for optional fields (image, language, tone) to preserve client interface compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused sebuf/ts/options.proto import**
- **Found during:** Task 2 (proto compilation)
- **Issue:** Plan template included `import "sebuf/ts/options.proto"` but the proto file has no int64 fields needing INT64_ENCODING_NUMBER
- **Fix:** Removed the import line
- **Files modified:** proto/worldmonitor/intelligence/v1/search_gdelt_documents.proto
- **Verification:** `buf generate` succeeded after removal
- **Committed in:** dc087d3 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Trivial fix, no scope impact.

## Issues Encountered
- Pre-existing commit `6575477` from a prior manual session was already on the branch between the two task commits, having already deleted api/gdelt-doc.js and api/_ip-rate-limit.js. The `buf generate` also picked up economic service proto changes from that session's working tree. No impact on plan execution -- all intended changes are correctly committed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Steps 3 and 4 complete, branch ready for step 5 (summarization migration, plan 03-02)
- TypeScript compiles cleanly
- No remaining references to /api/gdelt-doc or /api/wingbits in src/

## Self-Check: PASSED

- All 5 created files verified present
- All 5 deleted files verified absent
- Both task commits (1342730, dc087d3) verified in git log

---
*Phase: 03-legacy-edge-function-migration*
*Completed: 2026-02-20*
