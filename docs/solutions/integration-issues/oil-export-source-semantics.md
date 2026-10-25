---
title: "Per-country oil export questions: JODI, PortWatch and Comtrade semantics traps"
date: 2026-10-18
category: docs/solutions/integration-issues/
module: energy oil trade series
problem_type: integration_issue
component: background_job
symptoms:
  - "MCP could not answer UAE oil exports, last 6 months vs the 6 before"
  - "Saudi, Kazakh, Nigerian and Venezuelan JODI crude exports were null"
  - "PortWatch showed Gulf crude terminals at zero calls"
  - "Comtrade mirror rows all dropped; reporterISO was null"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [jodi, comtrade, portwatch, eia-steo, oil, exports, mcp]
---

# Per-country oil export questions: JODI, PortWatch and Comtrade semantics traps

## Problem

Asked through MCP, "UAE oil exports, last 6 months vs the 6 before" failed (#9392). Each upstream source looked usable but carried a semantic trap that turned real data into null, or a coverage gap into a confident zero.

## Symptoms

- JODI kept only the newest month, and the UAE had no usable value in it.
- Countries with reported crude exports showed null.
- PortWatch showed Zirku Island and Jebel Dhanna at 0 tanker calls and Ruwais/Das down 100%, which read as "terminals dark".
- A first Comtrade mirror pull produced no reporters at all.

## What Didn't Work

- **Deeper JODI history for the UAE.** The UAE has filed only `-` placeholders since 2019-01. Its `CONVBBL` rows are conversion factors, not volumes.
- **PortWatch AIS as the export number.** Against declared figures it reads about 0.6x in normal months and about 0.3x for the UAE during the 2026 Hormuz closure (Kpler June 3.7 mb/d vs AIS 1.1). Pipeline exporters load in other countries' ports: Kazakhstan 0.04x, Azerbaijan 0.02x. Malaysia, a transshipment hub, reads 2.46x.
- **Filtering Comtrade rows on `isAggregate === true`.** That flag is true on every customs-code `C00` / transport-mode `0` total row, which are exactly the rows requested.
- **An 8x-median outlier screen on Comtrade.** Product trade moves in single cargoes, so a real month is often 10x a buyer's median. It dropped India's 573 kt of UAE products.
- **A matched-buyer basis that required every buyer in every recent month.** India files a month later than Japan, so India left the basis and UAE crude imports read −31% instead of −7.8%.

## Solution

PR #9393 (unmerged as of this writing):

- `scripts/seed-jodi-oil.mjs`: assessment code 3 is kept. Absence is a non-numeric cell (`parseObsValue` returns null for `-`, `..`, `x`).
- `scripts/seed-oil-trade-series.mjs`: four sources side by side, never blended.
  - EIA STEO `PAPR_<code>` production. EIA codes are FIPS-style: UAE `TC`, Iraq `IZ`, Kuwait `KU`, Oman `MU`.
  - Every month of JODI exports.
  - Comtrade monthly mirror, requested with `includeDesc=true`, because `reporterISO` is null without it.
  - PortWatch as an index.
  - A buyer-month above the exporter's production that month is dropped; with no production series, a 20x-median screen applies instead.
- `shared/oil-trade-windows.js`: the mirror basis starts from buyers that filed every month of the base window. It covers only recent months where all of them filed, and drops the buyer with the fewest filings only if coverage falls below half the window.

## Why This Works

- JODI documents code 1 as comparable, 2 as use with caution, and 3 as not assessed. Presence is a property of the cell value, not of the code.
- A physical limit (one buyer cannot receive more than the country produced) separates unit errors from lumpy cargoes. Thailand's 66.5 Mt in a month is about 16 mb/d against UAE production of about 4.3 mb/d.
- Dropping the unfiled newest month keeps the buyer set constant across windows, so a change in who files does not read as a change in exports.

## Prevention

- Before trusting a source for a country, check the raw file. Count numeric cells per year and code, not rows.
- Test fetch boundaries with recorded raw rows, not idealised fixtures. The `includeDesc` bug passed unit tests whose fixtures assumed `reporterISO` was always set.
- Reconcile each derived series against the raw source exactly (554/554 JODI values matched), and against an independent source within a stated tolerance.
- Never present AIS loadings or a partial buyer sample as an export total; carry `status` and `lastObserved` per source.

## Related Issues

- #9392, PR #9393
- `docs/solutions/integration-issues/comtrade-commodity-evidence-recovery.md`
- Follow-ups not in #9393: `scripts/seed-jodi-gas.mjs` has the same code-3 filter. `get_chokepoint_status` reports `cached_at` as the oldest key, so the static baselines registry dates live transit data to April.
