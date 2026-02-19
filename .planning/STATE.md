# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 3: Legacy Edge Function Migration (step 8/10 — temporal-baseline)

## Current Position

Phase: 3 (Legacy Edge Function Migration)
Current Plan: 5 of 5
Current Step: 8 of 10 (temporal-baseline → infrastructure domain)
Status: In progress
Last activity: 2026-02-20 — Completed plan 03-04 (tech-events migration)
Branch: feat/sebuf-integration

Progress: [████████████████░░░] 85%

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

**Phase 3 Plan 03 (step 6): COMPLETE**
- Step 6: macro-signals → economic domain (GetMacroSignals RPC with 7-signal dashboard)
- 6 parallel upstream fetches (Yahoo Finance x4, Alternative.me, Mempool)
- In-memory cache (5min TTL), BUY/CASH/UNKNOWN verdict, fallback behavior preserved
- MacroSignalsPanel rewired to EconomicServiceClient
- Deleted api/macro-signals.js

**Phase 3 Plan 04 (step 7): COMPLETE**
- Step 7: tech-events → research domain (ListTechEvents RPC with ICS+RSS+curated)
- 360-city geocoding table extracted to api/data/city-coords.ts
- Techmeme ICS + dev.events RSS parsing + 5 curated events
- Deduplication, filtering (type/mappable/days/limit)
- TechEventsPanel + App.ts rewired to ResearchServiceClient
- Deleted api/tech-events.js (737 lines)

## What Remains (Phase 3, steps 8-10)

**Migratable to sebuf RPCs:**
| Step | Legacy File(s) | Target Domain | RPCs | Effort |
|------|---------------|---------------|------|--------|
| ~~3~~ | ~~api/wingbits/ (3 files)~~ | ~~military~~ | ~~GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus~~ | ~~DONE~~ |
| ~~4~~ | ~~api/gdelt-doc.js~~ | ~~intelligence~~ | ~~SearchGdeltDocuments~~ | ~~DONE~~ |
| ~~5~~ | ~~api/*-summarize.js + _summarize-handler.js (4 files)~~ | ~~news~~ | ~~SummarizeArticle~~ | ~~DONE~~ |
| ~~6~~ | ~~api/macro-signals.js~~ | ~~economic~~ | ~~GetMacroSignals~~ | ~~DONE~~ |
| ~~7~~ | ~~api/tech-events.js~~ | ~~research~~ | ~~ListTechEvents~~ | ~~DONE~~ |
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
- Single SummarizeArticle RPC with provider field instead of per-provider RPCs
- All prompt/cache/dedup logic ported inline into handler for edge-compatibility
- Proto optional-to-null mapping: use mapProtoToData() at consumer boundary when UI expects null not undefined
- Large data tables (geocoding, hex databases) extracted to api/data/*.ts for handler readability
- Used `buf generate --path` to generate single domain when full generate fails due to unrelated proto errors

### Blockers/Concerns
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-20
Stopped at: Completed 03-04-PLAN.md (tech-events migration)
Resume file: .planning/phases/3-sebuf-legacy-migration/.continue-here.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: Execute 03-05-PLAN.md (temporal-baseline migration, step 8 + non-JSON tagging + final cleanup)
