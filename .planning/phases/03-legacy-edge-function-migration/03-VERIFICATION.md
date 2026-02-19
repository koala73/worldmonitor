---
phase: 03-legacy-edge-function-migration
verified: 2026-02-20T00:00:00Z
status: passed
score: 18/18 must-haves verified
re_verification: false
---

# Phase 3: Legacy Edge Function Migration — Verification Report

**Phase Goal:** Migrate remaining `api/*.js` legacy edge functions into sebuf domain RPCs or tag as non-migratable
**Verified:** 2026-02-20
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Wingbits migration committed (3 RPCs in military domain) | VERIFIED | Commit 1342730; handler has getAircraftDetails, getAircraftDetailsBatch, getWingbitsStatus; 3 api/wingbits/ files deleted |
| 2 | GDELT document search works via IntelligenceService.SearchGdeltDocuments RPC | VERIFIED | `handler.ts:666 async searchGdeltDocuments`; `gdelt-intel.ts:118 await client.searchGdeltDocuments()`; api/gdelt-doc.js deleted |
| 3 | Dead _ip-rate-limit.js is deleted | VERIFIED | File absent from filesystem |
| 4 | Summarization works via NewsService.SummarizeArticle RPC with provider parameter | VERIFIED | `handler.ts:446 async summarizeArticle`; `summarization.ts:54 await newsClient.summarizeArticle()`; 4 legacy files deleted |
| 5 | Client fallback chain (ollama->groq->openrouter) preserved | VERIFIED | `summarization.ts` iterates API_PROVIDERS with same order, calls same RPC 3 times with different provider values |
| 6 | Redis cache behavior preserved in summarization handler | VERIFIED | `handler.ts` has inline getCachedJson/setCachedJson with hashString, v3 prefix, 86400s TTL |
| 7 | Macro signals work via EconomicService.GetMacroSignals RPC | VERIFIED | `handler.ts:578 async getMacroSignals`; `MacroSignalsPanel.ts:143 await economicClient.getMacroSignals({})`; api/macro-signals.js deleted |
| 8 | All 7 macro signal computations and BUY/CASH verdict logic present | VERIFIED | Handler comment lists all 7 signals; verdict at `>=0.57 bullishCount/totalCount`; 6 parallel fetches via Promise.allSettled |
| 9 | Tech events work via ResearchService.ListTechEvents RPC | VERIFIED | `handler.ts:561 async listTechEvents`; `TechEventsPanel.ts:29 await researchClient.listTechEvents()`; api/tech-events.js deleted |
| 10 | 360-city geocoding lookup preserved in separate data file | VERIFIED | `api/data/city-coords.ts` exists with CITY_COORDS (360 entries); imported at `handler.ts:33` |
| 11 | Temporal baseline GET + POST work via InfrastructureService RPCs | VERIFIED | `handler.ts:612 async getTemporalBaseline`; `temporal-baseline.ts:78 await client.getTemporalBaseline()`; `temporal-baseline.ts:65 await client.recordBaselineSnapshot()` |
| 12 | Welford's algorithm and Redis mget preserved in infrastructure handler | VERIFIED | `handler.ts:76 async function mgetJson`; `handler.ts:696 mgetJson(keys)`; Welford delta/m2 pattern present |
| 13 | 6 non-JSON edge functions tagged with // Non-sebuf: comment | VERIFIED | All 6 files (rss-proxy, fwdstart, story, og-story, download, version) have `// Non-sebuf: returns XML/HTML, stays as standalone Vercel function` on line 1 |
| 14 | _upstash-cache.js deleted (all importers removed) | VERIFIED | File absent; only surviving reference is a comment in news handler noting the hash utility was ported from it |
| 15 | desktop-readiness.ts updated to reflect sebuf API routes | VERIFIED | wingbits uses `/api/military/v1/get-aircraft-details`; no stale legacy paths for any migrated domain |
| 16 | No remaining fetch('/api/...') calls to migrated endpoints in src/ | VERIFIED | Grep for all legacy paths (`gdelt-doc`, `wingbits`, `macro-signals`, `tech-events`, `temporal-baseline`, `groq-summarize`, `ollama-summarize`, `openrouter-summarize`) returns no matches in src/ |
| 17 | All 8 implementation commits exist in git | VERIFIED | 1342730, dc087d3, 6575477, 4720f5e, d05499c, d4391e6, 4adb19f, f96a64e, 041e4af all present in git log |
| 18 | All migratable legacy api/*.js files removed | VERIFIED | Remaining api/*.js are catch-all gateway, _cors.js, and 6 tagged non-sebuf files — no untagged legacy endpoints |

**Score:** 18/18 truths verified

---

## Required Artifacts

### Plan 01: Wingbits + GDELT

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/military/v1/get_aircraft_details.proto` | Aircraft details proto | VERIFIED | File present |
| `proto/worldmonitor/military/v1/get_aircraft_details_batch.proto` | Batch aircraft proto | VERIFIED | File present |
| `proto/worldmonitor/military/v1/get_wingbits_status.proto` | Wingbits status proto | VERIFIED | File present |
| `proto/worldmonitor/intelligence/v1/search_gdelt_documents.proto` | GDELT search proto | VERIFIED | Contains `SearchGdeltDocumentsRequest` |
| `api/server/worldmonitor/intelligence/v1/handler.ts` | searchGdeltDocuments RPC handler | VERIFIED | Line 666: async searchGdeltDocuments implementation |
| `src/services/gdelt-intel.ts` | Client rewired to IntelligenceServiceClient | VERIFIED | Line 4: import, Line 87: client instantiation, Line 118: RPC call |

### Plan 02: Summarization

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/news/v1/summarize_article.proto` | SummarizeArticleRequest/Response | VERIFIED | File present |
| `api/server/worldmonitor/news/v1/handler.ts` | summarizeArticle handler | VERIFIED | Line 446: async summarizeArticle |
| `src/services/summarization.ts` | Client rewired to NewsServiceClient | VERIFIED | Line 14: import, Line 28: client, Lines 54 + 229: RPC calls |

### Plan 03: Macro Signals

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/economic/v1/get_macro_signals.proto` | GetMacroSignalsRequest/Response | VERIFIED | File present |
| `api/server/worldmonitor/economic/v1/handler.ts` | getMacroSignals handler | VERIFIED | Line 578: async getMacroSignals |
| `src/components/MacroSignalsPanel.ts` | Consumer rewired to EconomicServiceClient | VERIFIED | Line 4: import, Line 25: client, Line 143: RPC call |

### Plan 04: Tech Events

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/research/v1/list_tech_events.proto` | ListTechEventsRequest/Response | VERIFIED | File present |
| `api/server/worldmonitor/research/v1/handler.ts` | listTechEvents handler with ICS+RSS | VERIFIED | Line 561: async listTechEvents |
| `api/data/city-coords.ts` | 360-city geocoding lookup table | VERIFIED | CITY_COORDS exported; 360 entries confirmed |
| `src/components/TechEventsPanel.ts` | Consumer rewired to ResearchServiceClient | VERIFIED | Line 4: import, Line 9: client, Line 29: RPC call |

### Plan 05: Temporal Baseline + Cleanup

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proto/worldmonitor/infrastructure/v1/get_temporal_baseline.proto` | GetTemporalBaselineRequest/Response | VERIFIED | File present |
| `proto/worldmonitor/infrastructure/v1/record_baseline_snapshot.proto` | RecordBaselineSnapshotRequest/Response | VERIFIED | File present |
| `api/server/worldmonitor/infrastructure/v1/handler.ts` | getTemporalBaseline + recordBaselineSnapshot | VERIFIED | Lines 612 + ~700: both handlers; mgetJson at line 76 |
| `src/services/temporal-baseline.ts` | Client rewired to InfrastructureServiceClient | VERIFIED | Line 5: import, Line 25: client, Line 78: getTemporalBaseline, Line 65: recordBaselineSnapshot |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/services/gdelt-intel.ts` | `api/server/worldmonitor/intelligence/v1/handler.ts` | `client.searchGdeltDocuments()` | WIRED | Line 118: `await client.searchGdeltDocuments({...})` |
| `src/services/summarization.ts` | `api/server/worldmonitor/news/v1/handler.ts` | `newsClient.summarizeArticle({ provider })` | WIRED | Lines 54, 229: `await newsClient.summarizeArticle({...})` |
| `api/server/worldmonitor/news/v1/handler.ts` | Upstash Redis | `getCachedJson/setCachedJson inline helpers` | WIRED | Lines 40, 57, 86: getCachedJson, setCachedJson, hashString all present |
| `src/components/MacroSignalsPanel.ts` | `api/server/worldmonitor/economic/v1/handler.ts` | `economicClient.getMacroSignals()` | WIRED | Line 143: `await economicClient.getMacroSignals({})` |
| `src/components/TechEventsPanel.ts` | `api/server/worldmonitor/research/v1/handler.ts` | `researchClient.listTechEvents()` | WIRED | Line 29: `await researchClient.listTechEvents({...})` |
| `api/server/worldmonitor/research/v1/handler.ts` | `api/data/city-coords.ts` | `import CITY_COORDS` | WIRED | Line 33: `import { CITY_COORDS, type CityCoord } from '../../../../data/city-coords'` |
| `src/services/temporal-baseline.ts` | `api/server/worldmonitor/infrastructure/v1/handler.ts` | `client.getTemporalBaseline()` and `client.recordBaselineSnapshot()` | WIRED | Line 78: getTemporalBaseline; Line 65: recordBaselineSnapshot |
| `api/server/worldmonitor/infrastructure/v1/handler.ts` | Upstash Redis | `getCachedJson/setCachedJson/mgetJson inline helpers` | WIRED | Lines 40, 57, 76: all three helpers; used at lines 634, 696, 714 |

---

## Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|----------------|-------------|--------|----------|
| CLEAN-02 | 01, 02, 03, 04, 05 | Legacy api/*.js Vercel edge functions removed after catch-all handler covers functionality | SATISFIED | 10 legacy files deleted: 3 wingbits, gdelt-doc.js, _ip-rate-limit.js, groq/ollama/openrouter-summarize.js, _summarize-handler.js, macro-signals.js, tech-events.js, temporal-baseline.js, _upstash-cache.js. 6 non-migratable files tagged. Only valid api/*.js remain. |
| DOMAIN-04 | 03 | Economic domain proto with FRED/World Bank/EIA RPCs | SATISFIED | GetMacroSignals added to EconomicService. Proto imports get_macro_signals.proto. Handler implements 7-signal dashboard. This extends the pre-existing economic domain. |
| DOMAIN-09 | 02 | News domain proto with RSS aggregation + AI summarization | SATISFIED | SummarizeArticle RPC added to NewsService. Multi-provider dispatch (ollama/groq/openrouter) with Redis caching. Proto fully registered in news/v1/service.proto. |
| DOMAIN-10 | 01, 02, 03, 04, 05 | Proto messages match existing TypeScript interfaces in src/types/index.ts | SATISFIED | All RPCs mirror existing JSON response shapes. MapProtoToData() added in MacroSignalsPanel to handle optional->null conversion. Client responses map directly to existing component interfaces. |

**Notes on REQUIREMENTS.md traceability table discrepancies:** The REQUIREMENTS.md traceability table lists DOMAIN-10 as Phase 3, CLEAN-02 as Phase 8, DOMAIN-04 as Phase 6, and DOMAIN-09 as Phase 7. These appear to be pre-existing categorization artifacts from an earlier roadmap version — the actual PLAN frontmatter correctly claims these IDs for Phase 3 work, and the implementations satisfy all four requirements.

---

## Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `api/ollama-summarize.test.mjs` | References deleted `./ollama-summarize.js`; orphaned test file | Warning | Does not block phase goal. Test file was noted as deleted in plan 02 summary, but `ollama-summarize.test.mjs` (as opposed to `_summarize-handler.test.mjs`) was not listed for deletion and remains. Running the test would fail. |

No blocker anti-patterns found. No TODO/FIXME/PLACEHOLDER patterns found in any new handler files.

---

## Human Verification Required

None — all phase deliverables are programmatically verifiable (file existence, content patterns, wiring). The following are informational notes for manual follow-up:

### 1. Redis cache round-trip for SummarizeArticle

**Test:** Issue a summarization request, observe "cached: true" on second identical request within 24h.
**Expected:** Handler reads from Redis on cache hit, returns response with `cached: true`.
**Why human:** Cannot run Upstash Redis in static analysis. Cache key correctness (hashString, v3 prefix) is verified by code inspection only.

### 2. Ollama fallback chain behavior

**Test:** With Ollama unavailable, confirm request falls through to Groq, then OpenRouter.
**Expected:** `summarizeArticle` called 3 times with different provider values; response uses last successful provider.
**Why human:** Requires live provider endpoints with controlled availability.

### 3. Welford z-score anomaly detection

**Test:** Feed 15+ baseline snapshots for a type, then send a count 3x the baseline mean.
**Expected:** getTemporalBaseline returns anomaly with severity "high" or "critical".
**Why human:** Requires Redis state accumulation across multiple calls.

---

## Gaps Summary

None. All phase must-haves verified.

---

## Final Assessment

Phase 3 goal is **fully achieved**. All migratable `api/*.js` legacy edge functions have been migrated into typed sebuf RPCs across five domain handlers (intelligence, news, economic, research, infrastructure). Non-migratable files (rss-proxy, fwdstart, story, og-story, download, version) are correctly tagged with `// Non-sebuf:` headers. All shared utility files (`_upstash-cache.js`, `_ip-rate-limit.js`) are deleted. The catch-all gateway (`api/[[...path]].ts`) now routes all migrated functionality.

One minor orphaned artifact exists: `api/ollama-summarize.test.mjs` references the deleted `ollama-summarize.js` and will fail if executed. This is a warning-level finding that does not block the phase goal.

---

_Verified: 2026-02-20_
_Verifier: Claude (gsd-verifier)_
