# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 3: Legacy Edge Function Migration (step 3/10 — wingbits)

## Current Position

Phase: 3 (Legacy Edge Function Migration)
Current Step: 3 of 10 (wingbits → military domain)
Status: In progress — paused, resuming
Last activity: 2026-02-20 — WIP commit, paused at step 3
Branch: feat/sebuf-integration (148 commits ahead of main, 0 behind)

Progress: [████████████░░░░░░░] 65%

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

## What Remains (Phase 3, steps 3-10)

**Migratable to sebuf RPCs:**
| Step | Legacy File(s) | Target Domain | RPCs | Effort |
|------|---------------|---------------|------|--------|
| 3 | api/wingbits/ (3 files) | military | GetAircraftDetails, GetAircraftDetailsBatch, GetWingbitsStatus | Medium |
| 4 | api/gdelt-doc.js | intelligence | SearchGdeltDocuments | Low |
| 5 | api/*-summarize.js + _summarize-handler.js (4 files) | news | SummarizeArticle | Medium |
| 6 | api/macro-signals.js | economic | GetMacroSignals | High |
| 7 | api/tech-events.js | research | ListTechEvents | High |
| 8 | api/temporal-baseline.js | infrastructure | GetTemporalBaseline, RecordBaselineSnapshot | Medium |

**Non-migratable (Vercel edge, non-JSON):**
- api/rss-proxy.js, api/fwdstart.js (RSS XML)
- api/story.js, api/og-story.js (HTML)
- api/download.js (redirects)
- api/version.js (simple JSON)

**Final cleanup (step 10):**
- Delete api/_cors.js, api/_upstash-cache.js, api/_ip-rate-limit.js
- Update desktop-readiness.ts
- Sync/merge main

## Accumulated Context

### Key Decisions (Phase 3)
- Proto codegen: `cd proto && buf generate`
- Client construction: always `new XServiceClient('', { fetch: fetch.bind(globalThis) })`
- Handler pattern: `declare const process` at top, inline Upstash Redis helpers, in-memory caching
- Non-JSON endpoints (step 9): cannot move into api/server/ — Vercel file-based routing requires them in api/ root. Tag with comments instead.

### Blockers/Concerns
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-20
Stopped at: Paused before starting step 3 (wingbits migration)
Resume file: .planning/phases/3-sebuf-legacy-migration/.continue-here.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: Implement step 3 — add 3 wingbits RPCs to military proto, generate, implement handler, rewire wingbits.ts, delete api/wingbits/
