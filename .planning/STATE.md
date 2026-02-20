# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 4: V1 Milestone Cleanup -- PHASE COMPLETE (verified)

## Current Position

Phase: 4 (V1 Milestone Cleanup)
Current Plan: 2 of 2 -- COMPLETE
Status: Phase complete
Last activity: 2026-02-20 -- Phase 4 verified and complete. All audit gaps closed.
Branch: feat/sebuf-integration

Progress: [████████████████████] 100%

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

**Phase 3 Plan 05 (steps 8-10): COMPLETE**
- Step 8: temporal-baseline → infrastructure domain (GetTemporalBaseline + RecordBaselineSnapshot RPCs)
- Welford's online algorithm ported exactly, mgetJson for batch Redis reads
- temporal-baseline.ts rewired to InfrastructureServiceClient
- Deleted api/temporal-baseline.js, api/_upstash-cache.js
- Step 9: 6 non-JSON edge functions tagged with // Non-sebuf: comment
- Step 10: desktop-readiness.ts updated, final cleanup complete

**Phase 4 Plan 01: Documentation + Verification + Cleanup: COMPLETE**
- ROADMAP.md Phase 3 heading fixed (IN PROGRESS -> COMPLETE), plans 03-03/04/05 checked
- Retroactive 2L-VERIFICATION.md created (12/12 truths verified)
- desktop-readiness.ts stale references fixed (map-layers-core, market-panel, opensky-relay-cloud)
- Service barrel completed (5 domain re-exports added: conflict, displacement, research, wildfires, climate)
- .continue-here.md deleted

**Phase 4 Plan 02: COMPLETE**
- Circuit breakers added to all 6 remaining domains: seismology, wildfire, climate, maritime, news (summarization), intelligence (gdelt-intel)
- CLIENT-03 requirement fully satisfied: 17/17 domains have circuit breaker coverage
- Manual try/catch blocks replaced with breaker.execute in wildfire, climate, GDELT
- Maritime breaker wraps only proto RPC path, preserving raw relay fallback
- Summarization breaker wraps individual RPC calls within multi-provider fallback chain

## What Remains (Phase 3)

**ALL STEPS COMPLETE.** Phase 3 legacy edge function migration is finished.

All migratable legacy edge functions now use sebuf RPCs:
| Step | Legacy File(s) | Target Domain | RPCs | Status |
|------|---------------|---------------|------|--------|
| ~~3~~ | ~~api/wingbits/ (3 files)~~ | ~~military~~ | ~~GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus~~ | ~~DONE~~ |
| ~~4~~ | ~~api/gdelt-doc.js~~ | ~~intelligence~~ | ~~SearchGdeltDocuments~~ | ~~DONE~~ |
| ~~5~~ | ~~api/*-summarize.js + _summarize-handler.js (4 files)~~ | ~~news~~ | ~~SummarizeArticle~~ | ~~DONE~~ |
| ~~6~~ | ~~api/macro-signals.js~~ | ~~economic~~ | ~~GetMacroSignals~~ | ~~DONE~~ |
| ~~7~~ | ~~api/tech-events.js~~ | ~~research~~ | ~~ListTechEvents~~ | ~~DONE~~ |
| ~~8~~ | ~~api/temporal-baseline.js~~ | ~~infrastructure~~ | ~~GetTemporalBaseline, RecordBaselineSnapshot~~ | ~~DONE~~ |

**Non-migratable (tagged with // Non-sebuf:):**
- api/rss-proxy.js, api/fwdstart.js (RSS XML)
- api/story.js, api/og-story.js (HTML)
- api/download.js (redirects)
- api/version.js (simple JSON)

**Cleanup complete:**
- api/_upstash-cache.js deleted (no importers remain)
- api/_ip-rate-limit.js deleted (in plan 01)
- api/_cors.js retained (still used by non-JSON files)
- desktop-readiness.ts updated

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
- Inline mgetJson Redis helper for batch reads via Upstash REST POST pipeline
- Non-JSON files tagged with `// Non-sebuf:` header comment for grep-ability
- api/_cors.js retained (still needed by non-JSON standalone Vercel functions)

### Key Decisions (Phase 4)
- Skip military/intelligence/news barrel re-exports to avoid duplicate export collisions with existing individual re-exports
- Fix opensky-relay-cloud entry in desktop-readiness.ts (beyond plan spec) because must_haves required no opensky.js references
- Circuit breaker wraps individual RPC calls, not entire fallback chains (summarization)
- Maritime breaker wraps only proto getVesselSnapshot, not raw relay candidateReports path
- Climate always returns ok:true with breaker since cached/fallback is intentional graceful degradation
- GDELT query-specific articleCache coexists with breaker's RPC-level cache (different purposes)

### Blockers/Concerns
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-20
Stopped at: Completed 04-02-PLAN.md (circuit breaker coverage for remaining 6 domains) -- Phase 4 COMPLETE
PR: #106 (draft) -- https://github.com/koala73/worldmonitor/pull/106
Next steps: Phase 4 complete. All v1 milestone cleanup done. Merge feat/sebuf-integration branch.
