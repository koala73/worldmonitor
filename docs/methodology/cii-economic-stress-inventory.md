---
noindex: true
---

# CII economic-stress input inventory

## OQ9 owner ruling — 13 November 2026

The owner approved partial coverage after this inventory found no two independent series covering all 31 countries. The selected members are currency depreciation, consumer-price inflation acceleration and the 10-year government yield, each measured against the country's own trailing level. CPI mirrors count as one member.

A country with at least one fresh member is measured. A country with none is published with `measured: false`, scored without the family, and labelled **economic stress not measured** in the response and methodology page. Missing or stale members are absent, never zero. A held peg is an observed zero currency move. The United States, Germany and France have no currency member.

Freshness limits are 7 days for currency, 4 months for monthly inflation, 7 months for quarterly inflation, and 3 months for monthly yields. U18 may tighten these limits; loosening them requires the owner. U18 must show that member count alone does not increase a country's score. An unreadable input key or an incorrect country list still refuses publication; a country without a member does not.

The unmeasured released countries are KP, CU, SY, YE, MM and AF. Cuba and North Korea receive no economic term despite economic distress; the methodology page must state this cost. Among the six additions, PH, TH, ID, VN and MY have inflation and currency; KH has neither fresh.

The GET-only refresh begun **2026-11-13T05:25:57.688Z** confirms 25/31 with at least one fresh source observation under these limits. This is source coverage, not proof that the unpublished currency monthly path or every derived member is ready. The producer must verify sufficient history separately. Monthly and quarterly dates represent observation periods; their end dates determine age.

**Health threshold check:** keep the owner's threshold of fewer than 25 measured countries. India's CPI ends in July 2026, but its currency observation is dated 2026-11-12. Removing India's inflation member alone still leaves 25 measured countries. Normal CPI publication lag therefore does not trigger this count alarm while currency stays fresh. Member-level absence remains visible; a later loss of all fresh members must alarm. Do not lower the threshold automatically to match an outage.

This ruling unblocks U20's producer; it does not complete its implementation or live acceptance. The original inventory below remains a dated record of the inputs examined.

## Evidence and limits

