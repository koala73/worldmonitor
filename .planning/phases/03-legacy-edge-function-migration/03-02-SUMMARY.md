---
phase: 03-legacy-edge-function-migration
plan: 02
subsystem: api
tags: [llm, summarization, protobuf, sebuf, redis, news, ollama, groq, openrouter]

# Dependency graph
requires:
  - phase: 02-domain-wiring
    provides: NewsService proto + handler scaffolding with SummarizeHeadlines RPC
provides:
  - SummarizeArticle RPC with multi-provider dispatch (ollama/groq/openrouter)
  - Redis-cached LLM summarization via single RPC endpoint
  - Client fallback chain preserved via NewsServiceClient
affects: [03-legacy-edge-function-migration, cleanup]

# Tech tracking
tech-stack:
  added: []
  patterns: [multi-provider RPC dispatch via provider field, inline Upstash Redis helpers]

key-files:
  created:
    - proto/worldmonitor/news/v1/summarize_article.proto
  modified:
    - proto/worldmonitor/news/v1/service.proto
    - api/server/worldmonitor/news/v1/handler.ts
    - src/services/summarization.ts
    - src/services/desktop-readiness.ts
    - src/generated/client/worldmonitor/news/v1/service_client.ts
    - src/generated/server/worldmonitor/news/v1/service_server.ts

key-decisions:
  - "Single SummarizeArticle RPC with provider field instead of separate per-provider RPCs"
  - "Port all prompt/cache/dedup logic into handler rather than importing shared modules"

patterns-established:
  - "Multi-provider dispatch: single RPC with provider parameter selects credentials/config at handler level"

requirements-completed: [CLEAN-02, DOMAIN-09, DOMAIN-10]

# Metrics
duration: 5min
completed: 2026-02-20
---

# Phase 03 Plan 02: Summarization Migration Summary

**Consolidated 4 LLM summarization endpoints (3 providers + shared handler) into single SummarizeArticle RPC with Redis caching and provider dispatch**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-19T23:05:49Z
- **Completed:** 2026-02-19T23:11:00Z
- **Tasks:** 2
- **Files modified:** 12 (7 modified/created, 5 deleted)

## Accomplishments
- Created SummarizeArticle proto with request/response messages covering all provider params
- Implemented full handler with provider credential dispatch (ollama/groq/openrouter), Redis caching, prompt building, think-token stripping
- Rewired client to use NewsServiceClient.summarizeArticle() with identical fallback chain
- Deleted 5 legacy files (3 provider endpoints, shared handler factory, test file)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add SummarizeArticle proto + implement handler** - `6575477` (feat)
2. **Task 2: Rewire summarization client + delete 4 legacy files** - `4720f5e` (feat)

## Files Created/Modified
- `proto/worldmonitor/news/v1/summarize_article.proto` - SummarizeArticleRequest/Response messages
- `proto/worldmonitor/news/v1/service.proto` - Added SummarizeArticle RPC to NewsService
- `api/server/worldmonitor/news/v1/handler.ts` - Full summarizeArticle handler with provider dispatch, caching, prompt building
- `src/services/summarization.ts` - Rewired to NewsServiceClient.summarizeArticle()
- `src/services/desktop-readiness.ts` - Updated route references from legacy to sebuf
- `src/generated/client/worldmonitor/news/v1/service_client.ts` - Generated client with summarizeArticle method
- `src/generated/server/worldmonitor/news/v1/service_server.ts` - Generated server types with SummarizeArticle handler interface

### Deleted Files
- `api/groq-summarize.js` - Legacy Groq endpoint
- `api/ollama-summarize.js` - Legacy Ollama endpoint
- `api/openrouter-summarize.js` - Legacy OpenRouter endpoint
- `api/_summarize-handler.js` - Legacy shared handler factory
- `api/_summarize-handler.test.mjs` - Legacy test file

## Decisions Made
- Single SummarizeArticle RPC with `provider` field rather than per-provider RPCs -- matches research recommendation, simpler client
- Ported all prompt/cache/dedup logic directly into handler rather than importing from shared modules -- keeps handler self-contained and edge-compatible
- Preserved identical cache key strategy (v3 prefix, same hashString) for zero-downtime migration

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated desktop-readiness.ts route references**
- **Found during:** Task 2 (client rewiring)
- **Issue:** desktop-readiness.ts still referenced deleted `/api/{provider}-summarize` endpoints and handler files
- **Fix:** Updated apiRoutes and apiHandlers to point to sebuf endpoint `/api/news/v1/summarize-article` and handler
- **Files modified:** src/services/desktop-readiness.ts
- **Verification:** grep confirms no more references to old endpoints in src/
- **Committed in:** 4720f5e (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential fix to keep desktop-readiness config consistent with deleted files. No scope creep.

## Issues Encountered
- `buf generate` failed on full workspace due to pre-existing intelligence proto issue (missing `sebuf/ts/options.proto` import) -- worked around with `--path worldmonitor/news/v1/` flag to generate only news protos

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Step 5 (summarization migration) complete
- `_upstash-cache.js` has lost one of its two importers (the other being legacy files in steps yet to be migrated)
- Ready for step 4 (gdelt-doc migration) or other remaining steps

## Self-Check: PASSED

All created files verified present. All task commits verified in git log.

---
*Phase: 03-legacy-edge-function-migration*
*Completed: 2026-02-20*
