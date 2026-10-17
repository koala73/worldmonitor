# Data-source inventory: ingestion scripts, first half

Scope: the first 109 `scripts/seed-*.mjs` files in sort order (`seed-aaii-sentiment.mjs` through `seed-grocery-basket.mjs`), plus non-seed scripts whose names sort before `seed-m` and that fetch an upstream and write data. Source is `origin/main` at d49477575b (2026-10-09), checked out at `a clean checkout of origin/main`. All `file:line` citations are relative to `scripts/`. Nothing was run against production.

The relay (`ais-relay.cjs`, 15,203 lines) is inventoried separately in [`inventory-ais-relay.md`](inventory-ais-relay.md) in the same scratchpad, using the same columns. Its findings are folded into the two closing sections below.

## Conventions

- **Credentials** show `NAME (yes)` or `NAME (no)` for presence in the local `.env.local`, checked by name only. Local presence says nothing about Railway. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (both yes) are needed by every seeder and are not repeated.
- **seed-meta.** Every `runSeed()` call also writes `seed-meta:<domain>:<resource>` with `fetchedAt` and `recordCount`. The default seed-meta TTL is 7 days. These keys are not repeated per row.
- **Retention on failure.** `runSeed()` extends the last-good key's TTL when the upstream fails, without advancing `fetchedAt` (see `seed-correlation.mjs` header). "TTL" below means the lifetime of the last good snapshot, not a history window.
- **Cadence.**
  - "bundle X @ N" means the section runs inside Railway cron bundle X, gated to at most once per N (`_bundle-runner.mjs` skips a section whose seed-meta is younger than `intervalMs × 0.8`). Bundle cron schedules are in the Bundles table.
  - "service, no cron in repo" means a Railway service exists (`railway-native-autodeploy-fleet.json`) but its cron schedule is set only in the Railway dashboard. In those cases the cadence comes from code comments or `maxStaleMin`.
- **History types.** Three kinds are distinguished:
  - **Accumulated**: WorldMonitor appends or merges across runs, so data older than the upstream window survives.
  - **Upstream window**: each run re-fetches a series of N points and overwrites the key, so no vintage is kept.
  - **Snapshot**: latest state only.

## Bundles (cadence carriers)

| Bundle | Cron (source) | Sections in this half (interval) | Sections in the other half |
|---|---|---|---|
| seed-bundle-canada | `*/5 * * * *` (railway-services.json) | Alberta-Emergency-Alert (15 min), BC-Emergency-Info (15 min) | Provincial-511, Toronto-Roads, BC-Open511, TTC-Alerts, Toronto-TFS, Toronto-TPS, TPS-MCI, TPS-Calls-Attended |
| seed-bundle-climate | Every 3 h (`seed-climate-anomalies.mjs` header) | Zone-Normals (30 d), Anomalies (3 h), Disasters (6 h), Ocean-Ice (1 d), CO2-Monitoring (3 d) | Natural-Events (3 h) |
| seed-bundle-derived-signals | `*/5 * * * *` | Correlation (5 min), China-Decision-Signals (15 min), Cross-Source-Signals (15 min), Cross-Strait-Activity (3 h) | — |
| seed-bundle-ecb-eu | Not in repo | ECB-FX-Rates (1 d), ECB-Short-Rates (1 d), FSI-EU (1 d) | Yield-Curve-EU (1 d) |
| seed-bundle-energy-sources | Not in repo | GIE-Gas-Storage (1 d), Gas-Storage-Countries (1 d), EIA-Petroleum (1 d), IEA-Crisis-Policies (7 d), Fuel-Shortages (1 d), Energy-Disruptions (7 d) | JODI-Gas (15 d), JODI-Oil (35 d), IEA-Oil-Stocks (40 d), SPR-Policies, Pipelines-Gas/Oil, Storage-Facilities, OWID energy mix |
| seed-bundle-health | Not in repo (sections call it a "daily health-bundle tick") | China-Coverage (1 h), Disease-Outbreaks (1 d), DTM-Displacement (1 d), Displacement-Summary (1 d), Cross-Border-Arrivals (1 d) | VPD-Tracker (1 d) |
| seed-bundle-imf-extended | Monthly, Railway cron (header) | — | IMF-Macro, IMF-Growth, IMF-Labor, IMF-External (30 d each) |
| seed-bundle-macro | `0 8,9 * * *` | BIS-Data (12 h), CBR-Rates (1 d), BoC-Valet (1 d), China-Macro (36 h), China-Release-Calendar (36 h), China-Policy-Events (6 h), BIS-Extended (12 h), BLS-Series (1 d), Eurostat (1 d), Eurostat-HousePrices (7 d), Eurostat-GovDebtQ (2 d), Eurostat-IndProd (1 d), FAO-FFPI (1 d), BIS-LBS (7 d), FATF-Listing (30 d), Education-Attainment (7 d) | StatCan-WDS, IMF-Macro, National-Debt, WB-External-Debt, US-CPI, World-CPI-IMF/AU, Physical-Premiums, and others |
| seed-bundle-market-backup | `*/5 * * * *` | Crypto-Quotes (5 min), ETF-Flows (15 min), China-Corporate-Disclosures (30 min), China-Stock-Connect (60 min), Gold-ETF-Flows (120 min), Gold-CB-Reserves (1 d) | Hyperliquid-Flow, Stablecoin-Markets, Market-Correlation-Series, Gulf-Quotes, Token-Panels, SEC-CIK-Map, SEC-8K-Stream |
| seed-bundle-portwatch | `0 */1 * * *` | — | PW-Disruptions (1 h), PW-Main (6 h), PW-Chokepoints-Ref (1 wk) |
| seed-bundle-portwatch-port-activity | `0 */12 * * *` | — | `supply_chain:portwatch-ports:v1:_countries` |
| seed-bundle-regional | Every 6 h (header) | — | Regional snapshots (6 h) and LLM weekly briefs; in-process, not via `runBundle` |
| seed-bundle-relay-backup | Not in repo | Climate-News (30 min), Global-Tenders (1 h) | USA-Spending (1 h), WB-Indicators (1 d) |
| seed-bundle-resilience | Hourly (header comment) | Five-Factor-Scorecard (1 d), Food-Stocks (30 d) | Resilience-Scores and others |
| seed-bundle-resilience-energy-v2 | `0 6 * * *` (header) | Fossil-Electricity-Share (7 d) | Low-Carbon-Generation, Power-Reliability |
| seed-bundle-resilience-recovery | Not in repo | — | Fiscal-Space, Reserve-Adequacy, External-Debt, Import-HHI, Fuel-Stocks, Reexport-Share, Sovereign-Wealth (30 d each) |
| seed-bundle-resilience-validation | Not in repo | — | Runs `resilience-validation-bundle.mjs` (server-side TS) |
| seed-bundle-static-ref | `0 3 * * *` | Defense-Industrial (10 d), Defense-Patents (1 wk), Chokepoint-Baselines (400 d), Demographics-Capability (20 d) | Submarine-Cables (1 wk) |
| seed-bundle-static-ref-heavy | `0 4 * * *` | Arms-Suppliers (14 d) | Mineral-Production (60 d), Military-Bases, Supply-Vulnerability projection |
| seed-bundle-yield-curves | `0 10 * * *` | — | JP, CA, DE, GB, AU, CH, NO, SE curves (1 d), OECD-LT (7 d) |

## Inventory tables

