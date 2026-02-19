---
phase: 2I-research-migration
plan: 02
subsystem: api
tags: [sebuf, circuit-breaker, port-adapter, research, arxiv, github-trending, hackernews, legacy-cleanup]

# Dependency graph
requires:
  - phase: 2I-research-migration
    plan: 01
    provides: "ResearchServiceHandler with 3 RPCs mounted in sebuf gateway"
  - phase: 2B-server-infrastructure
    provides: "Sebuf gateway router, circuit breaker utility"
provides:
  - "Research service module at src/services/research/index.ts with fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems"
  - "Proto types ArxivPaper, GithubRepo, HackernewsItem re-exported from service module"
  - "6 legacy files deleted (3 API endpoints + 3 service files)"
  - "Config entries cleaned from API_URLS and REFRESH_INTERVALS"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [thin port/adapter with no enum mapping (proto types are clean), circuit breaker per-RPC with empty-array fallback]

key-files:
  created:
    - src/services/research/index.ts
  modified:
    - src/config/variants/base.ts
  deleted:
    - api/arxiv.js
    - api/github-trending.js
    - api/hackernews.js
    - src/services/arxiv.ts
    - src/services/github-trending.ts
    - src/services/hackernews.ts

key-decisions:
  - "No enum mapping needed -- research proto types (ArxivPaper, GithubRepo, HackernewsItem) are already clean with no enums or GeoCoordinates"
  - "Thin port/adapter pattern: service module wraps generated client with circuit breakers, no type transformation layer"

patterns-established:
  - "Clean proto domain: when proto types match consumer expectations, skip the mapping layer entirely"

requirements-completed: [DOMAIN-05, SERVER-02]

# Metrics
duration: 2min
completed: 2026-02-19
---

# Phase 2I Plan 02: Research Consumer Wiring Summary

**Research service module with 3 circuit-breaker-wrapped fetch functions, 6 legacy files deleted, config entries cleaned**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T10:27:46Z
- **Completed:** 2026-02-19T10:29:22Z
- **Tasks:** 1
- **Files modified:** 8 (1 created, 1 modified, 6 deleted)

## Accomplishments
- Created src/services/research/index.ts port/adapter wrapping ResearchServiceClient with per-RPC circuit breakers
- Re-exported ArxivPaper, GithubRepo, HackernewsItem proto types directly (no enum mapping needed -- proto types are clean)
- Deleted all 6 legacy files: 3 API endpoints (api/arxiv.js, api/github-trending.js, api/hackernews.js) and 3 service files (src/services/arxiv.ts, src/services/github-trending.ts, src/services/hackernews.ts)
- Removed arxiv, githubTrending, hackernews entries from API_URLS and REFRESH_INTERVALS in config

## Task Commits

Each task was committed atomically:

1. **Task 1: Create research service module and delete legacy code** - `9e45c9c` (feat)

## Files Created/Modified
- `src/services/research/index.ts` - Port/adapter service module with fetchArxivPapers, fetchTrendingRepos, fetchHackernewsItems backed by ResearchServiceClient
- `src/config/variants/base.ts` - Removed arxiv, githubTrending, hackernews from API_URLS and REFRESH_INTERVALS
- `api/arxiv.js` - DELETED (legacy Vercel serverless endpoint)
- `api/github-trending.js` - DELETED (legacy Vercel serverless endpoint)
- `api/hackernews.js` - DELETED (legacy Vercel serverless endpoint)
- `src/services/arxiv.ts` - DELETED (legacy service with direct fetch)
- `src/services/github-trending.ts` - DELETED (legacy service with direct fetch)
- `src/services/hackernews.ts` - DELETED (legacy service with direct fetch)

## Decisions Made
- No enum mapping needed: research proto types (ArxivPaper, GithubRepo, HackernewsItem) are already clean with string fields and number types matching consumer expectations exactly
- Thin port/adapter: service module is the simplest of all domain modules -- just wraps generated client with circuit breakers, no type transformation layer needed

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Research domain migration fully complete (handler + consumer wiring + legacy cleanup)
- Phase 2I is the final domain migration phase -- all domains now use proto-typed sebuf endpoints
- Service module ready for future UI consumers to import from @/services/research

## Self-Check: PASSED

- FOUND: src/services/research/index.ts
- FOUND: commit 9e45c9c (Task 1)
- FOUND: .planning/phases/2I-research-migration/2I-02-SUMMARY.md

---
*Phase: 2I-research-migration*
*Completed: 2026-02-19*
