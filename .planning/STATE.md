# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 2G: Displacement Migration (in progress)

## Current Position

Phase: 2G (Displacement Migration)
Current Plan: 01 of 02 complete
Status: Displacement handler implemented with UNHCR API pagination, aggregation, flow corridors; gateway wired
Last activity: 2026-02-19 -- Plan 2G-01 executed (execute-phase)

Progress: [███████████████] ~75%

## Performance Metrics

**Completed Phases:**
- Phase 1: Proto Foundation (2 plans, 7min total)
- Phase 2A: All Domain Protos (1 session)
- Phase 2B Plan 01: Server Infrastructure (2 tasks, 2min, 4 files created)
- Phase 2B Plan 02: Gateway Integration (2 tasks, 2min, 2 files created, 2 files modified)
- Phase 2B Plan 03: Sidecar Sebuf Bundle (2 tasks, 3min, 1 file created, 4 files modified)
- Phase 2C Plan 01: INT64_ENCODING_NUMBER (1 task, 14min, 81 files modified)
- Phase 2C Plan 02: Seismology Client Wiring (2 tasks, 9min, 10 files modified/deleted)
- Phase 2D Plan 01: Wildfire Handler (2 tasks, 2min, 7 files created/modified)
- Phase 2D Plan 02: Wildfire Consumer Wiring (2 tasks, 3min, 6 files created/modified/deleted)
- Phase 2E Plan 01: Climate Handler (2 tasks, 2min, 2 files created/modified)
- Phase 2E Plan 02: Climate Client Wiring (2 tasks, 3min, 9 files created/modified/deleted)
- Phase 2F Plan 01: Prediction Handler (2 tasks, 2min, 2 files created/modified)
- Phase 2F Plan 02: Prediction Consumer Wiring (2 tasks, 4min, 12 files created/modified/deleted)
- Phase 2G Plan 01: Displacement Handler (2 tasks, 2min, 2 files created/modified)

## Accumulated Context

### Decisions

- [2A]: Dropped dual-mode adapter approach entirely — no feature flags, no parity testing, direct migration per domain
- [2A]: 17 domains + core types (79 proto files total)
- [2A]: `enum_value` and `INT64_ENCODING_NUMBER` sebuf annotations not yet available in v0.6.0 — using plain enums and int64 for now
- [2A]: Enums follow existing TS union values as comments for future mapping
- [2A]: military_vessel.proto imports military_flight.proto for shared enums (MilitaryOperator, MilitaryConfidence, MilitaryActivityType)
- [2A]: No `oneof success/error` in responses — throw errors in handler, map with `onError`
- [2A]: All RPCs use POST, kebab-case paths under `/api/{domain}/v1/`
- [2A]: Test domain protos removed (served their Phase 1 purpose)
- [2B-01]: Defined RouteDescriptor locally in router.ts instead of importing from a generated file
- [2B-01]: Hardcoded CORS methods to 'POST, OPTIONS' since all sebuf routes are POST-only
- [2B-01]: Network/fetch errors detected via TypeError + message check for 502 upstream-down mapping
- [2B-02]: Dynamic imports in Vite plugin to lazily load handler modules inside configureServer
- [2B-02]: Separate tsconfig.api.json with empty types array to exclude vite/client from edge runtime code
- [2B-02]: sebufApiPlugin placed after youtubeLivePlugin in plugin array for correct middleware ordering
- [2B-03]: esbuild over tsc for bundling: tsc produces per-file .js output, sidecar needs single self-contained module
- [2B-03]: Gitignore bracket escaping: used [[] character class pattern since backslash escaping is unreliable for brackets
- [2C-01]: Vendored sebuf/http/annotations.proto locally with Int64Encoding extension -- BSR module lacks it
- [2C-01]: Removed buf.build/sebmelki/sebuf BSR dep, excluded vendored sebuf/ from lint
- [2C-01]: INT64_ENCODING_NUMBER applied to 34 time fields across 20 proto files (not population counts)
- [2C-01]: Seismology handler occurredAt returns number directly (no String() wrapper)
- [2C-02]: Port/adapter pattern: module exports functions backed by generated client, re-exports proto type
- [2C-02]: Consumers import Earthquake from @/services/earthquakes (the port), never the generated client directly
- [2C-02]: Inlined earthquake time filter in Map.ts -- filterByTime signature incompatible with proto type, removed as dead code
- [2D-01]: Confidence enum mapped as string union ('FIRE_CONFIDENCE_HIGH' etc.) matching generated FireConfidence type
- [2D-01]: Fire detection ID uses composite key (lat-lon-date-time) for uniqueness across regions
- [2D-01]: Graceful degradation returns empty list (no error) when API key is missing
- [2D-02]: toMapFires adapter preserves map layer shape without modifying 3 map components
- [2D-02]: Empty response heuristic: zero fireDetections treated as skipped matching legacy behavior
- [2D-02]: confidenceToNumber maps FIRE_CONFIDENCE_HIGH->95, NOMINAL->50, LOW->20 for map thresholds
- [2E-01]: Paired null filtering: only keep data points where both temp and precip are non-null at same index
- [2E-01]: Severity/type classification uses proto enum strings directly (ANOMALY_SEVERITY_EXTREME etc.)
- [2E-02]: Port/adapter directory pattern: src/services/climate/index.ts matching wildfires convention
- [2E-02]: Proto enum mapping (ANOMALY_SEVERITY_EXTREME -> extreme) keeps consumer code unchanged
- [2E-02]: getSeverityColor dropped as dead code; only getSeverityIcon and formatDelta preserved
- [2E-02]: minSeverity defaults to ANOMALY_SEVERITY_UNSPECIFIED to return all anomalies
- [2F-01]: Handler returns empty markets on ANY fetch failure -- Cloudflare JA3 blocking is expected, not an error
- [2F-01]: yesPrice in 0-1 proto scale; service module (Plan 02) will handle 0-1 to 0-100 consumer conversion
- [2F-01]: No error logging on Cloudflare failures to avoid noise in production logs
- [2F-02]: Strategy 4 in polyFetch replaced Vercel edge proxy with PredictionServiceClient; proto 0-1 yesPrice mapped through outcomePrices for uniform parseMarketPrice pipeline
- [2F-02]: getPolymarketStatus() dropped as confirmed dead code (exported but never imported)
- [2F-02]: Production fallback (strategy 5) kept pointing to worldmonitor.app/api/polymarket for now as safety net
- [2G-01]: Ported exact UNHCR pagination logic from legacy with 10,000/page limit and 25-page guard
- [2G-01]: Year fallback tries current year, then current-1, then current-2 until data found
- [2G-01]: All int64 displacement fields returned as String() matching generated DisplacementServiceHandler interface
- [2G-01]: Graceful empty response on ANY UNHCR API failure following established 2F-01 pattern

### Pending Todos

- None for Phase 2B (complete)

### Blockers/Concerns

- ~~`int64` time fields generate as `string` in client code~~ RESOLVED in 2C-01 via INT64_ENCODING_NUMBER
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-19
Stopped at: Completed 2G-01-PLAN.md
Resume file: .planning/phases/2G-displacement-migration/2G-01-SUMMARY.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: Execute 2G-02 (displacement consumer wiring, service module, legacy deletion).