### Markets and sentiment

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| AAII sentiment | seed-aaii-sentiment.mjs | `www.aaii.com/files/surveys/sentiment.xls` | none | `market:aaii-sentiment:v1` | Global weekly: bullish, neutral and bearish %, spread | Service, no cron in repo; weekly data, `maxStaleMin` 20160 (:406) | TTL 7 d (:7). Upstream window: the last 52 weeks in the payload (:353-354) | Raw | The XLS carries full history back to 1987, but only 52 weeks are kept |
| Commodity quotes + gold extended | seed-commodity-quotes.mjs | Yahoo `query1.finance.yahoo.com/v8/finance/chart` (`range=1y`, daily) (:23); Alpha Vantage optional | `ALPHA_VANTAGE_API_KEY` (no) | `market:commodities-bootstrap:v1`, `market:commodities:v1:<syms>`, `market:quotes:v1:<syms>`, `market:gold-extended:v1` (+ `seed-meta:market:gold-extended`) | Per symbol: price, change, returns (w1, m1, ytd, y1), 52-week range, gold/silver driver correlations | Service, no cron in repo; 5 min per docs/architecture.mdx:270; `maxStaleMin` 30 (:309) | TTL 1800 s (:13). The 1-year daily closes are an upstream window used for computation and not stored in full | Raw prices + derived returns | Dual writer with the relay market loop. Yahoo calls staggered |
| Crypto quotes | seed-crypto-quotes.mjs | CoinPaprika tickers, with CoinGecko as fallback (`sourceVersion` :138) | `COINGECKO_API_KEY` (no), `COINGECKO_DEMO_API_KEY` (no) | `market:crypto:v1` | Per coin: price, 24 h change, market cap, 48-point sparkline (:90) | bundle market-backup @ 5 min | TTL 7200 s (:10) | Raw | Also written by the relay |
| Crypto sectors | seed-crypto-sectors.mjs | CoinGecko categories | as above | `market:crypto-sectors:v1` | Per sector: market cap, 24 h change | Service, no cron in repo; `maxStaleMin` 120 (:67) | TTL 3600 s (:10) | Raw | Also written by the relay |
| COT positioning | seed-cot.mjs | CFTC Socrata `publicreporting.cftc.gov/resource/{yw9f-hn96, rxbv-e226}.json` (:152, :159), `$limit=200` | none | `market:cot:v1` | Per contract per week: commercial and non-commercial net positions | Service, no cron in repo; weekly report; `maxStaleMin` 14400 (:211) | TTL 14 d (:9). Upstream window of up to 200 rows | Raw | Public domain (US government) |
| Earnings calendar | seed-earnings-calendar.mjs | Finnhub `/api/v1/calendar/earnings` | `FINNHUB_API_KEY` (yes) | `market:earnings-calendar:v1` | Per company event: date, EPS estimate and actual, revenue | Service, no cron in repo; TTL implies 12 h (:8) | TTL 36 h (:8) | Raw | Symbol set kept in step with `src/config/nq-context.ts` |
| BTC ETF flows | seed-etf-flows.mjs | Alpha Vantage REALTIME_BULK_QUOTES (primary); Yahoo chart `range=5d` (:52) | `ALPHA_VANTAGE_API_KEY` (no) | `market:etf-flows:v1` | Per ETF: price, volume, volumeRatio, estimated flow, direction | bundle market-backup @ 15 min | TTL 5400 s (:13) | Derived flow estimate from price × volume | Also written by the relay |
| Fear & Greed composite | seed-fear-greed.mjs | Yahoo (22 symbols, `range=1y`) (:19), Barchart `$CPC` page, CNN `production.dataviz.cnn.io/index/fearandgreed/current`, AAII results page; also reads `economic:fred:v1:*` and `economic:macro-signals:v1` | none | `market:fear-greed:v1` | Global: composite score 0-100 plus sub-indicators (momentum, breadth, put/call, VIX, credit spread, safe haven, CNN, AAII) | Service, no cron in repo; TTL implies 6 h (:11); `maxStaleMin` 720 (:496) | TTL 18 h (:11) | Derived composite | Barchart sits behind AWS WAF (a 202 challenge passes `resp.ok`). Breadth is read from the published S&P 500 breadth-history series (:67) |
| FX rates (shared) | seed-fx-rates.mjs | Yahoo FX via `fetchYahooFxRatesWithProvenance` (:89) | none | `shared:fx-rates:v1` | Per currency: USD rate | Service, daily ("0 6 * * *" suggested in header) | TTL 25 h (:18) | Raw | Input cache for bigmac and grocery-basket |
| FX YoY + drawdown | seed-fx-yoy.mjs | Yahoo chart `range=2y&interval=1mo` (:77) | none | `economic:fx:yoy:v1` | Per currency: yoyChange, drawdown24m | Service, no cron in repo; daily (:45) | TTL 25 h (:45). Upstream window of 24 monthly bars | Derived | Covers emerging-market currencies that BIS EER lacks |
| Gold central-bank reserves | seed-gold-cb-reserves.mjs | IMF SDMX 3.0 `api.imf.org/external/sdmx/3.0` | none | `market:gold-cb-reserves:v1` | Per country: gold tonnes, 12-month delta; top buyers and sellers | bundle market-backup @ 1 d | TTL 30 d (:12) | Raw + derived deltas | Monthly data |
| Gold ETF (GLD) flows | seed-gold-etf-flows.mjs | SPDR `api.spdrgoldshares.com/api/v1/historical-archive` (XLSX, ~5,500 rows of full history) | none | `market:gold-etf-flows:v1` | Global daily: tonnes, flow over 1 d, 1 w and 1 m; 90-day spark (:100) | bundle market-backup @ 120 min | TTL 24 h (:11). Upstream supplies full history, but only 90 days are published | Derived flows | The source format changed from CSV to XLSX in 2026 |
| China Stock Connect + margin | seed-china-stock-connect.mjs | SSE `query.sse.com.cn/commonSoaQuery.do`, `queryMargin.do`; SZSE `www.szse.cn/api/report/...` | none | `market:china:stock-connect:v1` | Per trade date: northbound and southbound turnover, margin balances; trade-date agreement flag | bundle market-backup @ 60 min | TTL 3 d (:13). **Accumulated**: rolling `history` of up to 180 rows (`china-stock-connect/adapters.mjs:39, :849`), carried forward across runs (a failed cache read aborts the run, :98) | Raw | A row is added only when both exchanges agree on the trade date. Margin data is kept 3 h (adapters :889) |
| China corporate disclosures | seed-china-corporate-disclosures.mjs | SSE `query.sse.com.cn/security/stock/queryCompanyBulletin.do`, SZSE `www.szse.cn/api/disc/announcement/annList` | none | `market:china:corporate-disclosures:v1`; SZSE failure-meta key (:22) | Per announcement event: company, category, revision history | bundle market-backup @ 30 min | TTL 3 d (:17). **Accumulated**: merges prior announcements (`adapters.mjs:708, :1286`), capped at 100 events (:168) | Raw | Exchange terms-of-use links appear in the adapter |
| Big Mac index | seed-bigmac.mjs | Exa search `api.exa.ai/search` (price extraction) | `EXA_API_KEYS` (yes), `EXA_API_KEY` (yes) | `economic:bigmac:v1`, `economic:bigmac:v1:prev` | Per country: local price, USD price, week-over-week change | Service, no cron in repo; weekly | TTL 10 d (:6); prev 20 d (:304). One prior snapshot | Raw (scraped) | Validated week over week |
| Grocery basket | seed-grocery-basket.mjs | Exa search plus Firecrawl `api.firecrawl.dev/v1/scrape` | `EXA_API_KEYS` (yes), `FIRECRAWL_API_KEY` (yes) | `economic:grocery-basket:v1`, `:prev` | Per country per item: price, USD price, basket total, WoW | Service, no cron in repo; weekly | TTL 10 d (:10); prev 20 d (:486) | Raw (scraped) | Migration markers `_migration:*` (:219-220) |
| Consumer prices (manual fallback) | seed-consumer-prices.mjs | consumer-prices-core service (`/wm/consumer-prices/v1/...`) | `CONSUMER_PRICES_CORE_BASE_URL` (no), `CONSUMER_PRICES_CORE_API_KEY` (no) | `consumer-prices:*` (overview, movers, spread, series 7/30/90 d, categories, coverage) | Per market and basket: index level, category moves | **Manual only. Must not run on a cron** (header :9-16) | TTL 10-60 min (:129-135). The authoritative writer, `publish.ts`, uses 26 h | Derived by consumer-prices-core | The real producer lives outside this repo half (seed-consumer-prices-publish service) |

