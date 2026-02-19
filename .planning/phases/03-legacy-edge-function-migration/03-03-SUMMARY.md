---
phase: 03-legacy-edge-function-migration
plan: 03
subsystem: api
tags: [sebuf, proto, economic, macro-signals, yahoo-finance, fear-greed, mempool, rpc]

# Dependency graph
requires:
  - phase: 02-domain-handler-wiring
    provides: EconomicService with getFredSeries, listWorldBankIndicators, getEnergyPrices RPCs
provides:
  - GetMacroSignals RPC on EconomicService (7-signal macro dashboard)
  - MacroSignalsPanel rewired to EconomicServiceClient
  - Legacy api/macro-signals.js deleted
affects: [03-legacy-edge-function-migration]

# Tech tracking
tech-stack:
  added: []
  patterns: [proto-optional-to-null mapping for UI consumers]

key-files:
  created:
    - proto/worldmonitor/economic/v1/get_macro_signals.proto
  modified:
    - proto/worldmonitor/economic/v1/service.proto
    - api/server/worldmonitor/economic/v1/handler.ts
    - src/components/MacroSignalsPanel.ts
    - src/generated/client/worldmonitor/economic/v1/service_client.ts
    - src/generated/server/worldmonitor/economic/v1/service_server.ts
    - docs/api/EconomicService.openapi.yaml
    - docs/api/EconomicService.openapi.json

key-decisions:
  - "Used mapProtoToData() to convert proto optional (undefined) fields to null for UI rendering compatibility"
  - "Named sma helper smaCalc to avoid collision with potential global sma symbols"

patterns-established:
  - "Proto optional-to-null mapping: when UI consumers expect null for absent values, add a mapping function at the consumer boundary"

requirements-completed: [CLEAN-02, DOMAIN-04, DOMAIN-10]

# Metrics
duration: 5min
completed: 2026-02-20
---

# Phase 03 Plan 03: Macro Signals Migration Summary

**GetMacroSignals RPC with 7-signal dashboard (6 upstream APIs, 5min cache, BUY/CASH verdict) ported to EconomicService**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-19T23:05:54Z
- **Completed:** 2026-02-19T23:11:42Z
- **Tasks:** 2
- **Files modified:** 8 (+ 1 deleted)

## Accomplishments
- GetMacroSignals proto defined with 12 message types covering all 7 signal computations
- Handler implements all 7 signals (liquidity, flow structure, macro regime, technical trend, hash rate, mining cost, fear & greed) with 6 parallel upstream fetches via Promise.allSettled
- In-memory cache (5min TTL) and fallback behavior preserved identically
- BUY/CASH/UNKNOWN verdict logic preserved (>=0.57 bullish ratio = BUY)
- MacroSignalsPanel rewired from fetch('/api/macro-signals') to EconomicServiceClient.getMacroSignals()
- Legacy api/macro-signals.js deleted

## Task Commits

Each task was committed atomically:

1. **Task 1: Add GetMacroSignals proto + implement handler** - `dc087d3` (feat) -- Note: committed in prior session alongside 03-01 work
2. **Task 2: Rewire MacroSignalsPanel consumer + delete legacy file** - `d05499c` (feat)

## Files Created/Modified
- `proto/worldmonitor/economic/v1/get_macro_signals.proto` - 12 proto message types for macro signal dashboard
- `proto/worldmonitor/economic/v1/service.proto` - Added GetMacroSignals RPC to EconomicService
- `api/server/worldmonitor/economic/v1/handler.ts` - Implemented getMacroSignals with 6-source parallel fetch, 7 signal computations, cache, fallback
- `src/components/MacroSignalsPanel.ts` - Rewired to EconomicServiceClient with proto-to-null mapping
- `src/generated/client/worldmonitor/economic/v1/service_client.ts` - Generated client with getMacroSignals method
- `src/generated/server/worldmonitor/economic/v1/service_server.ts` - Generated server with getMacroSignals in handler interface
- `docs/api/EconomicService.openapi.yaml` - Updated OpenAPI spec
- `docs/api/EconomicService.openapi.json` - Updated OpenAPI spec
- `api/macro-signals.js` - DELETED (legacy edge function)

## Decisions Made
- Used `mapProtoToData()` function at the consumer boundary to convert proto optional fields (undefined) to null, preserving existing rendering code that checks `=== null`
- Named the SMA helper `smaCalc` instead of `sma` to avoid potential collision with the function name used in the legacy code and ensure clarity in the handler

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added doc comments to MacroSignals fields for buf lint compliance**
- **Found during:** Task 1 (proto creation)
- **Issue:** buf lint requires non-empty comments on all message fields; MacroSignals sub-message fields had no comments
- **Fix:** Added descriptive doc comments to all 7 fields in the MacroSignals message
- **Files modified:** proto/worldmonitor/economic/v1/get_macro_signals.proto
- **Verification:** `buf lint --path worldmonitor/economic/v1/` passes clean
- **Committed in:** dc087d3 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Minor lint compliance fix. No scope creep.

## Issues Encountered
- Task 1 work (proto + handler + codegen) was already committed in a prior session as part of commit dc087d3. Verified all files matched expected state and proceeded directly to Task 2.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Step 6 (macro-signals) complete. EconomicService now has 4 RPCs.
- Ready for step 7 (tech-events -> research domain) or other remaining migrations.

## Self-Check: PASSED

All created files verified present. All deleted files verified removed. All commit hashes found in git log.

---
*Phase: 03-legacy-edge-function-migration*
*Completed: 2026-02-20*
