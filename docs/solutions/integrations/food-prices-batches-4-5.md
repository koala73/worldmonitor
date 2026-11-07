---
title: Food-price batches 4 and 5
module: Food prices
component: data_ingestion
problem_type: integration
date: 2026-11-05
tags: [food-prices, railway, fews-net, pricecatcher, cpi]
---

The food-price card extends issues #10112 and #10146 through the same registry,
GetFoodPrices reader, and macro seed bundle used by #9841 and #10050.

| Publisher | Source IDs | Card behavior |
| --- | --- | --- |
| FEWS NET Data Warehouse | `fewssd`, `fewsss`, `fewsye`, `fewsht` | Sudan, South Sudan, Yemen and Haiti monthly market context. Public food observations only; publisher common-unit prices retain local currency. Collecting organisation, market, product, origin and retail/wholesale type remain separate. |
| Taiwan MOA | `twmoa` | Daily cabbage, tomato and banana wholesale transaction averages in TWD/kg. Crop and market codes distinguish series; ROC dates become Gregorian dates. |
| Georgia Geostat | `geostat` | Food and non-alcoholic beverages CPI month-on-month summary; workbook discovered from the category page. |
| Malaysia KPDN PriceCatcher | `pricecatcher` | Median across unique reporting premises for standard cleaned chicken, tomatoes and grade A eggs (30 pieces). At least ten premises per item/day; excludes the current Malaysian calendar day. This is a reporting-sample median, not a representative national estimate. |
| Mercado Central de Buenos Aires | `mcba` | Daily modal fruit/vegetable wholesale prices in ARS/kg. Discovers monthly archives and dates each XLS from its header. Omits unweighed packs, summary rows and conflicting duplicate series. |
| Ireland CSO | `cso` | Monthly average retail food prices in EUR, with original pack sizes. Excludes alcohol, tobacco, fuel and services. |
| Luxembourg STATEC | `statec` | Annual June food-price benchmark, including original pack sizes. Explicit English language header avoids the publisher's `languageTag1` error with Node fetch's default language wildcard. |
| Switzerland FOAG | `foagfruit`, `foagegg`, `foagmilk` | Monthly fruit/vegetables/potatoes, eggs, and milk/dairy prices. Product, production system, properties, method, data source, use, tax, foreign trade, region and origin distinguish series. Centimes become CHF; publisher English labels preferred, German retained when English is absent. |
| Latvia CSB | `csblv` | Monthly retail food and non-alcoholic beverage prices in EUR, preserving package units and indexing the response's dimension order. |
| North Macedonia MakStat | `makstat` | Food CPI month-on-month and year-on-year summaries. Selects the latest explicit metadata month; this publisher's `top=1` selects the oldest month. |

Monthly and annual records remain dated context without weekly percentages.
CPI summaries carry no currency price. Monthly market selectors keep markets and
retail/wholesale types separate. Daily comparisons still require the exact same
series seven days earlier. Current-month and previous-month archives support
baselines across month boundaries; missing older archives leave current quotes
available without fabricating a baseline. During the first fourteen days of a
month, unpublished Argentina archives can fall back to the previous month's
dated reports; malformed current archives still fail closed.

FEWS NET and MakStat never seeded from Railway: the FEWS Data Warehouse answers
Railway's egress with HTTP 403 (200 from other networks) and Railway cannot
resolve `makstat.stat.gov.mk` (ENOTFOUND, then connect timeouts). Their adapters
set `proxy: true`, so `collectFoodSource` sends their requests proxy-first through
`PROXY_URL` with the shared `proxyFetch` CONNECT tunnel, which resolves the
publisher host at the proxy. Each request starts at a random Decodo sticky exit
and moves to the next one on a tunnel failure, a timeout or a publisher 403, up
to three exits. Each exit has its own timeout and a share of the remaining source
budget, so one hung exit cannot use up the time the others need. A gateway 4xx stops at once. A direct request is made only when no exit
reached the publisher. Without `PROXY_URL` (local runs) these sources fetch
directly. Other food sources never use the proxy.

Initial fetch failures write an NX error receipt without a success timestamp or
activation marker, so health reports `SEED_ERROR` before the first publish while
preserving any existing success metadata.
The existing source-specific activation markers, seed metadata, retention,
content-age checks and reader statuses apply. A regressing CPI report now retains
the previous snapshot just as regressing price reports do. Multi-country context
collections retain a regressed country's last-good brief and mark its fetch as
failed while allowing other countries to advance. New registrations are
in the existing macro service, with no additional Railway service. A 10:00 UTC
tick rotates its first macro member using the existing leased Redis cursor;
completed failed ticks advance the cursor too. The 08:00 tick retains Physical's
priority and Sunday's Education priority, and Physical still leads the 09:00 retry.
Bounded freshness prefetch and a 550-second runner budget reserve time to
acknowledge the cursor before the 600-second container deadline. This prevents never-seeded food
sources from permanently losing admission to earlier due sections.
Source terms remain marked `terms-review` in the committed
`shared/source-attribution-manifest.json`; this change does not
assert new redistribution permissions.

Verification on 2026-11-05 included a successful read-only public collection for
each of the 15 source IDs, without Redis writes. Fixture tests exercise the real
Parquet/Brotli and legacy XLS decoders, calendar and unit handling, exclusions,
dimension changes, malformed/future reports and CPI-only collection. The browser
tests control API responses and exercise real card rendering at desktop and
mobile widths. They do not prove a deployed Edge response, production activation
or naturally scheduled freshness. Taiwan's source endpoint needs up to 60 seconds
per request; the overall source deadline still applies.

Focused checks:

```sh
node --import tsx --test tests/food-prices-*.test.mjs tests/food-prices-handler.test.mts
npm run test:dom -- tests/dom/food-prices-card.test.mts
npx playwright test e2e/food-prices.spec.ts --project=chromium
npm run test:railway-registry
node --import tsx --test --test-concurrency=2 tests/health-verdict-snapshot.test.mjs tests/health-classify.test.mjs
npm run typecheck
npm run typecheck:api
npm run lint:boundaries
npm run generate
npm run docs:check
```