### Macro, rates and central banks

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| BIS policy, EER, credit | seed-bis-data.mjs | BIS SDMX `stats.bis.org/api/v1/data` (WS_CBPOL, WS_EER, WS_TC) | none | `economic:bis:policy:v1`, `economic:bis:eer:v1`, `economic:bis:credit:v1` | Per country: policy rate, real and nominal EER, credit/GDP; monthly or quarterly series | bundle macro @ 12 h | TTL 36 h (:57). Upstream window | Raw | Content-age gate of 75 days |
| BIS DSR and property prices | seed-bis-extended.mjs | BIS SDMX (WS_DSR, WS_SPP, WS_CPP) | none | `economic:bis:dsr:v1`, `economic:bis:property-residential:v1`, `economic:bis:property-commercial:v1` | Per country, quarterly: debt service ratio, real residential and commercial property index | bundle macro @ 12 h | TTL 3 d (:115) | Raw | — |
| BIS consolidated banking | seed-bis-lbs.mjs | BIS `WS_CBS_PUB` (`lastNObservations=4`, :179); World Bank for GDP | none | `economic:bis-lbs:v1` | Per parent and counterparty country: foreign claims (quarterly) | bundle macro @ 7 d | TTL 100 d (:61) | Raw | BIS terms linked at the file header |
| BLS labour series (via FRED) | seed-bls-series.mjs | FRED `api.stlouisfed.org/fred/series/observations` | `FRED_API_KEY` (yes) | `bls:series:v1` | US national series: payrolls, unemployment and others | bundle macro @ 1 d | TTL 72 h (:21) | Raw | BLS direct access is blocked from Railway. Metro series were dropped |
| Bank of Canada Valet | seed-boc-valet.mjs | `www.bankofcanada.ca/valet/observations/...` (`lib/boc-valet.mjs`) | none | `economic:boc-valet:v1`; activation marker | CAD FX, overnight target, 2/5/10-year yields (recent=5) | bundle macro @ 1 d | TTL 4 d (:22) | Raw | — |
| Bank of Russia | seed-cbr-rates.mjs | `www.cbr.ru/scripts/XML_daily.asp`; SOAP `DailyInfo.asmx` KeyRate | none | `economic:cbr-rates:v1`; activation marker | RUB rates per currency, change over 1 d, key policy rate path | bundle macro @ 1 d | TTL 4 d (:50). Upstream window: 730 days of key-rate history (:69) | Raw | windows-1251 encoding and decimal-comma parsing |
| ECB FX | seed-ecb-fx-rates.mjs | ECB `data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY+CHF+CAD+AUD+CNY.EUR.SP00.A`, `lastNObservations=5` | none | `economic:ecb-fx-rates:v1` | 7 EUR pairs, daily | bundle ecb-eu @ 1 d | TTL 3 d (:9) | Raw | Content-age gate of 10 days |
| ECB €STR + EURIBOR | seed-ecb-short-rates.mjs | ECB `EST/B.EU000A2X2A25.WT` (60 obs); `FM/M.U2.EUR.RT.MM.EURIBOR{3M,6M,1Y}` (36 obs) | none | `economic:fred:v1:{ESTR,EURIBOR3M,EURIBOR6M,EURIBOR1Y}` (FRED-compatible prefix, :19) | Daily €STR; monthly EURIBOR | bundle ecb-eu @ 1 d | TTL 3 d (:20). Upstream window | Raw | — |
| ECB CISS stress | seed-fsi-eu.mjs | ECB `CISS/D.U2.Z0Z.4F.EC.SS_CIN.IDX`, trailing year | none | `economic:fsi-eu:v1` | Euro area daily stress index 0-1; ~260-point history | bundle ecb-eu @ 1 d | TTL 3 d (:29). Upstream window of 1 year | Raw | The legacy SS_CI series froze for 12 months undetected (#3845) |
| Economic calendar | seed-economic-calendar.mjs | FRED `/releases` and `/release/dates`; Fed FOMC calendar page; ECB calendar page; Eurostat API; FRED observations for actuals | `FRED_API_KEY` (yes) | `economic:econ-calendar:v1` | Per release event: date, consensus or actual where known | Service, no cron in repo; TTL implies 12 h (:11) | TTL 36 h (:11) | Raw | Useful as the scheduled-event backbone for forecast resolution |
| Energy, macro signals, EIA weeklies | seed-economy.mjs | EIA v2 (energy prices, capacity, crude stocks, gas storage, SPR, refinery inputs); Finnhub; FRED; Yahoo (JPY, BTC, QQQ, XLP, 1 y); alternative.me F&G (`limit=30`); mempool.space hashrate | `EIA_API_KEY` (yes), `FINNHUB_API_KEY` (yes), `FRED_API_KEY` (yes) | `economic:energy:v1:all`, `economic:capacity:v1:COL,SUN,WND:20`, `economic:macro-signals:v1`, `economic:crude-inventories:v1`, `economic:nat-gas-storage:v1`, `economic:spr:v1`, `economic:refinery-inputs:v1` (:12-18) | Energy prices; weekly inventories (weeks[]); macro-signal booleans (liquidity, trend, F&G with 30-day history) | `*/15 * * * *` (railway-services.json) | Energy 1 h, capacity 24 h, macro 6 h, weeklies 21 d (:21-29). Upstream windows | Raw + derived macro-signal states | — |
| FRED rates batch | seed-fred-rates.mjs (+ `_fred-seeder.mjs`) | FRED observations and series metadata; 24 series (`_fred-seeder.mjs:30`), 120 newest observations each (:224) | `FRED_API_KEY` (yes); `PROXY_URL` (yes) | `economic:fred:v1:<ID>:0` per series; `economic:fred:batch:v1`; `economic:stress-index:v1`; `economic:fred:series-meta:v1`; activation marker | US macro series: WALCL, FEDFUNDS, T10Y2Y, UNRATE, CPIAUCSL, DGS*, VIXCLS, GDP, M2SL, DCOILWTICO, HY OAS, SOFR, STLFSI4 and others | `0 * * * *` (railway-services.json) | Series TTL 26 h; stress 6 h; metadata 30 d (`_fred-seeder.mjs:14-28`). Upstream window of 120 observations | Raw + derived stress index | The forecast resolver reads these keys as resolution feeds |
| Eurostat country data | seed-eurostat-country-data.mjs | Eurostat dissemination API | none | `economic:eurostat-country-data:v1` | Per EU country: CPI, unemployment, GDP growth | bundle macro @ 1 d | TTL 3 d (:10) | Raw | — |
| Eurostat government debt (quarterly) | seed-eurostat-gov-debt-q.mjs | Eurostat `gov_10q_ggdebt` | none | `economic:eurostat:gov-debt-q:v1` | Per EU country: debt % GDP (quarterly) | bundle macro @ 2 d | TTL 14 d (:18) | Raw | — |
| Eurostat house prices | seed-eurostat-house-prices.mjs | Eurostat `prc_hpi_a` | none | `economic:eurostat:house-prices:v1` | Per EU country: annual HPI | bundle macro @ 7 d | TTL 35 d (:18) | Raw | — |
| Eurostat industrial production | seed-eurostat-industrial-production.mjs | Eurostat `sts_inpr_m` | none | `economic:eurostat:industrial-production:v1` | Per EU country: monthly index | bundle macro @ 1 d | TTL 5 d (:19) | Raw | — |
| FAO Food Price Index | seed-fao-food-price-index.mjs | FAO `food_price_indices_data.csv` | none | `economic:fao-ffpi:v1` | Global monthly: FFPI plus 5 sub-indices | bundle macro @ 1 d | TTL 90 d (:18). Upstream window of the last 12 months (:20); the CSV carries history from 1990 | Raw | — |
| FATF black/grey lists | seed-fatf-listing.mjs | `www.fatf-gafi.org/en/countries/black-and-grey-lists.html`; Wayback CDX fallback | none | `economic:fatf-listing:v1` | Per country: list membership (boolean), as-of plenary | bundle macro @ 30 d | TTL 90 d (:28) | Raw (scraped) | Updated three times a year. The parser tolerates at most 2 unmatched names |
| Education attainment | seed-education-attainment.mjs | World Bank `SE.SEC.CUAT.UP.FE.ZS` | none | `resilience:education-attainment:v1`, `seed-baseline:resilience:education-attainment:v1` | Per country: female upper-secondary attainment % (latest within 15 years) | bundle macro @ 7 d | TTL 35 d (:47) | Raw | Resilience index input |
| Global tenders | seed-global-tenders.mjs (+ `_global-tenders.mjs`) | SAM.gov opportunities v2, TED v3, UK Contracts Finder OCDS, World Bank procnotices, NZ GETS RSS, CanadaBuys CSV, AusTender RSS | `SAM_GOV_API_KEY` (yes) | `economic:global-tenders:v1`; `economic:global-tenders:v1:source:<src>` + seed-meta per source | Per tender notice: buyer, value, deadline, country, CPV or sector | bundle relay-backup @ 1 h | TTL 3 h (:23) | Raw | — |

### China official sources

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| China macro | seed-china-macro.mjs | PBoC, SAFE, GACC (`english.customs.gov.cn`), chinamoney.com.cn (LPR) | none | `economic:china:macro:v2` (`_china-macro-contract.mjs:7`); transport and completion meta | National monthly: LPR, reserves, trade, money supply; per-indicator availability | bundle macro @ 36 h | TTL 7 d (:31) | Raw | Blocked PBoC and GACC sources are reported as unavailable. No proxy is used |
| China release calendar | seed-china-release-calendar.mjs | chinamoney.com.cn notices (`china-macro/calendar.mjs`) | none | `economic:china:release-calendar:v1` | Per scheduled release: date, indicator | bundle macro @ 36 h | TTL 45 d (:11) | Raw | — |
| China policy events | seed-china-policy-events.mjs | CAC, MIIT, MOFCOM, PBoC, SAMR and NDRC listing pages (`china-policy/adapters.mjs`) | none | `china:policy-events:v1` | Per policy document: agency, date, category, lineage | bundle macro @ 6 h | TTL 7 d (:158). **Accumulated**: merges prior events within a 180-day window (:18, :52-53), capped at 120 (:19) | Raw | — |
| China decision signals | seed-china-decision-signals.mjs | WorldMonitor's own API `api.worldmonitor.app` (china-decision RPCs) | `API_BASE_URL` (no; defaults to the public host) | `intelligence:china-decision-signals:v1`; `intelligence:china-decision-alert-outbox:v1` | Per signal: type, severity, country, evidence | bundle derived-signals @ 15 min | TTL 24 h (:322); outbox 7 d (:34) | Derived from WM China feeds | — |
| China coverage health | seed-china-coverage-health.mjs | None (reads WM Redis via `china-coverage-manifest.mjs`) | none | `health:china-coverage:v1` | Per China source: freshness and coverage state | bundle health @ 1 h | TTL 3 h (:35) | Derived (operational) | Health metadata, not world data |

### Energy

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| EIA petroleum spot | seed-eia-petroleum.mjs | EIA `/v2/seriesid/{id}?num=2` | `EIA_API_KEY` (yes) | `energy:eia-petroleum:v1` | Per series: latest and prior value (WTI, Brent, products) | bundle energy-sources @ 1 d | TTL 7 d (:9) | Raw | Resolution input for the energy bet templates |
| Electricity day-ahead prices | seed-electricity-prices.mjs | ENTSO-E `web-api.tp.entsoe.eu/api` (bidding zones such as DE, IT-N, NO1); EIA `/v2/electricity/rto/region-data` | `ENTSO_E_TOKEN` (yes), `EIA_API_KEY` (yes) | `energy:electricity:v1:<region>`, `energy:electricity:v1:index`, `seed-meta:energy:electricity-prices` | Per region: day-ahead price, demand | Service, no cron in repo; daily (comments :322-331) | TTL 3 d (:24) | Raw | ENTSO-E can take 23-45 s per region |
| Ember electricity mix | seed-ember-electricity.mjs | Ember `storage.googleapis.com/emb-prod-bkt-publicdata/.../monthly_full_release_long_format.csv` | none | `energy:ember:v1:<iso2>`, `energy:ember:v1:_all`, `seed-meta:energy:ember` | Per country, monthly: generation by source, fossil share | Service, no cron in repo; daily (:21) | TTL 72 h (:21). Upstream window (latest months) | Raw | Ember data is CC BY 4.0 |
| Energy spine | seed-energy-spine.mjs | None. Reads `energy:jodi-oil:v1:*`, `energy:jodi-gas:v1:*`, `energy:mix:v1:*`, `energy:ember:v1:*`, `energy:iea-oil-stocks:v1:*`, `energy:spr-policies:v1` | none | `energy:spine:v1:<iso2>`, `energy:spine:v1:_countries`, `seed-meta:energy:spine` | Per country: oil and gas supply, demand, stocks, import dependence, mix | Service, no cron in repo; daily (:37) | TTL 48 h (:37) | **Derived** (recomputable from JODI, Ember, IEA and OWID inputs) | — |
| EU gas storage (aggregate) | seed-gie-gas-storage.mjs | GIE AGSI+ `agsi.gie.eu/api` | `GIE_API_KEY` (yes), `AGSI_API_KEY` (no) | `economic:eu-gas-storage:v1` | EU: fill %, injection and withdrawal; 5-day history | bundle energy-sources @ 1 d | TTL 3 d (:8). Upstream window of 5 days | Raw | — |
| Gas storage by country | seed-gas-storage-countries.mjs | GIE AGSI+ per country | as above | `energy:gas-storage:v1:<iso2>`, `:_countries`, `:all`, `seed-meta:energy:gas-storage-countries` | Per EU country + UK: fill %, TWh, trend | bundle energy-sources @ 1 d | TTL 3 d (:21) | Raw | — |
| IEA crisis policies | seed-energy-crisis-policies.mjs | Curated registry (`sourceVersion` `iea-crisis-policies-v1`, :70) | none | `energy:crisis-policies:v1` | Per country: emergency policy measures | bundle energy-sources @ 7 d | TTL ~400 d (:11) | Curated | — |
| Energy disruptions | seed-energy-disruptions.mjs | Curated registry (`_energy-disruption-registry.mjs`) | none | `energy:disruptions:v1` | Per pipeline or storage event: state-machine history | bundle energy-sources @ 7 d | TTL 21 d (registry :18) | Curated; the event log keeps its own state history | Hand-maintained |
| Fuel shortages | seed-fuel-shortages.mjs | Curated `scripts/data/fuel-shortages.json` | none | `energy:fuel-shortages:v1` | Per country: shortage status and severity | bundle energy-sources @ 1 d | TTL 3 d (registry :22) | Curated | — |
| Retail fuel prices | seed-fuel-prices.mjs | data.gov.my, Spain MINETUR, Mexico CRE, EIA retail gasoline, EU Oil Bulletin, Brazil ANP, NZ MBIE, UK gov.uk and others | `EIA_API_KEY` (yes) | `economic:fuel-prices:v1`, `:prev` | Per country: gasoline and diesel price, local and USD, WoW | Service, no cron in repo; weekly (:81) | TTL 10 d (:81); prev 20 d (:888). One prior snapshot | Raw | `backfill-fuel-prices-prev.mjs` exists for the prev key |
| Energy news intelligence | seed-energy-intelligence.mjs | OilPrice RSS `oilprice.com/rss/main`; OPEC RSS (via proxy, Cloudflare) | `PROXY_URL` (yes) | `energy:intelligence:feed:v1`; **Convex intel-history** via `makeSeedHistoryAfterPublish` (:6, :194) | Per article: title, source, date, url | Service, no cron in repo; TTL implies 6 h (:11) | TTL 24 h (:11). **Intel-history 180 days** (`convex/intelHistory.ts:68`) | Raw | IEA RSS is gone (404) |
| Fossil electricity share | seed-fossil-electricity-share.mjs | World Bank `EG.ELC.FOSL.ZS` | none | `resilience:fossil-electricity-share:v1` | Per country: fossil share of generation (annual) | bundle resilience-energy-v2 @ 7 d | TTL 35 d (:40) | Raw | Latest year 2023 |
| Chokepoint baselines | seed-chokepoint-baselines.mjs | Committed EIA 2023 World Oil Transit Chokepoints rows (`chokepoint-eia-baselines.mjs`) | none | `energy:chokepoint-baselines:v1` | Per chokepoint: baseline mb/d | bundle static-ref @ 400 d | TTL 400 d (:19) | Static reference | — |
| Chokepoint flows | seed-chokepoint-flows.mjs | None. Reads `supply_chain:portwatch:v1`, `energy:chokepoint-baselines:v1`, `portwatch:disruptions:active:v1` | none | `energy:chokepoint-flows:v1` | Per chokepoint (7): estimated flow (7-day vs 90-day PortWatch DWT × EIA baseline), hazard flags | Hosted by the relay every 6 h (`ais-relay.cjs:7997`) | TTL 3 d (:12) | **Derived** (recomputable from PortWatch history) | Needs at least 40 days of PortWatch history (:101) |

### Climate and natural hazards

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Climate zone normals | seed-climate-zone-normals.mjs | Open-Meteo archive (ERA5), 1991-2020 | none | `climate:zone-normals:v1` | Per climate zone per month: temperature and precipitation normals | bundle climate @ 30 d | TTL 95 d (:12) | Derived baseline | Input to anomalies |
| Climate anomalies | seed-climate-anomalies.mjs | Open-Meteo archive (last ~14 days) | none | `climate:anomalies:v2` | Per zone: 7-day temperature and precipitation anomaly vs normals, severity | bundle climate @ 3 h | TTL 9 h (:23) | **Derived** (Open-Meteo vs normals; recomputable) | ERA5 lags 5-7 days |
| Climate disasters | seed-climate-disasters.mjs | ReliefWeb `api.reliefweb.int/v{1,2}/disasters`; also reads `natural:events:v1` | `RELIEFWEB_APPNAME` (no) | `climate:disasters:v1` | Per disaster: type, country, status, date | bundle climate @ 6 h | TTL 18 h (:15) | Raw | — |
| Ocean and ice | seed-climate-ocean-ice.mjs | NSIDC sea-ice extent CSV (daily and climatology); NASA sea-level overlay; NOAA NCEI ocean heat content; NOAA global surface temperature | none | `climate:ocean-ice:v1` | Global: Arctic sea-ice extent and anomaly, sea level, OHC, SST anomaly | bundle climate @ 1 d | TTL 72 h (:11). Upstream window | Raw | — |
| CO2 and GHGs | seed-co2-monitoring.mjs | NOAA GML `co2_daily_mlo`, `co2_mm_mlo`, `co2_annmean_gl`, `ch4_mm_gl`, `n2o_mm_gl` | none | `climate:co2-monitoring:v1` | Global: CO2 ppm (daily and monthly), CH4, N2O; 12-month trend (:109) | bundle climate @ 3 d | TTL 72 h (:9) | Raw | — |
| Climate news | seed-climate-news.mjs | RSS from Carbon Brief, Guardian, NASA EO, UNEP, Phys.org, Copernicus and Climate Central; ReliefWeb reports | `RELIEFWEB_APPNAME` (no) | `climate:news-intelligence:v1` | Per article | bundle relay-backup @ 30 min; also the relay | TTL 90 min (:12) | Raw | — |
| Earthquakes | seed-earthquakes.mjs | USGS `4.5_week.geojson`; NRCan Earthquakes Canada Atom | none | `seismology:earthquakes:v1`, `seismology:earthquakes:providers:v1` | Per quake: magnitude, depth, lat/lon, time, place | `*/5 * * * *` | TTL 6 h (:27). Upstream window of 7 days (M4.5+) | Raw | — |
| Wildfire detections | seed-fire-detections.mjs | NASA FIRMS (VIIRS, area API); CWFIS WFS `geoserver.cwfif.nrcan.gc.ca`; BC OpenMaps KML | `NASA_FIRMS_API_KEY` (yes), `FIRMS_API_KEY` (no) | `wildfire:fires:v1`, `wildfire:fires-bootstrap:v1`, `wildfire:cwfis-source:v1`, `wildfire:bc-source:v1` | Per detection: lat/lon, FRP, confidence, time; per-fire size and status | `*/10 * * * *` | TTL 2 h (deliberately short, :150); CWFIS snapshot 4 h, BC 2 h | Raw | — |
| Alberta emergency alerts | seed-alberta-emergency-alert.mjs | `www.alberta.ca/data/aea/rss/feed-full.atom` | none | `alerts:canada:alberta-aea:v1`; union `alerts:canada:v1` | Per alert: type, area, severity, issued and expiry | bundle canada @ 15 min | TTL 90 min (:28; union `lib/canada-alerts-union.mjs:12`) | Raw | — |
| BC evacuation orders | seed-bc-emergency-info.mjs | BC ArcGIS `services6.arcgis.com/.../Evacuat...` | none | `alerts:canada:bc-evacuation:v1`; union `alerts:canada:v1` | Per order or alert: area polygon, status, population | bundle canada @ 15 min | TTL 90 min (:18) | Raw | — |

### Conflict, security, military

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| ACLED + HAPI + PizzINT (conflict intel) | seed-conflict-intel.mjs | ACLED `acleddata.com/api/acled/read` (OAuth); HDX HAPI `hapi.humdata.org/api/v2/coordination-context/conflict-events`; PizzINT `www.pizzint.watch/api/dashboard-data` and `/api/gdelt/batch`; GDELT bulk (`_conflict-gdelt-bulk.mjs`) | `ACLED_EMAIL` (no), `ACLED_PASSWORD` (no), `ACLED_ACCESS_TOKEN` (no) | `conflict:acled:v1:all:0:0`, `conflict:acled-resolution:v1:all:0:0`, `conflict:humanitarian:v1:<cc>`, `conflict:humanitarian:hapi-backoff:v1`, `intel:pizzint:v1:base`, `intel:pizzint:v1:gdelt`; **Convex intel-history** (`makeSeedHistoryAfterPublish`, :48, :1526) | ACLED event: date, type, actors, fatalities, lat/lon, country. HAPI per country: conflict event and fatality counts. PizzINT: DEFCON, tension pairs | `*/15 * * * *` | ACLED TTL 2700 s (:79), 30-day display window (:80), 60-day resolution window (:82). HAPI per country 6 h (:87). PizzINT 600 s (:144). **Intel-history 180 days** | Raw | ACLED is dark in production; GDELT reaches the map but not the CII scorer (memory note). The ACLED licence forbids publishing snapshots (`docs/panels/forecast.mdx`) |
| GDELT bulk materializer | seed-gdelt-bulk-materializer.mjs (+ `_gdelt-bulk-materializer.mjs`, `_gdelt-dyad-tension.mjs`) | GDELT 2.0 15-min export and GKG files on `storage.googleapis.com/data.gdeltproject.org` | none | `intelligence:gdelt-intel:v1`; `gdelt:intel:{tone,vol}:<topic>`; `gdelt:bulk:dyad-tension:v1`; `gdelt:bulk:conflict-events:v1`; `gdelt:bulk:unrest-events:v1`; `gdelt:bulk:articles:v1`; `gdelt:bulk:country-articles:v1`; `positive-events:geo:v1`; `positive_events:geo-bootstrap:v1`; `gdelt:bulk:materializer-state:v1` | Per topic: tone and volume timelines. Per dyad (country pair) per day: event cohorts and conflict and cooperation counts. Per event: CAMEO code, Goldstein, actors, lat/lon. Per country: article index | `*/15 * * * *` (service `seed-gdelt-intel`) | Intel 24 h, timelines 7 d, state 14 d, **dyad 92 d** (:86-99). Dyad keeps 90 completed UTC days (`_gdelt-dyad-tension.mjs:35, :58-60`), repaired 2 days per tick. Conflict 6 h, unrest 4.5 h, articles 2 d. Rolling event window 24 h (`_gdelt-bulk-contract.mjs:25`) | Raw events + derived dyad tension and tone | GDELT bulk files are public and can be re-fetched historically. That makes this the easiest raw feed to backfill |
| GDELT DOC API (deprecated) | seed-gdelt-intel.mjs | `api.gdeltproject.org/api/v2/doc/doc` | none | (formerly `intelligence:gdelt-intel:v1`) | — | **Not run.** The service was repointed to the bulk materializer (#5843) | — | — | Rollback seam only |
| Cross-Strait activity | seed-cross-strait-activity.mjs | Taiwan MND `www.mnd.gov.tw/en/news/plaactlist`; Japan MOD Joint Staff press PDFs `www.mod.go.jp/js/` | `JAPAN_MOD_PROXY_URL` (no), `PROXY_URL` (yes) | `military:cross-strait-activity:v1`; `military:cross-strait-activity:v1:source:<id>`; `military:cross-strait-activity-bootstrap:v1`; completion meta; **Convex intel-history** (`appendSeedHistory`, :14) | Per reporting day: PLA aircraft, ships, balloons, median-line crossings; Japan MOD intercepts | bundle derived-signals @ 3 h | TTL **180 d** (:20). **Accumulated**: up to 365 reporting days retained (`cross-strait-activity/adapters.mjs:15, :2081`), with a staged 90-day backfill and revision history (:321). Intel-history 180 d | Raw | A one-off full-archive history import exists (`WM_ONE_OFF_HISTORY_RECEIPT`) |
| Cyber threats (IOCs) | seed-cyber-threats.mjs | Feodo Tracker, URLhaus, C2IntelFeeds (GitHub), AlienVault OTX, AbuseIPDB blacklist; geo from ipinfo.io and freeipapi.com | `URLHAUS_AUTH_KEY` (yes), `OTX_API_KEY` (yes), `ABUSEIPDB_API_KEY` (yes) | `cyber:threats:v2`, `cyber:threats-bootstrap:v2`, `cache:cyber:first-seen:v1`, `cache:abuseipdb:threats`, `rate:abuseipdb:last-call` | Per indicator: IP or URL, type, source, country, first-seen | Service, no cron in repo; every 2 h (docs/architecture.mdx:272) | TTL 3 h (:14). First-seen map 14 d (:25), self-pruning to current feed size. 14-day lookback (:40) | Raw | Cyber forecasts are withheld from publication (#8990 docs) |
| Defense industrial base | seed-defense-industrial.mjs | World Bank indicators (`_defense-industrial-source.mjs:261`) | none | `military:industrial-base:v1` | Per country: military expenditure, arms imports and exports | bundle static-ref @ 10 d | TTL 30 d (source :19) | Raw | — |
| Arms suppliers (SIPRI) | seed-defense-industrial-suppliers.mjs | SIPRI arms-transfers backend `atbackend.sipri.org/api/p` | `SIPRI_ARMS_API_BASE_URL` (no; optional override) | `military:arms-suppliers:v1`, `military:arms-suppliers:complete:v1` | Per importer-supplier pair: TIV volumes | bundle static-ref-heavy @ 14 d | TTL 30 d | Raw | A full sweep is ~200 rows |
| Defense patents | seed-defense-patents.mjs | USPTO ODP `api.uspto.gov/api/v1/patent/applications/search` | `USPTO_API_KEY` (yes) | `patents:defense:latest` | Per CPC category: top 20 recent filings | bundle static-ref @ 7 d | TTL 21 d (:12) | Raw | No version suffix on the key |
| Aviation delays, NOTAM, news | seed-aviation.mjs | AviationStack `/v1/flights`; FAA NAS status API; ICAO `dataservices.icao.int/api/notams-realtime-list`; 9 aviation RSS feeds | `AVIATIONSTACK_API` (yes), `ICAO_API_KEY` (yes) | `aviation:delays:intl:v3`, `aviation:delays:faa:v1`, `aviation:notam:closures:v2`, `aviation:news:feeds:v2`, `aviation:delays-bootstrap:v2`, `notifications:dedup:aviation:prev-alerted:v1`, `notam:prev-closed-state:v1`; LPUSH `wm:events:queue` | Per airport (56 international, 30 US): delay %, average delay, cancellations, severity. Per ICAO: closure boolean | Service, no cron in repo; 30 min (docs/architecture.mdx:299; INTL_TTL comment :80) | Intl 3 h, FAA and NOTAM 2 h, news 40 min, bootstrap 2 h (:80-84). Previous state 24 h | Raw + derived severity | AviationStack quota: fetches are skipped and TTLs extended when the quota is exhausted |

### Displacement, health, humanitarian

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| UNHCR displacement summary | seed-displacement-summary.mjs | UNHCR `api.unhcr.org/population/v1/population/` | none | `displacement:summary:v1:<year>` | Per origin-asylum pair: refugees, asylum seekers, IDPs (annual) | bundle health @ 1 d | TTL 24 h (:8) | Raw | Annual data; a new key per year |
| Cross-border arrivals | seed-cross-border-arrivals.mjs | UNHCR ODP `data.unhcr.org/population/get` | none | `displacement:cross-border:v1`; `displacement:cross-border:history:v1`; activation marker | Per situation per receiving country: stock (refugees hosted) and monthly flows (arrivals, deaths) | bundle health @ 1 d | TTL 3 d (:33). **Accumulated**: history of 8 report points per country (:36), key TTL 30 d (:448). Flows cover a 5-month window (:38) | Raw + derived change | CC BY 4.0 |
| IOM DTM displacement | seed-dtm-displacement.mjs | IOM DTM API `dtmapi.iom.int/v3/displacement` | `DTM_API_KEY` (no) | `displacement:dtm:v1`; activation marker | Per admin-1 region: IDPs (latest survey round per operation) | bundle health @ 1 d | TTL 3 d (:19). 18-month lookback (:20) | Raw | Admin-1 points come from `build-dtm-admin1-points.mjs` |
| Disease outbreaks | seed-disease-outbreaks.mjs | WHO DON API; CDC RSS; ECDC feeds; UNOG; ThinkGlobalHealth disease tracker bundle; CIDRAP RSS | none | `health:disease-outbreaks:v1` | Per outbreak item: disease, country, place, date, severity | bundle health @ 1 d | TTL 72 h (:35). 90-day TGH lookback (:64) | Raw | Places resolved via `outbreak-places.json` |
| Demographics capability | seed-demographics-capability.mjs | UN WPP data portal API; World Bank; ILOSTAT SDMX (`_demographics-capability-source.mjs:53-55`) | none | `demographics:capability:v1` | Per country: population, age structure, labour force | bundle static-ref @ 20 d | TTL 30 d (source :8) | Raw | A failed stage retains its prior values |
| Food stocks | seed-food-stocks.mjs | USDA FAS PSD API; FAOSTAT Food Balances (BigQuery API) | `USDA_FAS_PSD_API_KEY` (yes), `USDA_FAS_API_KEY` (no) | `resilience:food-stocks:v1` | Per country per commodity per marketing year: stocks, use, stocks-to-use | bundle resilience @ 30 d | TTL 90 d (`_food-stocks-helpers.mjs:20`) | Raw + derived ratio | — |

### Trade

| Feed | Script | Upstream | Credentials | Writes | Unit and forecasting fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Comtrade bilateral HS4 | seed-comtrade-bilateral-hs4.mjs | UN Comtrade `comtradeapi.un.org/data/v1/get/C/A/HS` (and the preview endpoint) | `COMTRADE_API_KEYS` (yes) | `comtrade:bilateral-hs4:<ISO2>:v1`, `comtrade:bilateral-hs4-partners:<ISO2>:v1`, `comtrade:world-exports-hs4:v1`, `seed-meta:comtrade:bilateral-hs4` | Per reporter-partner-HS4: annual trade value | `0 6 1 * *` (monthly) | TTL 40 d (:38). Annual data, latest period | Raw | Request budget per run. A per-country TTL-refresh streak cap lets dead payloads expire |

### Derived WorldMonitor metrics (recomputable from stored inputs)

| Feed | Script | Inputs | Credentials | Writes | Unit and fields | Cadence | Retention | Notes |
|---|---|---|---|---|---|---|---|---|
| Correlation cards | seed-correlation.mjs | `military:flights:v1` (+ stale), `unrest:events:v1`, `infra:outages:v1`, `seismology:earthquakes:v1`, `market:stocks-bootstrap:v1`, `market:commodities-bootstrap:v1`, `market:crypto:v1`, `news:insights:v1` (:27-35) | none | `correlation:cards-bootstrap:v1`, `correlation:{military,escalation,economic,disaster}:v1` | Per card: domain, linked signals, score | bundle derived-signals @ 5 min | TTL 20 min (:14) | Inputs older than each source's own `maxStaleMin` are rejected |
| Cross-source signals | seed-cross-source-signals.mjs | About 20 keys, including thermal escalation, GPS jam, military surges, unrest, OREF history, markets, cyber, shipping, sanctions, quakes, radiation, outages, wildfire, displacement, forecasts, weather, GDELT tone, regulatory actions, physical divergence (:18-43) | none | `intelligence:cross-source-signals:v1` | Per signal: type, region or country, severity score, contributing sources | bundle derived-signals @ 15 min | TTL 30 min (:14) | The broadest single fan-in in this half. Capturing its inputs lets every past signal be recomputed |
| Five-factor scorecard | seed-five-factor-scorecard.mjs | `scorecard/v1/*` source adapters over WM Redis keys (rankable country universe) | none | `scorecard:five-factor:v1`, `scorecard:five-factor:v1:read-model` (+ staging), `scorecard:five-factor:v1:fingerprint`; activation marker | Per country: five factor scores and composite | bundle resilience @ 1 d | TTL 3 d (:35) | Atomic cohort publish |
| Energy spine, chokepoint flows, climate anomalies, China decision signals | (see their sections above) | — | — | — | — | — | — | All derived |

### Forecast system (consumers that also archive)

| Feed | Script | Upstream / inputs | Credentials | Writes | Unit and fields | Cadence | Retention | Raw / derived | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Forecasts | seed-forecasts.mjs (20,055 lines) | About 40 WM Redis keys: markets (stocks, commodities, sectors, gulf, ETF, crypto, stablecoins), BIS, shipping, correlation, FRED series (:275-298), temporal anomalies, theater posture, military forecast inputs, prediction markets, chokepoints, Iran events, UCDP, unrest, cyber, CII risk and others (:350-358). OpenRouter LLM | `OPENROUTER_API_KEY` (yes), `FORECAST_LLM_*` model and order vars (partly yes), `AXIOM_API_TOKEN` (yes), `R2_*` (no locally) | `forecast:predictions:v2`, `forecast:predictions-bootstrap:v1`, `forecast:predictions:prior:v2`, `forecast:predictions:history:v1`, `forecast:trace:latest:v1`, `forecast:trace:runs:v1`, `forecast:funnel:health:v1`, `forecast:calibration-publication:v1`, `forecast:sim-decorations:v1`, deep-task queue and lock keys; **R2** `seed-data/forecast-traces/<YYYY>/<MM>/<DD>/<runId>/{manifest,summary,world-state,…}.json` and `…/forecasts/<id>.json` (:104, :5188-5198, :12807) | Per forecast: question, probability, horizon, resolution rule, subject, evidence. Per run: world state, funnel counts | Service, no cron in repo; hourly (:69-72) | Predictions TTL 6 h (:69). **History**: LPUSH/LTRIM 200 runs × 25 forecasts, TTL 45 d (:70-77, :5028-5029). Trace pointers 50 runs, 60 d (:92-93). Calibration publication 90 d (:91). **R2 traces: lifecycle deletion after 400 days**, applied 2026-10-09 per year rule for 2024-2027; the 2028 rule must be added before 2028-01-01 (`docs/panels/forecast.mdx`, commit d49477575b) | Derived (LLM + detectors) | Snapshots hold licensed ACLED and news data and must stay private. The R2 world-state files are the only multi-month record of the fused inputs |
| Forecast resolutions + scorecard | seed-forecast-resolutions.mjs (3,442 lines) | `forecast:predictions:history:v1`, `forecast:bets:history:v1`, resolution feeds (FRED, conflict counts, markets), `digest:accumulator:v1:full:en` (news archive for LLM judges) | `OPENROUTER_API_KEY` (yes), `FORECAST_PROMOTE_BET_ENGINE` (no) | `forecast:resolutions:v1` (ledger), `forecast:scorecard:v1`, `forecast:calibration-map:v1`, `forecast:evidence:v1`, `forecast:evidence:record:v1:*`, `forecast:evidence:coverage:v1`; **R2 receipts** `<basePrefix>/forecast-resolutions/<day>/<key>-<resolvedAt>.json` (:3386) | Per forecast: outcome (YES, NO or VOID), Brier inputs, judge verdicts; scorecard by origin | Service, no cron in repo; daily (:15) | Scorecard 7 d (:56). Calibration map 90 d (:62). Ledger keeps terminal entries until receipted and older than the 180-day window (:158-165). Evidence 15 d TTL with a 14-day lookback (`_forecast-evidence-archive.mjs:31-33`). **R2 receipts are not covered by the trace lifecycle and are kept indefinitely** | Derived | This is the labelled outcome store. Receipts must not be written under the trace prefix (:3365) |
| Shadow bet engine | seed-forecast-bets.mjs | Energy and market resolvable feeds via `_bet-templates-*`; news titles from the digest accumulator (3-day window, :359) | `FORECAST_BETS_ENSEMBLE` (no), `R2_*` (no locally) | `forecast:bets:history:v1`, `forecast:bets:eia-series:v1`; **R2** input snapshot `<basePrefix>/<Y>/<M>/<D>/<runId>/bets-input-snapshot.json` (`_forecast-bets-keys.mjs:20`) | Per bet: template, threshold, horizon, base rate, ensemble probability | Service, no cron in repo; daily (:37) | History LPUSH/LTRIM 200 runs, TTL 45 d (:40, :44). **EIA observation series accumulated, TTL 400 d** (:47). R2 snapshots fall under the 400-day trace lifecycle if they sit under that prefix | Derived | Never writes the user-facing canonical |

### Not ingestion (listed for completeness)

| Script | What it does | Writes |
|---|---|---|
| seed-digest-notifications.mjs | Every 30 minutes, reads `digest:accumulator:v1:<variant>:<lang>` (ZSET), `story:track:v1:*` and `story:sources:v1:*`. It formats digests and sends them by email (Resend) and Telegram. | `digest:last-run` (7 d), `digest:last-sent:v1:<user>:<variant>` (8 d), `digest:sent:v1:*`, `brief:<…>` and `brief:latest:<user>` (7 d), `relay:entitlement:<user>` (15 min). The accumulator it reads is written by `server/worldmonitor/news/v1/list-feed-digest.ts` (TTL 48 h, `server/_shared/cache-keys.ts:66`). The `full:en` accumulator previously grew without bound and is pruned to 8 days only once `FORECAST_EVIDENCE_CUTOVER_ENABLED` is set (`_forecast-evidence-archive.mjs:70-74`). This is the de facto news archive: verify its live depth before designing on it. |

## Non-seed scripts sorting before `seed-m`

| Script | Upstream | Writes | Cadence | Retention | Notes |
|---|---|---|---|---|---|
| ais-relay.cjs | aisstream.io, Telegram, X, OREF/Tzeva Adom, UCDP, CelesTrak, Yahoo/Finnhub/CoinGecko, NWS/ECCC/WMO, USAspending, NY Fed GSCPI, World Bank, corridorrisk.io, USNI, Reddit, PizzINT/BestTime and others | See `inventory-ais-relay.md` (31 feeds) | Always on | See the closing sections | AIS positions and Telegram text never leave memory |
| fetch-gpsjam.mjs | `gpsjam.org/data` manifest + `{date}-h3_4.csv` | `intelligence:gpsjam:v2`, `intelligence:gpsjam:v1`, `seed-meta:intelligence:gpsjam`, plus a local JSON file | Service `seed-gpsjam`; 6 h (docs/architecture.mdx:298) | TTL 48 h (:26) | Per H3 res-4 hex: good and bad aircraft counts, interference %. gpsjam.org keeps daily files, so this can be backfilled |
| company-monitoring-worker.mjs | Exa, X, OpenRouter (per-tenant company scans) | Convex owns the data; Redis gets only `company-monitoring:worker-health:v1` (15 min) and seed-meta | Always on | Convex | Tenant data. Exclude from a shared memory lake |
| process-deep-forecast-tasks.mjs, process-simulation-tasks.mjs, scenario-worker.mjs | LLM workers over WM Redis | Forecast deep-task and simulation keys; `scenario-queue:*` results (24 h) | Always on | Short | No upstream ingest |
| build-chokepoint-transit-snapshot.mjs | IMF PortWatch ArcGIS (full daily transit history) | `docs/snapshots/*.json` (committed) | Operator-run | Committed files | A frozen history snapshot. It is the only full-history PortWatch copy in the repo |
| build-dtm-admin1-points.mjs | fieldmaps.io admin-1 points (OCHA COD-AB, CC BY-IGO) | `scripts/data/dtm-admin1-points.json` | Manual | Committed | Reference geometry |
| build-outbreak-places.mjs | GeoNames dumps (CC BY 4.0) | `scripts/data/outbreak-places.json` | Manual | Committed | Reference gazetteer |
| fetch-mirta-bases.mjs, fetch-osm-bases.mjs, fetch-pizzint-bases.mjs, build-military-bases-final.mjs | USACE MIRTA ArcGIS, Overpass, Polyglobe Supabase | `scripts/data/*-processed.json`, `military-bases-final.json` | Manual | Committed | Static reference |
| fetch-country-boundary-overrides.mjs | Natural Earth 50m | Local geojson, then uploaded to R2 `worldmonitor-maps` by hand | Manual | — | Map geometry |
| freeze-github-stars.mjs, freeze-crawlable-live-pulse.mjs | GitHub API; WM public API | `docs/snapshots/*.json` | Manual | Committed, dated | The live-pulse snapshots are dated copies of country risk, chokepoint status, HAPI, headlines, market tape and the forecast scorecard. Each commit is a point-in-time vintage |
| import-gem-pipelines.mjs | GEM Oil & Gas Infrastructure Tracker (local file, CC BY 4.0) | `scripts/data/pipelines-{gas,oil}.json` | Manual | Committed | Static reference |
| generate-oref-locations.mjs, generate-airline-codes.mjs | GitHub raw (pikud-haoref-api, OpenFlights) | Generated source files | Manual | Committed | Reference |

## Feeds with history kept today (more than 7 days)

**Accumulated by WorldMonitor.** These survive upstream changes:

| Store | What | How long | Citation |
|---|---|---|---|
| Convex intel-history (`/relay/intel-history`) | Embedded records from ACLED events (seed-conflict-intel), energy news (seed-energy-intelligence) and cross-Strait observations (seed-cross-strait-activity). Up to 150 records per run | **180 days**, pruned by a daily cron | `convex/intelHistory.ts:68`; `_seed-history.mjs:44` |
| R2 forecast traces | Per-run world state, summaries and per-forecast files | **400 days** (bucket lifecycle since 2026-10-09; yearly rules 2024-2027) | `docs/panels/forecast.mdx`; `seed-forecasts.mjs:104` |
| R2 forecast resolution receipts | Terminal outcome per forecast | **Indefinite** (excluded from the lifecycle) | `seed-forecast-resolutions.mjs:3386` |
| R2 bet input snapshots | Per-run bet-engine inputs | Up to 400 days if under the trace prefix (unverified) | `_forecast-bets-keys.mjs:20` |
| `forecast:resolutions:v1` | Working resolution ledger | Terminal entries until receipted and older than 180 days | `seed-forecast-resolutions.mjs:158-165` |
| `forecast:predictions:history:v1` | Last 200 forecast runs × 25 forecasts | 45 d TTL (about 8 days at hourly cadence) | `seed-forecasts.mjs:70-77` |
| `forecast:bets:history:v1` | Last 200 bet runs | 45 d TTL | `seed-forecast-bets.mjs:40-44` |
| `forecast:bets:eia-series:v1` | Accumulated EIA observation series | 400 d TTL | `seed-forecast-bets.mjs:47` |
| `forecast:calibration-map:v1`, `forecast:calibration-publication:v1` | Calibration state | 90 d | `seed-forecast-resolutions.mjs:62`; `seed-forecasts.mjs:91` |
| `forecast:trace:runs:v1` | Pointers to the last 50 runs | 60 d | `seed-forecasts.mjs:92-93` |
| `gdelt:bulk:dyad-tension:v1` | Per country pair, per day event cohorts | 90 completed days (key TTL 92 d) | `_gdelt-dyad-tension.mjs:35, :60`; `seed-gdelt-bulk-materializer.mjs:89` |
| `military:cross-strait-activity:v1` | Daily PLA activity reports and Japan MOD observations with revisions | Up to 365 reporting days; key TTL 180 d | `cross-strait-activity/adapters.mjs:15`; `seed-cross-strait-activity.mjs:20` |
| `market:china:stock-connect:v1` | Daily Stock Connect and margin rows | Last 180 trade dates; key TTL 3 d, refreshed each run | `china-stock-connect/adapters.mjs:39` |
| `china:policy-events:v1` | Policy documents from 6 agencies | 180-day window, at most 120 events | `seed-china-policy-events.mjs:18-19` |
| `market:china:corporate-disclosures:v1` | Announcements with revision history | At most 100 events (age bound unverified) | `china-corporate-disclosures/adapters.mjs:168` |
| `displacement:cross-border:history:v1` | Per country UNHCR report points | Last 8 reports; key TTL 30 d | `seed-cross-border-arrivals.mjs:36, :448` |
| `cache:cyber:first-seen:v1` | First-seen date per IOC | 14 d, self-pruning to feed size | `seed-cyber-threats.mjs:25` |
| `intelligence:pizzint:history:v1:<provider>:<day>` (relay) | 15-minute venue busyness readings with quality flags | **90 days** | `shared/pizzint-history.cjs:10` |
| `classify:jev-shadow:v1` (relay) | Classifier disagreement log | 14 d / 2000 rows | `inventory-ais-relay.md` |
| `docs/snapshots/*` (git) | Dated crawlable live-pulse and PortWatch transit snapshots | Indefinite, but only when an operator runs the freeze | `freeze-crawlable-live-pulse.mjs`, `build-chokepoint-transit-snapshot.mjs` |

**Long TTL on a single snapshot (more than 7 days).** These hold only the latest vintage. Older vintages are overwritten:

- Static and annual: chokepoint baselines (400 d), IEA crisis policies (400 d), BIS LBS (100 d), climate zone normals (95 d), FAO FFPI (90 d; 12 months of content), FATF (90 d), food stocks (90 d), Comtrade HS4 (40 d), education attainment (35 d), fossil electricity share (35 d), Eurostat house prices (35 d), gold CB reserves (30 d), defense industrial and arms suppliers (30 d), demographics (30 d), China release calendar (45 d).
- Weekly: defense patents (21 d), energy disruptions (21 d), EIA weeklies in seed-economy (21 d), COT (14 d), Eurostat government debt (14 d), Big Mac, grocery and fuel prices (10 d, with a 20-day `:prev` copy).
- China macro and China policy events (7 d), EIA petroleum (7 d).

**Upstream windows long enough to backfill from source.** No WorldMonitor retention is needed; a memory lake can pull history directly:

| Source | Depth available | Script |
|---|---|---|
| GDELT 2.0 export/GKG | Back to 2015 | seed-gdelt-bulk-materializer |
| AAII | Back to 1987 | seed-aaii-sentiment |
| SPDR GLD | ~5,500 daily rows | seed-gold-etf-flows |
| FAO FFPI | Back to 1990 | seed-fao-food-price-index |
| FRED, BIS, ECB, Eurostat, IMF, World Bank | Full series | — |
| CFTC COT | Full history | seed-cot |
| NOAA GML, NSIDC | Full history | seed-co2-monitoring, seed-climate-ocean-ice |
| Open-Meteo ERA5 | Full archive | seed-climate-anomalies |
| UNHCR | Full history | seed-displacement-summary |
| USGS FDSN | Full archive (the current feed is a 7-day window) | seed-earthquakes |
| Bank of Russia key rate | Full history | seed-cbr-rates |
| CelesTrak | Current TLEs only | relay |
| gpsjam.org | Daily files | fetch-gpsjam |
| NASA FIRMS | Archive API | seed-fire-detections |
| ACLED | Full history, but licensed and dark in production | seed-conflict-intel |

## Feeds that only hold a live snapshot

Each run overwrites the previous value, so nothing older than the key TTL exists anywhere in WorldMonitor. These feeds also cannot be backfilled from the upstream, or can be only partly. A memory lake must capture them at write time:

- **Scraped or volatile upstream, no backfill possible:**
  - Big Mac and grocery basket (Exa or Firecrawl; one `:prev`).
  - Retail fuel prices (several government pages publish only the latest weeks; one `:prev`).
  - CNN Fear & Greed and Barchart put/call (the `market:fear-greed:v1` composite).
  - China corporate disclosures beyond 100 events.
  - Cyber IOCs (14-day feeds).
  - Aviation delays and NOTAM closures (AviationStack and ICAO are live only).
  - Alberta and BC alerts, wildfire active fires (CWFIS and BC active-fire states).
  - Global tenders, earnings calendar.
  - PizzINT DEFCON and GDELT tension pairs (`intel:pizzint:v1:*`, 10 minutes).
  - Relay-only live streams: AIS positions, chokepoint transits and AIS-gap counts, Telegram, X, Reddit and WSB, theater posture, corridor risk, USNI fleet, weather alerts, OREF beyond 7 days, news threat summary, notification queue.
- **Derived values whose inputs are themselves snapshot-only.** These cannot be recomputed later unless the inputs are captured:
  - `correlation:cards-bootstrap:v1` (20 min).
  - `intelligence:cross-source-signals:v1` (30 min).
  - `intelligence:china-decision-signals:v1` (24 h).
  - `scorecard:five-factor:v1` (3 d).
  - `energy:spine:v1:*` (48 h).
  - `energy:chokepoint-flows:v1` (3 d).
  - `climate:anomalies:v2` (9 h; the inputs can be backfilled from ERA5).
  - `market:etf-flows:v1` (90 min).
  - `market:fear-greed:v1` (18 h).
  - `economic:macro-signals:v1` (6 h).
  - `health:china-coverage:v1` (operational).
- **Raw snapshots of backfillable sources.** These are low priority for capture: markets (commodities, crypto, FX), FRED, BIS, ECB, Eurostat, BoC, CBR, China macro, EIA, Ember, ENTSO-E prices, GIE storage (5-day window), CO2, ocean and ice, earthquakes, UNHCR, DTM, disease outbreaks, demographics, food stocks, Comtrade.

## Data and licence notes worth carrying into the design

- **ACLED.** No ACLED credentials are present locally, and the memory note records ACLED as dark in production. Forecast snapshots containing ACLED rows must stay private (`docs/panels/forecast.mdx`).
- **Dual writers.** These keys have two producers, the relay plus a cron or bundle: `market:*` quotes, `market:crypto:v1`, `market:etf-flows:v1`, `climate:news-intelligence:v1`, `energy:chokepoint-flows:v1` (relay-hosted), `economic:spending:v1`, `economic:worldbank-techreadiness:v1`, `conflict:ucdp-events:v1` and theater posture. Capture at the canonical key with the producer recorded.
- **Dark or manual.**
  - `seed-gdelt-intel.mjs`: deprecated, not run.
  - `seed-consumer-prices.mjs`: manual fallback only.
  - Relay cyber loop: not started.
  - `seed-cyber-threats.mjs`: owns the cyber keys.
- **Locally absent credentials** (Railway state unverified): `ACLED_*`, `DTM_API_KEY`, `RELIEFWEB_APPNAME`, `ALPHA_VANTAGE_API_KEY`, `COINGECKO_*`, `CONSUMER_PRICES_CORE_*`, `R2_*`, `JAPAN_MOD_PROXY_URL`, `FIRMS_API_KEY` (the `NASA_FIRMS_API_KEY` alias is present).
- **Licence hints in code.**
  - CC BY 4.0: UNHCR ODP, Ember, GEM, GeoNames.
  - CC BY-IGO: OCHA COD-AB.
  - Public domain: OpenFlights.
  - Terms links: BIS, SSE, SZSE and HKEX.
  - Bank of Canada terms page linked in `lib/boc-valet.mjs`.
  - USNI and corridorrisk.io are scraped publisher or dashboard content.
- **Cadence gaps.** Cron schedules for about 20 standalone services are kept only in the Railway dashboard. Examples: seed-aviation, seed-cot, seed-forecasts, seed-forecast-resolutions, seed-forecast-bets, seed-commodity-quotes, seed-fear-greed, seed-electricity-prices, seed-ember-electricity, seed-energy-spine, seed-fuel-prices, seed-bigmac, seed-grocery-basket, seed-fx-rates, seed-fx-yoy, seed-cyber-threats, seed-earnings-calendar, seed-economic-calendar, seed-energy-intelligence and seed-aaii-sentiment. The cadences given for these come from code comments, TTL rationale or `docs/architecture.mdx`; that doc is partly stale (it says seed-forecasts runs every 15 minutes, while the code comments say hourly).
