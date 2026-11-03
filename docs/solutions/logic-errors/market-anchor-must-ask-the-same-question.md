---
title: "A market anchor that asks a different question lowers Brier without adding information"
date: 2026-10-06
category: logic-errors
module: scripts/seed-forecasts
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "Every one of 54 scored published-origin market anchors asked a different question from the forecast it calibrated"
  - "Cyber threat concentration forecasts were anchored to invasion and presidential-succession markets"
  - "A higher market blend weight lowered Brier, and a constant base rate beat the market price"
root_cause: missing_validation
resolution_type: code_fix
related_components: [testing_framework]
tags: [forecast, prediction-markets, calibration, brier, anchor-matching, scoring-artifact]
---

# A market anchor that asks a different question lowers Brier without adding information

## Problem

`calibrateWithMarkets` in `scripts/seed-forecasts.mjs` blended a prediction-market price into a forecast when the market shared a region and any semantic token. On the production ledger, every scored anchor was a different question. "Cyber threat concentration: United States" was anchored to a market on Nick Fuentes becoming President before 2045. "Cyber threat concentration: China" was anchored to "Will China invade Taiwan by December 31, 2027?". Fixed in #8882 for #7071.

## Symptoms

- All 54 scored published-origin anchors asked a different question from their forecast (analysis on #7071).
- The counterfactual for #7071 showed that raising the blend weight from 0.4 lowered Brier, which looked like evidence for a heavier market weight.
- A constant base rate (2 YES of 54, 3.7%) scored Brier 0.0357. The market price alone scored 0.0383.

## What Didn't Work

Reading the Brier improvement as market skill. The anchors won because long-dated, unrelated markets were priced low (0.10 to 0.18) and these forecasts almost never resolved YES. Blending toward any low number would have helped. The constant base rate beating the "market" exposed this. The weight change to 0.9 was not made.

## Solution

A market now anchors a forecast only when three rules all hold:

1. **Event class.** `MARKET_ANCHOR_EVENT_CLASSES` declares, per forecast domain, the event patterns a market title must resolve on. A domain with no entry gets no anchor. Cyber has none, because its forecasts resolve on a threat count and no market prices a count.
2. **Same subject.** The market title must name the forecast's own region. A shared macro-region tag or an entity-graph neighbour no longer counts.
3. **Settlement horizon.** The market must settle between emission and the forecast deadline plus `max(7d, horizon)` (`resolveMarketAnchorSettlementWindow`). A market with no `endDate` does not anchor.

`calibration` also records `internalProbability` and `marketBlendedProbability` so the blend's effect is auditable per entry. Replay on 2026-10-06 production inputs went from 45 anchors to 3 after the class and subject rules, and to 0 after the settlement rule. `tests/fixtures/forecast-market-anchor-replay.json` freezes that replay.

## Why This Works

Blending is only calibration when the market prices the same event, for the same subject, over the same window. Without that, the blend imports the base rate of an unrelated question. The three rules encode equivalence directly, and an empty anchor set is the honest result when no equivalent market exists.

## Prevention

- Before trusting a Brier gain from an external signal, score a constant base-rate baseline on the same cohort. If the constant wins, the signal is not adding information.
- Spot-check anchor pairs by reading the forecast title next to the market title. One mismatched pair in a sample is enough to stop a weight change.
- Keep the calibrate log buckets (`event_class`, `horizon`, `no_class_forecasts`) visible. A sudden rise in applied anchors means a matching rule loosened.
