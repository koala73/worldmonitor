# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 3: Legacy Edge Function Migration (step 6/10 — macro-signals)

## Current Position

Phase: 3 (Legacy Edge Function Migration)
Current Plan: 3 of 5
Current Step: 6 of 10 (macro-signals → economic domain)
Status: In progress
Last activity: 2026-02-20 — Completed plan 03-02 (summarization migration)
Branch: feat/sebuf-integration

Progress: [██████████████░░░░░] 75%

## What's Done

**All 17 domain handlers + client wirings: COMPLETE**
- Phases 1-2L via GSD (seismology, wildfire, climate, prediction, displacement, aviation, research, unrest, conflict, maritime)
- Phases 2M-2S via direct commits (cyber, economic, infrastructure, market, military, news, intelligence)

**Post-domain additional migrations: COMPLETE**
- stock-index, opensky → market/military sebuf handlers
- etf-flows, stablecoin-markets → market sebuf handler
- worldpop-exposure → displacement sebuf handler
- theater-posture, intelligence, country-intel → sebuf clients
- Dead legacy files cleaned up

**Phase 3 Plan 01 (steps 3-4): COMPLETE**
- Step 3: wingbits → military domain (3 RPCs: GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus)
- Step 4: gdelt-doc → intelligence domain (SearchGdeltDocuments RPC)
- Deleted api/_ip-rate-limit.js (dead code)

**Phase 3 Plan 02 (step 5): COMPLETE**
- Step 5: summarization → news domain (SummarizeArticle RPC with multi-provider dispatch)
- Deleted 5 legacy files (3 provider endpoints, shared handler factory, test)
- Client rewired to NewsServiceClient.summarizeArticle()

## What Remains (Phase 3, steps 5-10)

**Migratable to sebuf RPCs:**
| Step | Legacy File(s) | Target Domain | RPCs | Effort |
|------|---------------|---------------|------|--------|
| ~~3~~ | ~~api/wingbits/ (3 files)~~ | ~~military~~ | ~~GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus~~ | ~~DONE~~ |
| ~~4~~ | ~~api/gdelt-doc.js~~ | ~~intelligence~~ | ~~SearchGdeltDocuments~~ | ~~DONE~~ |
| ~~5~~ | ~~api/*-summarize.js + _summarize-handler.js (4 files)~~ | ~~news~~ | ~~SummarizeArticle~~ | ~~DONE~~ |
| 6 | api/macro-signals.js | economic | GetMacroSignals | High |
| 7 | api/tech-events.js | research | ListTechEvents | High |
| 8 | api/temporal-baseline.js | infrastructure | GetTemporalBaseline, RecordBaselineSnapshot | Medium |

**Non-migratable (Vercel edge, non-JSON):**
- api/rss-proxy.js, api/fwdstart.js (RSS XML)
- api/story.js, api/og-story.js (HTML)
- api/download.js (redirects)
- api/version.js (simple JSON)

**Final cleanup (step 10):**
- Delete api/_cors.js, api/_upstash-cache.js (api/_ip-rate-limit.js already deleted)
- Update desktop-readiness.ts
- Sync/merge main

## Accumulated Context

### Key Decisions (Phase 3)
- Proto codegen: `cd proto && buf generate`
- Client construction: always `new XServiceClient('', { fetch: fetch.bind(globalThis) })`
- Handler pattern: `declare const process` at top, inline Upstash Redis helpers, in-memory caching
- Non-JSON endpoints (step 9): cannot move into api/server/ — Vercel file-based routing requires them in api/ root. Tag with comments instead.
- GDELT errors returned in-band via response error field (not HTTP errors), matching legacy behavior
- Proto files for simple types (string/int32/double) do not need sebuf/ts/options.proto import

### Blockers/Concerns
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-20
Stopped at: Completed 03-01-PLAN.md (wingbits commit + GDELT doc migration)
Resume file: .planning/phases/3-sebuf-legacy-migration/.continue-here.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: Execute 03-02-PLAN.md (summarization migration, step 5)
