---
title: "BIS WS_LBS_D_PUB does publish bilateral counterparty-country series"
date: 2026-10-18
category: integration-issues
module: scripts/seed-bis-lbs.mjs
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - "scripts/seed-bis-lbs.mjs header says WS_LBS_D_PUB only exposes counterparty as the aggregate 5J"
  - "Bilateral cross-border bank flows (one country's banks vs another country's residents) looked unavailable, pushing work onto WS_CBS_PUB"
root_cause: inadequate_documentation
resolution_type: documentation_update
related_components:
  - service_object
tags:
  - bis
  - lbs
  - sdmx
  - imf
  - bop
  - capital-flows
  - counterparty
---

# BIS WS_LBS_D_PUB does publish bilateral counterparty-country series

## Problem

The header of `scripts/seed-bis-lbs.mjs` stated that the BIS Locational Banking Statistics dataflow `WS_LBS_D_PUB` only exposes the counterparty country as the aggregate `5J`, and that this is why the seeder moved to `WS_CBS_PUB`. That was wrong; the header now says so, and `scripts/seed-capital-flows.mjs` reads the bilateral series. A live query on 2026-10-18 returned bilateral series by reporting country × counterparty country × counterparty sector through 2026-Q1.

## Symptoms

- Anyone reading the seeder concludes that bilateral bank-flow data (who deposits where) does not exist publicly.
- Bilateral capital-flow work looked blocked on BIS data when it is not.

## What Didn't Work

- The original probe behind the `seed-bis-lbs.mjs` comment is not recorded, so its exact key is unknown. It does not reproduce: on 2026-10-18 an empty `L_CP_COUNTRY` position (`Q.S.C.A.TO1.A.5J.A.GB.A..N`) returned 228 counterparty countries, not just `5J`.

## Solution

Query the counterparty dimension, named or empty. The LBS key has 12 dimensions (from `dataflow/BIS/WS_LBS_D_PUB/1.0?references=datastructure`):

```
FREQ.L_MEASURE.L_POSITION.L_INSTR.L_DENOM.L_CURR_TYPE.L_PARENT_CTY.L_REP_BANK_TYPE.L_REP_CTY.L_CP_SECTOR.L_CP_COUNTRY.L_POS_TYPE
```

Example: non-bank and household deposits placed by residents of two counterparty countries in banks of every reporting country, as stocks and adjusted flows:

```
https://stats.bis.org/api/v1/data/WS_LBS_D_PUB/Q.F+S.L.A.TO1.A.5J.A..N+H.<CP1>+<CP2>.N?startPeriod=2015-Q1
```

Codes that matter:

- `L_MEASURE`: `S` = stocks, `F` = FX- and break-adjusted change (use this as the flow; raw stock differences mix in currency moves), `G` = growth rate, `B` = breaks.
- `L_POSITION`: `L` = liabilities (deposits placed by counterparty residents), `C` = claims (lending to them).
- `L_CP_SECTOR`: `A` all, `B` banks, `N` non-banks, `H` households and NPISHs, `F` non-bank financial, `C` non-financial corporations.
- `L_REP_CTY`: `5A` = all reporting countries. Leaving it empty returns each reporter as its own series.
- `L_POS_TYPE`: `N` = cross-border.
- Values are USD millions.

Only about 30 reporting systems publish a by-counterparty breakdown. For any other banking system, residents' positions are visible only from those 30 systems' side; deposits placed in its own banks are not. Some systems report to the BIS but publish aggregates only, so "is a BIS reporter" and "publishes bilateral data" are different tests.

### Related IMF SDMX 3.0 shapes (same research)

- `IMF.STA/BOP` dims are `COUNTRY.BOP_ACCOUNTING_ENTRY.INDICATOR.UNIT.FREQUENCY`. `A_NFA_T` = net acquisition of financial assets (gross outflows by residents); `L_NIL_T` = net incurrence of liabilities (gross inflows from non-residents). Indicators: `D_F` direct investment, `P_F` portfolio, `O_F` other investment, `R_F` reserves, `EO` errors and omissions (under `NETCD_T`). Values are raw USD, **not millions**. Some economies report annual BOP only, so read annual as a fallback.
- `IMF.STA/PIP` (formerly CPIS) and `IMF.STA/DIP` (formerly CDIS) carry bilateral positions. Counterpart queries return aggregate rows such as `G001`, `U150` and `GX509` mixed with countries. Filter `COUNTRY` with `^[A-Z]{3}$` before summing a mirror.
- DIP mirror data for hubs is distorted by special-purpose entities: conduit economies (Hungary and the Netherlands among them) appear as top direct investors in hub economies, from pass-through positions. DIP also returns two `DV_TYPE`s: `O` is the reporter's own figure and `SCC` is the counterpart's figure for the same position, so fetch `O` only (fetching both for all pairs took over 4 minutes).

## Why This Works

LBS publishes each reporter × counterparty × sector combination as its own series. Empty positions in the key act as wildcards on both the reporter and counterparty dimensions; `5A` (all reporting countries) and `5J` (all counterparties) are separate aggregate codes, not what an empty position returns.

## Prevention

- Before declaring a BIS or IMF breakdown unavailable, record the exact key you probed and run it once with the dimension pinned to a concrete code and once left empty.
- Methodology caveat for any capital-flight feature: under BPM6 a person changing residence is not a transaction. Their wealth moves through "other changes in volume" in the IIP, so wealth migration is invisible in BOP flows by construction. In a financial centre, gross flows of hundreds of billions a quarter each way also swamp any such signal. Country-specific registries can measure it for one country; no cross-country official source exists.
- The Forbes-Warnock classifier (`scripts/_capital-flow-episodes.mjs`) back-tests at 9/15 on pre-registered crisis episodes (`node scripts/backtest-capital-flow-episodes.mjs`). It labels flight that takes the form of debt repayment as a stop (Russia 2014), so present its four states, not a single "flight" score.
