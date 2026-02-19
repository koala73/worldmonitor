---
phase: 2J-unrest-migration
plan: 01
subsystem: api
tags: [acled, gdelt, unrest, protest, sebuf, handler, edge]

# Dependency graph
requires:
  - phase: 2B-server-infrastructure
    provides: Gateway router, CORS, error mapper, sidecar build
  - phase: 2A-domain-protos
    provides: Unrest proto definitions (UnrestServiceHandler, UnrestEvent, enums)
provides:
  - UnrestServiceHandler with listUnrestEvents RPC at /api/unrest/v1/list-unrest-events
  - Server-side ACLED + GDELT dual-fetch with deduplication and severity classification
  - Unrest routes mounted in catch-all gateway
  - Sidecar bundle updated with unrest endpoint
affects: [2J-02-consumer-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-source parallel fetch with Promise.all and graceful degradation"
    - "Server-side event deduplication using 0.5-degree grid + date key"
    - "declare const process for edge runtime env access in strict tsconfig"

key-files:
  created:
    - api/server/worldmonitor/unrest/v1/handler.ts
  modified:
    - api/[[...path]].ts

key-decisions:
  - "Added declare const process for type safety in tsconfig with empty types array (matching wildfire handler pattern)"
  - "Clusters returned as empty array (future enhancement, client-side Supercluster handles clustering)"
  - "No error logging on upstream failures following established 2F-01 pattern"
  - "GDELT event IDs use coordinate-based deterministic format instead of generateId() utility"

patterns-established:
  - "Dual-source handler pattern: parallel fetch from ACLED (auth) + GDELT (no auth) with server-side merge"

requirements-completed: [DOMAIN-07, SERVER-02]

# Metrics
duration: 2min
completed: 2026-02-19
---

# Phase 2J Plan 01: Unrest Handler Summary

**UnrestServiceHandler with ACLED protest proxy (Bearer auth) and GDELT GEO enrichment, server-side deduplication via 0.5-degree grid, severity classification, and gateway mounting**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T11:20:40Z
- **Completed:** 2026-02-19T11:23:33Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Implemented UnrestServiceHandler with listUnrestEvents RPC consolidating 3 legacy data flows
- ACLED + GDELT dual-fetch in parallel with server-side merge, deduplication, and severity classification
- Routes mounted in catch-all gateway, sidecar bundle rebuilt

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement UnrestServiceHandler with ACLED + GDELT dual-fetch** - `42a2bfc` (feat)
2. **Task 2: Mount unrest routes in gateway and rebuild sidecar** - `59898b6` (feat)

## Files Created/Modified
- `api/server/worldmonitor/unrest/v1/handler.ts` - UnrestServiceHandler with 1 RPC: listUnrestEvents. ACLED fetch with Bearer auth, GDELT GEO fetch, deduplication, severity classification, sorting
- `api/[[...path]].ts` - Added unrest route imports and mounting in allRoutes array

## Decisions Made
- Added `declare const process` at top of handler for type safety with `tsconfig.api.json` empty types array (same issue exists in wildfire handler -- pre-existing pattern)
- Clusters returned as empty array per plan spec (client-side Supercluster handles map clustering)
- GDELT event IDs use coordinate-based deterministic format (`gdelt-${lat}-${lon}-${timestamp}`) instead of client-side `generateId()` utility
- No error logging on upstream ACLED/GDELT failures following established 2F-01 pattern

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `declare const process` for edge runtime type safety**
- **Found during:** Task 1 (Handler implementation)
- **Issue:** `tsconfig.api.json` has `types: []` which excludes `@types/node`, causing `process.env` to be unresolved
- **Fix:** Added `declare const process: { env: Record<string, string | undefined> }` at file top
- **Files modified:** `api/server/worldmonitor/unrest/v1/handler.ts`
- **Verification:** `npx tsc --noEmit -p tsconfig.api.json` shows zero errors for handler file
- **Committed in:** 42a2bfc (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minor type declaration to resolve pre-existing tsconfig constraint. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. ACLED_ACCESS_TOKEN is already configured in the environment.

## Next Phase Readiness
- Handler and gateway wiring complete, ready for Plan 02 (service module + consumer rewiring + legacy deletion)
- Service module will wrap UnrestServiceClient, map proto UnrestEvent to legacy SocialUnrestEvent type
- Legacy files to delete in Plan 02: api/acled.js, api/gdelt-geo.js, src/services/protests.ts

## Self-Check: PASSED

- [x] api/server/worldmonitor/unrest/v1/handler.ts exists
- [x] .planning/phases/2J-unrest-migration/2J-01-SUMMARY.md exists
- [x] Commit 42a2bfc found
- [x] Commit 59898b6 found

---
*Phase: 2J-unrest-migration*
*Completed: 2026-02-19*