Repository baseline: `083f8a56b2de43c79817ce46372fcf40e84173b2` (main, after #10590, #10591 and #10593). Examined `api/health.js`, `scripts/seed-*.mjs`, shared source contracts and `shared/source-attribution-manifest.json`. Production observations below came from GET-only reads of existing Redis keys beginning at **2026-11-13T02:47:21.140Z**. No upstream collection or Redis write was run. The read was sequential, not an atomic cross-key snapshot.

Counts mean a country entry was present, not that it is fresh, complete, licensed for a new use, or suitable for scoring. Reference periods below expose stale entries. A seeder's run time is not the economic observation date. This is not a calibration fixture. Aggregate feed health cannot prove that every country is current.

## Candidate families

Key prefixes below are literal. `:latest:v1` CPI companions contain projections of the same history; they are not independent series.

| Family and existing producer | Existing key / retained information | Observation frequency and lag | Coverage / qualification |
| --- | --- | --- | --- |
| IMF national CPI (`seed-world-cpi-imf.mjs`) | `economic:world-cpi:imf:v1`; up to 120 monthly or 40 quarterly points per country | Monthly or quarterly; country-specific release lag. Latest periods in the matrix below. | 28/31 and 6/6 have history. TW, KP, CU absent. SY ends 2019-12, YE 2015-12, MM 2020-11. AE, AF and QA also substantially delayed. |
| Eurostat HICP (`seed-world-cpi-eurostat.mjs`) | `economic:world-cpi:eurostat:v1`; monthly history | Monthly; DE/FR/PL latest 2026-09 | DE, FR, PL among the 31; none of the six. Alternative inflation series, not a second independent family. |
| Japan CPI (`seed-world-cpi-estat.mjs`), Australia CPI (`seed-world-cpi-abs.mjs`) | `economic:world-cpi:estat:v1`, `economic:world-cpi:abs:v1` | JP monthly, latest 2026-09; AU quarterly, latest 2026-Q3. Both retain history. | JP among the 31; none of the six. |
| US CPI (`seed-us-cpi.mjs`) | `economic:us-cpi:v1` plus latest projection; headline and components | Monthly BLS/FRED history; publication lag, not daily inflation | US only. Components share the price family. |
| Yahoo FX history (`seed-fx-yoy.mjs`) | `economic:fx:yoy:v1`; current/year-ago rate, dated two-year extrema and derived changes | Monthly bars plus newest bar; refreshed daily. Cached summary does not retain the full two-year path needed for arbitrary 90-day calculations. | 18/31 and 5/6. USD and shared currencies intentionally excluded; KH absent. Missing list below. |
| Yahoo spot FX (`seed-fx-rates.mjs`) | `shared:fx-rates:v1`; current currency-to-USD rates | Current quotes; no per-currency observation date or trailing history in this payload | Auxiliary conversion data, not a stress series. VND is null in this read. USD is the numeraire, not an independent observation. |
| ECB FX (`seed-ecb-fx-rates.mjs`) | `economic:ecb-fx-rates:v1`; seven EUR pairs and one-day changes | Business-day reference rates; snapshot dated 2026-11-11 | CN, GB, JP, US plus EUR context for DE/FR; none of the six. No 90-day history in key. |
| BIS effective FX (`seed-bis-data.mjs`) | `economic:bis:eer:v1`; real effective rate and recent change | Monthly; latest cached period 2026-09 | Configured major-economy subset, listed below. Same FX family, no full trailing path in key. |
| CBR (`seed-cbr-rates.mjs`) | `economic:cbr-rates:v1`; RUB crosses/current and previous dates, RU key-rate history | Daily official FX and policy-rate decisions; snapshot effective 2026-11-12 | RU-centered data, not independent country-risk observations for every quoted currency. Official crosses may not measure accessible market rates. |
| Official food prices (`seed-food-prices-*.mjs`) | `economic:food-prices:<id>:v1`; item/market observations retained only within 14 days of the newest observation, or country briefs | Daily through annual; per-source table below gives actual latest dates and configured age limits | Numeric observations for PK, MX, YE, TW among the 31; PH, TH, ID, MY among the six. No 90-day history; monthly observations lose the prior month. Context-only briefs are not numeric price histories. |
| Fuel (`seed-fuel-prices.mjs`) | `economic:fuel-prices:v1`; dated gasoline/diesel prices and week-over-week changes where available | Weekly runner, heterogeneous source cadence; row-level `observedAt` is authoritative | 9/31 and 2/6 country entries. Does not retain a two-year price history in the canonical key. |
| OECD / ECB government yields (`seed-oecd-lt-rates.mjs`) | `economic:yield-curve:oecd-lt:v1`; monthly 10-year histories | Monthly; source-specific release lags and age budgets in `scripts/lib/yield-curves/oecd-lt.mjs` | 8/31, none of the six. Nominal yields, not ready-made sovereign credit spreads. |
| National government curves (`seed-yield-curve-{jp,ca,de,gb,au,ch,no,se}.mjs`) and US Treasury | `economic:yield-curve:<country>:v1`; `economic:us-treasury-par-yield:v1` | Business-day histories; retained old sections may be weekly | US, JP, DE, GB among the 31; none of the six. Overlaps the yield family. |
| Euro-area curve (`seed-yield-curve-eu.mjs`) | `economic:yield-curve-eu:v1`; AAA aggregate curve dated 2026-11-11 | Business-day snapshot | Currency-area aggregate, not separate DE/FR sovereign observations; no full history in this key. |

The FX-history missing countries are: US, RU, IR, KP, DE, FR, SY, YE, MM, VE, CU, IQ, AF. These exclusions include the policy choice to omit USD/shared currencies, not only upstream failure. Do not silently change that attribution in the CII producer.

## Country-level coverage and dates

`—` means absent from the named key. CPI shows the last observation period, including stale history. FX shows the recorded `asOf`. Fuel and yield entries below are present, not necessarily fresh or usable. The six proposed additions follow the 31 released countries.

| Country | IMF CPI latest period | FX history as-of | Fuel observation (gasoline / diesel) | OECD/ECB monthly yield latest |
| --- | --- | --- | --- | --- |
| US | 2026-09 | — | 2026-11-02 / 2026-11-02 | 2026-09-01 |
| RU | 2026-08 | — | — | — |
| CN | 2026-10 | 2026-11-12 | — | — |
| UA | 2026-09 | 2026-11-12 | — | — |
| IR | 2026-08 | — | — | — |
| IL | 2026-09 | 2026-11-12 | — | — |
| TW | — | 2026-11-12 | 2026-11-07 / 2026-11-07 | — |
| KP | — | — | — | — |
| SA | 2026-09 | 2026-11-12 | — | — |
| TR | 2026-09 | 2026-11-12 | — | — |
| PL | 2026-09 | 2026-11-12 | 2026-11-02 / 2026-11-02 | 2026-10-01 |
| DE | 2026-09 | — | 2026-11-02 / 2026-11-02 | 2026-10-01 |
| FR | 2026-09 | — | 2026-11-02 / 2026-11-02 | 2026-10-01 |
| GB | 2026-09 | 2026-11-12 | 2026-11-02 / 2026-11-02 | 2026-09-01 |
| IN | 2026-07 | 2026-11-12 | — | — |
| PK | 2026-10 | 2026-11-12 | — | — |
| SY | 2019-12 | — | — | — |
| YE | 2015-12 | — | — | — |
| MM | 2020-11 | — | — | — |
| VE | 2026-10 | — | — | — |
| CU | — | — | — | — |
| MX | 2026-09 | 2026-11-12 | 2026-11-10 / 2026-11-10 | 2026-09-01 |
| BR | 2026-09 | 2026-11-12 | 2026-11-07 / 2026-11-07 | — |
| AE | 2025-12 | 2026-11-12 | — | — |
| KR | 2026-10 | 2026-11-12 | — | 2026-09-01 |
| IQ | 2026-09 | — | — | — |
| AF | 2025-01 | — | — | — |
| LB | 2026-08 | 2026-11-12 | — | — |
| EG | 2026-10 | 2026-11-12 | — | — |
| JP | 2026-09 | 2026-11-12 | — | 2026-09-01 |
| QA | 2025-08 | 2026-11-12 | 2026-10-01 / 2026-10-01 | — |
| PH | 2026-09 | 2026-11-12 | 2026-11-03 / 2026-11-03 | — |
| TH | 2026-08 | 2026-11-12 | — | — |
| ID | 2026-10 | 2026-11-12 | — | — |
| VN | 2026-09 | 2026-11-12 | — | — |
| MY | 2026-09 | 2026-11-12 | 2026-11-05 / 2026-11-05 | — |
| KH | 2026-04 | — | — | — |

## Food-price source inventory

The registry is `scripts/shared/food-price-sources.json`. Keys are `economic:food-prices:<id>:v1`. Maximum age is the registry's content-age budget, not a claim of publisher release lag. Latest observation is from the read above; country briefs can have a reference date without any numeric price observations. All rows carry the same licence caveat in the next section unless their provider's ledger entry says otherwise.

`mergeFoodSnapshot` in `scripts/lib/food-prices-seed.mjs` calls `mergeHistory` in `scripts/lib/food-prices.mjs`. It drops observations older than 14 days before the newest incoming observation. A long cache TTL does not extend this history: monthly sources normally retain only one observation period, and these keys cannot supply a 90-day price change without a separately approved retention change.

| Source ID | Country | Cadence | Max content age (days) | Numeric rows | Latest numeric observation | Registry context-only |
| --- | --- | --- | --- | --- | --- | --- |
| pihps | ID | daily | 7 | 231 | 2026-11-12 | no |
| pbs | PK | weekly | 21 | 1719 | 2026-11-05 | no |
| da | PH | daily | 7 | 8118 | 2026-11-11 | no |
| cbsl | LK | daily | 7 | 1473 | 2026-11-10 | no |
| sniim | MX | daily | 7 | 846 | 2026-11-11 | no |
| giews | multiple | irregular | 365 | 0 | — | yes |
| onagri | TN | monthly | 180 | 28 | 2026-07-01 | yes |
| tcb | BD | daily | 7 | 1100 | 2026-11-11 | no |
| nabc | TH | daily | 7 | 69 | 2026-11-11 | no |
| nsckg | KG | daily | 7 | 3434 | 2026-11-11 | no |
| statkz | KZ | weekly | 21 | 1953 | 2026-11-04 | no |
| statuz | UZ | monthly | 100 | 37 | 2026-09-01 | yes |
| maga | GT | daily | 7 | 777 | 2026-11-11 | no |
| ocpv | CI | weekly | 21 | 1572 | 2026-11-01 | no |
| sima | NE | weekly | 21 | 605 | 2026-11-03 | no |
| mit | TZ | daily | 14 | 952 | 2026-11-09 | no |
| ucda | UG | daily | 7 | 151 | 2026-11-11 | no |
| amman | JO | daily | 7 | 1049 | 2026-11-12 | no |
| madr | DZ | daily | 10 | 99 | 2026-11-11 | no |
| nsomn | MN | weekly | 21 | 513 | 2026-11-02 | no |
| fewssd | SD | monthly | 100 | 90 | 2026-09-30 | yes |
| fewsss | SS | monthly | 100 | 121 | 2026-09-30 | yes |
| fewsye | YE | monthly | 100 | 186 | 2026-09-30 | yes |
| fewsht | HT | monthly | 100 | 208 | 2026-09-30 | yes |
| twmoa | TW | daily | 10 | 914 | 2026-11-12 | no |
| geostat | GE | monthly | 100 | 0 | — | yes |
| pricecatcher | MY | daily | 10 | 45 | 2026-11-11 | no |
| mcba | AR | daily | 10 | 2168 | 2026-11-10 | no |
| cso | IE | monthly | 100 | 44 | 2026-10-01 | yes |
| statec | LU | annual | 430 | 13 | 2026-06-01 | yes |
| foagfruit | CH | monthly | 100 | 509 | 2026-09-01 | yes |
| foagegg | CH | monthly | 100 | 22 | 2026-09-01 | yes |
| foagmilk | CH | monthly | 100 | 44 | 2026-09-01 | yes |
| csblv | LV | monthly | 100 | 118 | 2026-10-01 | yes |
| makstat | MK | monthly | 100 | 0 | — | yes |

## Other seeded series and exclusions

These were also inspected so that global indicators, old reference values and paid-search estimates are not mistaken for missing independent country histories.

| Producer / key | Frequency, lag and retained data | Country coverage / reason not selected |
| --- | --- | --- |
| IMF WEO macro / `economic:imf:macro:v2` | Annual vintages and forecasts, despite periodic seeding; latest annual fields and field-specific years | 27/31 and 6/6 entries; KP, SY, CU, IQ absent. Annual inflation forecasts do not replace monthly observed CPI. Fiscal inputs are outside v15's measured scope. |
| BIS policy, credit, debt-service and property / `economic:bis:{policy,credit,dsr,property-residential,property-commercial}:v1` | Monthly policy rate; quarterly credit, debt service and property; latest/previous changes, not complete histories | Major-economy subsets below. Policy rates are not sovereign credit spreads; credit and property levels do not by themselves measure acute stress. |
| BIS locational banking / `economic:bis-lbs:v1` | Quarterly exposure and parent-bank composition, with annual GDP reference | Exposure context, not a dated currency, consumer-price or sovereign-funding shock. |
| China macro / `economic:china:macro:v2` | Dated national monthly/quarterly observations with publisher and pillar status | CN only; not all-country coverage. |
| US FRED/rates / `economic:fred:batch:v1`, per-series keys; `economic:us-interest-rates:v1` and history partitions | Daily rates/spreads/stress indicators, monthly inflation; series-specific release dates | US/global market context. A US corporate spread is not a sovereign spread for all countries. |
| ECB short rates / `economic:fred:v1:<series>:0` | Daily €STR / Euribor histories; publication lag | Euro-area funding context, not individual-country credit risk. |
| Eurostat house prices / `economic:eurostat:house-prices:v1` | Annual housing indices | Slow reference context, not acute price stress. |
| Big Mac / `economic:bigmac:v1` | Weekly search-based current price and previous snapshot comparison | Configured country list excludes KP and several other targets; existing EXA collection is key-gated. Not a representative national consumer-price basket. |
| Grocery basket / `economic:grocery-basket:v1` and `:history` | Retailer observations and bounded snapshot history; search/scrape collection | Selected-country retailer baskets, not all 31; existing EXA/Firecrawl paths are key-gated. Retained history requires per-item comparability checks before use. |
| Consumer prices / `consumer-prices:*:ae` | Retailer scrape/aggregate/publish pipeline; current index and 7/30/90-day series | AE default market. The manual fallback seeder is not the authoritative writer. No all-country coverage claim. |
| Electricity / `energy:electricity:v1:<region>` | Hourly/day-ahead EU bidding-zone data and US regional EIA data; three-day TTL | DE, FR, PL zones among the 31; US regions are not a national retail price index. None of the six. Existing authenticated upstream paths; no new source proposed. |
| FAO food-price index; energy/commodity benchmarks | Global monthly food index and market quotes | No country-specific observations. Cannot count as 31 independent national price series. |
| USDA/FAOSTAT food stocks, GDP, trade and sovereign-wealth assets | Annual/quarterly levels and resilience context | Not acute price, currency or sovereign-funding stress. No level term proposed. |

### Observed subset membership

For each key, these are the target-country entries present in this read; absence and stale values are not repaired here.

- `economic:bis:eer:v1`: 7/31 (US, CN, GB, IN, BR, KR, JP); 0/6 (none).
- `economic:bis:policy:v1`: 7/31 (US, CN, GB, IN, BR, KR, JP); 0/6 (none).
- `economic:bis:credit:v1`: 7/31 (US, CN, GB, IN, BR, KR, JP); 0/6 (none).
- `economic:bis:dsr:v1`: 13/31 (US, RU, CN, TR, PL, DE, FR, GB, IN, MX, BR, KR, JP); 3/6 (TH, ID, MY).
- `economic:bis:property-residential:v1`: 14/31 (US, RU, CN, IL, TR, PL, DE, FR, GB, IN, MX, BR, KR, JP); 4/6 (PH, TH, ID, MY).
- `economic:bis:property-commercial:v1`: 5/31 (US, TR, DE, FR, JP); 2/6 (PH, ID).
- `economic:fuel-prices:v1`: 9/31 (US, TW, PL, DE, FR, GB, MX, BR, QA); 2/6 (PH, MY).
- `economic:bigmac:v1`: 20/31 (US, CN, UA, IL, TW, SA, PL, DE, FR, GB, IN, PK, MX, BR, AE, KR, LB, EG, JP, QA); 5/6 (PH, TH, ID, VN, MY).
- `economic:grocery-basket:v1`: 15/31 (US, CN, SA, TR, DE, FR, GB, IN, PK, MX, BR, AE, KR, EG, JP); 2/6 (PH, ID).
- `economic:eurostat:house-prices:v1`: 3/31 (PL, DE, FR); 0/6 (none).

## Licence and access inventory

The repository source-attribution ledger marks IMF, Yahoo, BIS, ECB, FRED, EIA, Eurostat and most national food-price publishers **terms-review**: provider terms must be verified before redistribution. That is an unresolved licence record, not an open licence grant. This inventory does not clear a new scoring or redistribution use. Food sources expose publisher URLs in their registry; their observation availability does not establish reuse rights.

Recorded exceptions include Bank of Canada reuse with attribution, SSB CC BY 4.0 and New Zealand Commerce Commission CC BY 4.0. The Taiwan MOEA oil survey entry explicitly has an unconfirmed reuse licence. Host-level exceptions must not be generalized to unrelated products on the same host.

Existing IMF access supports an optional subscription header; FRED, EIA, e-Stat, retail search and some electricity paths use existing credentials. Reading their already-seeded keys introduces no new upstream subscription, but their access requirements must remain visible in the source decision. No new paid or key-gated source is proposed.

## Remaining producer verification

Retain the currency monthly bars already fetched by `seed-fx-yoy.mjs`. Derive the selected members from existing keys with observation dates and explicit fresh/absent states. Verify sufficient trailing history, peg/shared-currency behavior, CPI mirror selection, stale-member exclusion, unreadable-input preservation and the 25-country health threshold. Refresh the 37-country matrix when capturing U21 fixtures; this inventory is not a continuing coverage guarantee.
