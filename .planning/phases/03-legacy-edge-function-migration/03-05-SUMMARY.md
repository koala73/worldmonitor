---
phase: 03-legacy-edge-function-migration
plan: 05
subsystem: infrastructure
tags: [temporal-baseline, welford, redis, anomaly-detection, infrastructure, cleanup]

# Dependency graph
requires:
  - phase: 03-02
    provides: "SummarizeArticle RPC (deleted _summarize-handler.js, first importer of _upstash-cache.js)"
  - phase: 03-04
    provides: "ListTechEvents RPC (tech-events migration complete)"
provides:
  - "GetTemporalBaseline RPC (anomaly detection with z-score thresholds)"
  - "RecordBaselineSnapshot RPC (batch update via Welford's online algorithm)"
  - "mgetJson inline Redis helper for batch key reads"
  - "6 non-JSON edge functions tagged with // Non-sebuf: comment"
  - "_upstash-cache.js deleted (all importers removed)"
  - "desktop-readiness.ts updated with current sebuf API routes"
  - "Phase 3 complete: all migratable legacy edge functions use sebuf RPCs"
affects: [phase-4-desktop, phase-cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns: [inline-mgetJson-redis-batch-reads, welford-online-algorithm, non-sebuf-tagging]

key-files:
  created:
    - proto/worldmonitor/infrastructure/v1/get_temporal_baseline.proto
    - proto/worldmonitor/infrastructure/v1/record_baseline_snapshot.proto
  modified:
    - proto/worldmonitor/infrastructure/v1/service.proto
    - api/server/worldmonitor/infrastructure/v1/handler.ts
    - src/services/temporal-baseline.ts
    - src/services/desktop-readiness.ts
    - src/generated/client/worldmonitor/infrastructure/v1/service_client.ts
    - src/generated/server/worldmonitor/infrastructure/v1/service_server.ts

key-decisions:
  - "Inline mgetJson Redis helper using POST command pipeline (same pattern as getCachedJson/setCachedJson)"
  - "BaselineEntry stored as {mean, m2, sampleCount, lastUpdated} to preserve Welford algorithm state"
  - "Non-JSON files tagged with uniform comment header for grep-ability"
  - "desktop-readiness.ts cloudflare-outages reference updated to infrastructure handler path"

patterns-established:
  - "Non-sebuf tagging: // Non-sebuf: returns XML/HTML, stays as standalone Vercel function"
  - "mgetJson for batch Redis reads via Upstash REST pipeline"

requirements-completed: [CLEAN-02, DOMAIN-10]

# Metrics
duration: 6min
completed: 2026-02-20
---

# Phase 03 Plan 05: Temporal Baseline + Non-JSON Tagging + Final Cleanup Summary

**Temporal baseline anomaly detection via Welford's algorithm in InfrastructureService, 6 non-JSON files tagged, _upstash-cache.js deleted, Phase 3 complete**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-19T23:17:38Z
- **Completed:** 2026-02-19T23:24:11Z
- **Tasks:** 2
- **Files modified:** 18

## Accomplishments
- Migrated temporal-baseline GET/POST to GetTemporalBaseline and RecordBaselineSnapshot RPCs in InfrastructureService
- Ported Welford's online algorithm exactly (Bessel's correction, absolute z-score, severity thresholds)
- Added mgetJson inline Redis helper for batch key reads
- Tagged 6 non-JSON edge functions (rss-proxy, fwdstart, story, og-story, download, version) with // Non-sebuf: comment
- Deleted api/_upstash-cache.js (last importer removed)
- Updated desktop-readiness.ts to fix stale cloudflare-outages reference
- Phase 3 legacy edge function migration is COMPLETE

## Task Commits

Each task was committed atomically:

1. **Task 1: Add temporal baseline protos + implement handler with mget** - `f96a64e` (feat)
2. **Task 2: Rewire temporal-baseline client + tag non-JSON + final cleanup** - `041e4af` (feat)

## Files Created/Modified
- `proto/worldmonitor/infrastructure/v1/get_temporal_baseline.proto` - GetTemporalBaselineRequest/Response messages
- `proto/worldmonitor/infrastructure/v1/record_baseline_snapshot.proto` - RecordBaselineSnapshotRequest/Response messages
- `proto/worldmonitor/infrastructure/v1/service.proto` - Added 2 RPCs to InfrastructureService
- `api/server/worldmonitor/infrastructure/v1/handler.ts` - getTemporalBaseline + recordBaselineSnapshot handlers with inline Redis helpers
- `src/services/temporal-baseline.ts` - Rewired from fetch to InfrastructureServiceClient
- `src/services/desktop-readiness.ts` - Fixed stale cloudflare-outages reference
- `src/generated/client/worldmonitor/infrastructure/v1/service_client.ts` - Generated client with 4 RPCs
- `src/generated/server/worldmonitor/infrastructure/v1/service_server.ts` - Generated server with 4 RPCs
- `docs/api/InfrastructureService.openapi.json` - Updated OpenAPI spec
- `docs/api/InfrastructureService.openapi.yaml` - Updated OpenAPI spec
- `api/temporal-baseline.js` - DELETED (migrated)
- `api/_upstash-cache.js` - DELETED (no importers remain)
- `api/rss-proxy.js` - Tagged non-sebuf
- `api/fwdstart.js` - Tagged non-sebuf
- `api/story.js` - Tagged non-sebuf
- `api/og-story.js` - Tagged non-sebuf
- `api/download.js` - Tagged non-sebuf
- `api/version.js` - Tagged non-sebuf

## Decisions Made
- Inline mgetJson Redis helper using POST command pipeline (matches existing getCachedJson/setCachedJson pattern in military handler)
- BaselineEntry stored as {mean, m2, sampleCount, lastUpdated} preserving full Welford algorithm state
- All 6 non-JSON files tagged with uniform comment header for easy identification via grep
- Fixed stale `/api/cloudflare-outages` reference in desktop-readiness.ts (file was already deleted in prior migration)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stale cloudflare-outages reference in desktop-readiness.ts**
- **Found during:** Task 2 (desktop-readiness update)
- **Issue:** desktop-readiness.ts still referenced `/api/cloudflare-outages` and `api/cloudflare-outages.js` which were deleted in a prior domain migration
- **Fix:** Updated to `/api/infrastructure/v1/list-internet-outages` and `api/server/worldmonitor/infrastructure/v1/handler.ts`
- **Files modified:** src/services/desktop-readiness.ts
- **Verification:** TypeScript compiles cleanly
- **Committed in:** 041e4af (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential correctness fix. No scope creep.

## Issues Encountered
- Proto lint required documentation comments on all fields/messages (pre-existing lint rule). Added comments to pass lint.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 is COMPLETE: all migratable legacy edge functions now use sebuf RPCs
- 6 non-JSON files tagged and documented (will stay as standalone Vercel functions)
- api/_cors.js retained (still needed by non-JSON files)
- Ready for Phase 4 or merging the feat/sebuf-integration branch

## Self-Check: PASSED

All files verified present/deleted. Both commit hashes confirmed in git log.

---
*Phase: 03-legacy-edge-function-migration*
*Completed: 2026-02-20*
