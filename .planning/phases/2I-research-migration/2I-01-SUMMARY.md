---
phase: 2I-research-migration
plan: 01
subsystem: api
tags: [fast-xml-parser, arxiv, github-trending, hackernews, firebase, xml-parsing, sebuf]

# Dependency graph
requires:
  - phase: 2B-server-infrastructure
    provides: "Sebuf gateway router, sidecar build pipeline"
  - phase: 2A-domain-protos
    provides: "Research service proto with 3 RPCs and generated types"
provides:
  - "ResearchServiceHandler with listArxivPapers, listTrendingRepos, listHackernewsItems RPCs"
  - "Research routes mounted in catch-all gateway at /api/research/v1/*"
  - "Sidecar bundle rebuilt with research endpoints"
affects: [2I-02-consumer-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [arXiv XML attribute parsing with ignoreAttributes false, GitHub trending primary+fallback API, HN Firebase 2-step fetch with bounded concurrency]

key-files:
  created:
    - api/server/worldmonitor/research/v1/handler.ts
  modified:
    - api/[[...path]].ts

key-decisions:
  - "XMLParser ignoreAttributes: false (unlike aviation handler) because arXiv uses XML attributes for category term, link href/rel"
  - "HN bounded concurrency of 10 to avoid overwhelming Firebase API"
  - "GitHub trending uses gitterapp primary with herokuapp fallback"

patterns-established:
  - "Multi-source research handler: each RPC independently fetches from different upstream APIs"
  - "arXiv XML parsing: ignoreAttributes false + attributeNamePrefix for Atom XML with attributes"

requirements-completed: [DOMAIN-05, SERVER-02]

# Metrics
duration: 2min
completed: 2026-02-19
---

# Phase 2I Plan 01: Research Handler Summary

**Research domain handler with 3 RPCs (arXiv XML, GitHub trending, Hacker News Firebase) mounted in sebuf gateway**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-19T10:23:00Z
- **Completed:** 2026-02-19T10:25:01Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Implemented ResearchServiceHandler with 3 independent RPC methods proxying arXiv, GitHub trending, and Hacker News APIs
- arXiv XML parsing uses fast-xml-parser with `ignoreAttributes: false` to extract category terms and link hrefs from Atom XML attributes
- All RPCs gracefully return empty arrays on ANY upstream failure
- Routes mounted in catch-all gateway, sidecar rebuilt (116.6 KB)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement ResearchServiceHandler with 3 RPCs** - `4c3754c` (feat)
2. **Task 2: Mount research routes in gateway and rebuild sidecar** - `8ae5301` (feat)

## Files Created/Modified
- `api/server/worldmonitor/research/v1/handler.ts` - ResearchServiceHandler with listArxivPapers, listTrendingRepos, listHackernewsItems
- `api/[[...path]].ts` - Added research route imports and mounting in allRoutes array

## Decisions Made
- XMLParser configured with `ignoreAttributes: false` and `attributeNamePrefix: '@_'` because arXiv Atom XML stores critical data in attributes (`<category term="cs.AI"/>`, `<link href="..." rel="alternate"/>`) -- unlike the aviation handler which uses `ignoreAttributes: true`
- HN Firebase API uses bounded concurrency of 10 per batch with 5s per-item timeout (shorter than the 10s story list timeout) to avoid overwhelming the API
- GitHub trending uses gitterapp as primary API with herokuapp as fallback, both with 10s timeouts
- HN feed type validated against allowed set with 'top' as default

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript errors in wildfire handler and `import.meta.env` references were observed during `tsc --noEmit` but are out of scope (not caused by this plan's changes). The research handler itself compiles cleanly with zero errors.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Research handler fully operational with 3 RPCs routable at:
  - POST /api/research/v1/list-arxiv-papers
  - POST /api/research/v1/list-trending-repos
  - POST /api/research/v1/list-hackernews-items
- Ready for Plan 02: consumer wiring to connect frontend components to these proto-typed endpoints

## Self-Check: PASSED

- FOUND: api/server/worldmonitor/research/v1/handler.ts
- FOUND: commit 4c3754c (Task 1)
- FOUND: commit 8ae5301 (Task 2)
- FOUND: .planning/phases/2I-research-migration/2I-01-SUMMARY.md

---
*Phase: 2I-research-migration*
*Completed: 2026-02-19*
