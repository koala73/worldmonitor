---
status: pending
priority: p3
issue_id: "029"
tags: [code-review, performance, simulation-runner, llm]
---

# `getForecastLlmCallOptions` has no cases for `simulation_round_1` / `simulation_round_2`

## Problem Statement

`getForecastLlmCallOptions(stage)` maps stage names to provider order and model configuration. Every other pipeline stage (`combined`, `critical_signals`, `impact_expansion`, `market_implications`, etc.) has its own env override so operators can route that stage to a different model. The simulation runner uses `'simulation_round_1'` and `'simulation_round_2'` as stage names, but both fall through to the `else` branch (default provider order). This means simulation stages cannot be independently routed to a more capable reasoning model in Phase 3 without a code change.

## Proposed Solution

```javascript
// In getForecastLlmCallOptions, add cases:
: stage === 'simulation_round_1' || stage === 'simulation_round_2'
    ? (process.env.FORECAST_LLM_SIMULATION_PROVIDER_ORDER
        ? parseForecastProviderOrder(process.env.FORECAST_LLM_SIMULATION_PROVIDER_ORDER)
        : globalProviderOrder || defaultProviderOrder)
```

This follows the exact pattern of every other named stage. No behavior change until `FORECAST_LLM_SIMULATION_PROVIDER_ORDER` is set.

## Acceptance Criteria

- [ ] `simulation_round_1` and `simulation_round_2` have explicit cases in `getForecastLlmCallOptions`
- [ ] `FORECAST_LLM_SIMULATION_PROVIDER_ORDER` env var controls simulation provider order when set
- [ ] Existing tests pass; no behavior change when env var is unset

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `getForecastLlmCallOptions` (~line 3920)

## Work Log

- 2026-03-24: Found by compound-engineering:review:performance-oracle in PR #2220 review
