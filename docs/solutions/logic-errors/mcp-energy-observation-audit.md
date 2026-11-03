---
title: ChatGPT energy observations omit quantities or misstate units
date: 2026-10-01
module: MCP energy tools
component: cache registry and energy seeders
problem_type: logic_error
tags: [mcp, energy, gas-storage, eia, units, chatgpt]
---

# ChatGPT plugin observation audit

Audit date is October 1, 2026. The registry contains 84 tools, including 34 cache tools. The registry screen checked cache-key declarations for index-only responses. This is not an exhaustive semantic certification of all 84 tools.

## Confirmed findings

Six ChatGPT tools have confirmed defects. There are seven root defects across those tools and their related producers.

| Finding | Evidence | Repair |
|---|---|---|
| Country gas observations omitted | Live `get_energy_intelligence` returned `{"_countries":["DE"]}`; the country scenario tool returned Germany at 57.92%, 143.4 TWh on September 29. The gas seeder already publishes country observations. | Publish an ISO2-keyed aggregate and return it as `gas-storage`. Preserve the coverage index. |
| Crude scale is wrong | Live `get_energy_storage` returned `stocksMb: 711087`. EIA reports thousand barrels. | Divide crude stock and weekly change by 1,000 at the producer. |
| Crude scope is wrong | The tool advertises commercial crude. The producer queries WCRSTUS1, which includes SPR. The dashboard adds SPR separately. | Query WCESTUS1, the commercial series excluding SPR. |
| EIA unit labels omitted | The live petroleum bundle returned empty units for all four series. The API returns `units`; the parser read `unit`. | Read `units` and spell out MBBL, MBBL/D and $/BBL. Preserve numerical source units in this bundle. |
| SPR scale is wrong | Direct EIA API returned 283767 thousand barrels for September 25. The parser passes the raw number to consumers that label it million barrels. | Divide the source value by 1,000. Compute changes from the converted values. |
| Refinery scale is wrong | Direct EIA API returned 16257 thousand barrels per day for September 25. The parser passes the raw number to a million-barrels-per-day consumer. | Divide the source value by 1,000. |
| Country without coverage returns all countries | Producer-shaped tool fixtures with Japan requested and only Germany seeded return Germany's values. The shared keyed-map selector returns its input when no key matches. This affects country macro, EU housing, EU government debt, EU industrial production, and energy intelligence. | Return an empty map for a valid country without records. Keep absent filters unchanged and reject unresolved country names. |

## Index audit

The 34 cache-tool declarations contain three index keys. Electricity's index contains dated region prices. Chokepoint's country index describes port coverage and accompanies transit observations. Gas storage is the only confirmed index-only observation defect in these declarations. The 50 other tools use RPCs or other execution paths and were not exhaustively queried.

## Live coverage

Sixteen additional live responses passed the current advertised output schemas with Ajv. The two energy tools were checked earlier. Eighteen distinct tools therefore have successful live observations in this investigation. Schema acceptance does not prove every quantity or source contract is correct. The broad audit exhausted the account's 50-call daily MCP quota. No quota changes or alternate credentials were used.

| Tool | Evidence |
|---|---|
| `get_market_data` | Live response sampled; advertised schema accepted it. |
| `get_conflict_events` | Live response sampled; advertised schema accepted it. |
| `get_aviation_status` | Live response sampled; advertised schema accepted it. |
| `get_news_intelligence` | Live response sampled; advertised schema accepted it. |
| `get_natural_disasters` | Live response sampled; advertised schema accepted it. |
| `get_military_posture` | Live response sampled; advertised schema accepted it. |
| `get_cyber_threats` | Live response sampled; advertised schema accepted it. |
| `get_economic_data` | Live response sampled; advertised schema accepted it. |
| `get_country_macro` | Live response sampled; advertised schema accepted it. |
| `get_eu_housing_cycle` | Live response sampled; advertised schema accepted it. |
| `get_eu_quarterly_gov_debt` | Live response sampled; advertised schema accepted it. |
| `get_eu_industrial_production` | Live response sampled; advertised schema accepted it. |
| `get_prediction_markets` | Live response sampled; advertised schema accepted it. |
| `get_sanctions_data` | Live response sampled; advertised schema accepted it. |
| `get_displacement_data` | Live response sampled; advertised schema accepted it. |
| `get_health_signals` | Live response sampled; advertised schema accepted it. |
| `get_energy_intelligence` | Live response checked before broad audit; later call blocked by quota. |
| `get_energy_storage` | Live response checked before broad audit; later call blocked by quota. |
| `get_climate_data` | Live call blocked by daily quota. |
| `get_imd_cyclone_marine` | Live call blocked by daily quota. |
| `get_infrastructure_status` | Live call blocked by daily quota. |
| `get_supply_chain_data` | Live call blocked by daily quota. |
| `get_tariff_trends` | Live call blocked by daily quota. |
| `get_chokepoint_status` | Live call blocked by daily quota. |
| `get_positive_events` | Live call blocked by daily quota. |
| `get_radiation_data` | Live call blocked by daily quota. |
| `get_research_signals` | Live call blocked by daily quota. |
| `get_forecast_predictions` | Live call blocked by daily quota. |
| `get_forecast_scorecard` | Live call blocked by daily quota. |
| `get_social_velocity` | Live call blocked by daily quota. |
| `get_temporal_anomalies` | Live call blocked by daily quota. |
| `get_test_site_seismicity` | Live call blocked by daily quota. |
| `get_toronto_reported_occurrences` | Live call blocked by daily quota. |
| `get_toronto_calls_attended` | Live call blocked by daily quota. |

## Verification and rollout

Regressions reproduce missing country observations and empty EIA units before repair. Producer fixtures use raw EIA thousand-barrel values. Country observations are checked through the MCP dispatcher and advertised schema. The gas publication test drives the real seed entry point and checks the aggregate against the same per-country payloads and coverage index.

The aggregate, coverage index, country keys, and freshness metadata publish through one MSET inside a Redis transaction with matching TTLs. Missing or invalid fill and storage measurements are rejected; measured zero remains valid. These two producer defects were confirmed during PR review. A failed seed extends existing content TTLs without refreshing its observation dates or freshness metadata.

All 340 selected tests passed, including the five no-coverage regressions. API type checking, schema coverage, bootstrap parity, the existing MCP suite, and diff whitespace checks passed. The proto source comment change also updates generated OpenAPI descriptions. No generated interface changes are required.

Production remains unchanged until an authorized deployment and successful producer runs. The gas aggregate is null until its first publication. Existing incorrect EIA snapshots remain until the corrected producer publishes. Seed scripts are not run against production in this task.

Primary source records are [commercial crude](https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?f=W&n=PET&s=WCESTUS1), [SPR](https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?f=W&n=PET&s=WCSSTUS1), and [refinery inputs](https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?f=W&n=PET&s=WCRRIUS2). The public EIA demo API also confirmed the units field and source series descriptions.
