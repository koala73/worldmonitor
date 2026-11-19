---
noindex: true
---

# NBS National Data extraction evidence

Checked on 2026-10-24. Production is unchanged. This is an offline extraction tool, not an enabled seeder source.

The [NBS terms](https://www.stats.gov.cn/english/nbs/200701/t20070104_59236.html), section III, permit downloading and using its statistical data and identify National Data as an official database. Attribute the data to the National Bureau of Statistics and `www.stats.gov.cn`. This permission concerns the statistical data; it does not grant rights to republish application code or bypass authentication. The database's `/robots.txt` returned HTTP 404 over verified HTTPS. Anonymous table definitions and table queries returned HTTP 200 without credentials or cookies. The download button requires a login and was not used.

## Exact supported observations

The [monthly database](https://data.stats.gov.cn/dg/website/page.html#/pc/national/monthData) contains these four matching series. Trade table notes identify the General Administration of Customs as the underlying source. Extraction retains the actual NBS retrieval URL and indicator IDs; it does not claim a direct PBOC or GACC retrieval.

| Canonical series | NBS field | Conversion | August 2026 |
| --- | --- | --- | ---: |
| `pboc_m2_yoy` | 货币和准货币 (M2) 供应量_同比增长 (%) | none | 7.5% |
| `gacc_exports` | 出口总值当期值 (千美元) | divide by 1,000 | USD 401,440.957 million |
| `gacc_imports` | 进口总值当期值 (千美元) | divide by 1,000 | USD 282,355.763 million |
| `gacc_trade_balance` | 进出口差额当期值 (千美元) | divide by 1,000 | USD 119,085.194 million |

Quoted from the website of the National Bureau of Statistics: www.stats.gov.cn.

The captured September cells are empty. They stay null; August values are not relabeled as September. Trade balance is a separately published cell, not a calculated proxy. The extractor validates indicator identity, table, unit, monthly measure and national region. Cumulative totals, stock measures and growth measures cannot substitute for a monthly amount.

## Run without network or production access

```sh
node scripts/china-macro/extract-nbs-national-data.mjs \
  tests/fixtures/china-macro/nbs-national-data/trade-202608-202609.json \
  2026-10-24T04:27:10.195Z

node --test tests/china-macro-national-data.test.mjs
```

Use Node 24. The fixture manifest records the exact public request, retrieval time and SHA-256 of each unmodified response. The CLI reads a saved response and writes JSON to stdout. It does not fetch, load credentials or write Redis. Its attribution record has `catalogActive: false`, so it does not add a live provider or change product counts. Empty cells in the retrieval month remain unavailable; populated cells from an unfinished month and all later months are rejected.

## Remaining activation gates

The public response has no source publication timestamp or revision timestamp. `daterange_sdate` is the historical start of the series (1995 for trade, 1999 for M2); it is not a release clock. Every extraction therefore has `canonicalEligible: false` and explicit unknown publication and revision claims. A dated official release/export, or supported source metadata binding the exact values and period to their publication, is still needed. The current canonical contract does not require a separate provider revision timestamp: revision tracking can use its existing immutable vintages and content hashes once the publication and source binding are valid. Then the producer and reader contracts must explicitly support NBS republication and its cadence before activation. Existing canonical allowlists, freshness budgets, required-series gate and seed publication are unchanged.

No matching permitted feed was established for `pboc_aggregate_financing_flow`, `pboc_new_rmb_loans` or `pboc_policy_liquidity_operation`. The inspected NBS monthly financial catalog contains money supply, not those three observations. The first two require monthly CNY 100 million flows; the third requires a dated operation in that unit. Cumulative financing, loan balances and general monetary-policy commentary do not satisfy those contracts.

Direct PBOC retrieval remains denied by its current robots policy. Direct GACC access remains blocked by a certificate chain that is not trusted and a certificate whose name does not match the requested host. Neither was bypassed. NBS provides a separate permitted statistical-data route for the four supported numeric series; the two original-host problems do not justify changing TLS or crawler identity.
