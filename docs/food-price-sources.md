# Official food prices and food-security context

The Food prices panel adds local weekly comparisons to the existing FAO global monthly index. It does not rank countries: baskets, markets, units and currencies differ.

## Source contracts

| Job suffix | Publisher | Coverage and value | Cadence |
| --- | --- | --- | --- |
| pihps | [Bank Indonesia PIHPS](https://www.bi.go.id/hargapangan) | Traditional-market national averages, one series per commodity and published unit; dated JSON columns | Daily |
| pbs | [Pakistan Bureau of Statistics SPI](https://www.pbs.gov.pk/price-statistics/) | Food items in the weekly city basket; city AVG columns and original package sizes from annex XLSX | Weekly |
| da | [Philippines Department of Agriculture](https://www.da.gov.ph/price-monitoring/) | Named market prevailing retail prices from the first three food-report pages; eggs per piece, other products per kg | Daily |
| cbsl | [Central Bank of Sri Lanka](https://www.cbsl.gov.lk/en/statistics/economic-indicators/price-report) | Today columns on page two, with separate retail/wholesale identities for Pettah, Dambulla and Narahenpita | Daily |
| sniim | [Mexico SNIIM](https://www.economia-sniim.gob.mx/nuevo/) | Frequent wholesale kg prices for first-grade bulb/red onions, jalapeño, saladette tomato and Alpha potato; destination and origin retained | Weekdays |
| giews | [FAO GIEWS country briefs](https://www.fao.org/giews/countrybrief/index.jsp) | All countries in the publisher catalog; report reference date and original brief link | Irregular context |
| onagri | [Tunisia ONAGRI](https://www.onagri.nat.tn/Marche-de-gros-bir-el-kasaa/fr/62) | Bir El Kassaa monthly wholesale prices; millimes/kg converted to TND/kg | Monthly context, usually delayed |
| tcb | [Trading Corporation of Bangladesh](https://tcb.gov.bd/pages/daily-rmps) | Dhaka retail low and high prices for about 55 food essentials from the daily workbook; no midpoint is derived | Daily, including weekends, with gaps |
| nabc | [Thailand NABC](https://www.nabc.go.th/commodity) | Office of Agricultural Economics weekly national farmgate averages for paddy, maize, cassava, eggs, hogs, oil palm and broilers; dated by week start | Weekly |
| nsckg | [Kyrgyzstan National Statistical Committee](https://stat.gov.kg/ru/daily-prices/) | National and 19 settlement average prices for 17 foods from the daily workbook | Daily |
| statkz | [Kazakhstan Bureau of National Statistics](https://stat.gov.kz/en/industries/economy/prices/spreadsheets/) | Socially important food prices in tenge per published unit for 20 cities and the surveyed-city average | Weekly (Wednesday reference date) |
| statuz | [Uzbekistan Statistics Agency](https://stat.uz/ru/ofitsialnaya-statistika/prices-and-indexes) | National average market and store prices for 37 foods (feed items excluded), CC BY 4.0 | Monthly context |
| maga | [Guatemala MAGA](https://precios.maga.gob.gt/diarios/diarios.html) | La Terminal wholesale prices in their published package units | Weekdays |
| ocpv | [Côte d'Ivoire OCPV](https://www.ocpv-ci.com/) | Regional average consumer prices (`Prix moy`) from the weekly PDF | Weekly |
| sima | [SIMA Niger](https://simaniger.net/publications/bulletins-sima?category=hebdo_cereales) | Bag prices for millet, sorghum, maize and imported rice in 77 markets plus the national average, from the weekly cereal bulletin | Weekly |
| mit | [Tanzania Ministry of Industry and Trade](https://www.viwanda.go.tz/documents/product-prices-domestic) | Low and high wholesale prices per 100 kg for 8 crops in about 31 markets | About three reports a week, often uploaded in batches |
| ucda | [Uganda Coffee Development Authority](https://ugandacoffee.go.ug/) | Farmgate coffee price ranges in UGX/kg and FOT export prices converted from US cents/lb to USD/lb | Business days |
| amman | [Greater Amman Municipality](https://ammancity.gov.jo/ar/market/prices.aspx) | Central Market most-common wholesale price for local produce; qirsh/kg converted to JOD/kg | Saturday to Thursday |

Sources added for #9892 run through per-source adapters in `scripts/lib/food-prices-adapters/`. Each adapter keeps the same publisher-host, size, page and budget limits, and may name extra file hosts in its registry entry. Publisher-specific rules:

- MAGA and UCDA keep no dated archive that the seeder can read for the prior week, and SIMA is polled one bulletin per run at the publisher's request. Their weekly changes come from the seeder's own 14-day history, so they appear after a week of successful runs, and a missed run leaves no baseline for that day.
- OCPV sometimes republishes the previous week's table under a new week. An identical table is not published as a new week.
- Amman cards list highest, most common and lowest prices. Rows that break that order are dropped with a warning; a widespread break fails the run as a layout change. Items without an English name are skipped.
- TCB serves an incomplete certificate chain. Its adapter adds the public Sectigo intermediate for that connection only; certificate verification stays on.
- Kyrgyzstan's workbook is a legacy `.xls` file larger than the download limit. The adapter reads the two newest sheets with byte-range requests.
- Uzbekistan data is CC BY 4.0 and must link to www.stat.uz. SIMA asks for the citation "SIMA Niger" and contact before commercial use or mass extraction. Amman's site states all rights reserved. Each registry entry records the requested attribution.

Report discovery follows publisher links. The PBS archive's annex date is authoritative, since post slugs can differ from the report date. PDF dates must agree with discovery dates. PDF layout checks, bounded response sizes and same-publisher HTTPS redirects prevent a changed or blocked document from becoming price data. Mexico requests the most recent completed weekday and the same date seven days earlier; missing holiday quotes stay absent. Paginated SNIIM responses fail rather than silently truncate.

## Storage and failure behavior

Run `node scripts/seed-food-prices-<suffix>.mjs`. Each script uses `loadEnvFile()` and `runSeed()` and writes its own `economic:food-prices:<suffix>:v1`, `seed-meta:economic:food-prices-<suffix>` and activation marker. The macro bundle schedules each source as an independent job. Railway watch patterns include the entrypoints, shared registry and parser/fetch/seed helpers. No new credential is required.

A successful run merges at most 14 calendar days of history with the new observations. A strict prior-cache read prevents an unavailable Redis read from erasing a baseline. `runSeed()` retains last-good data on collection or validation failure; it does not advance the successful fetch clock. Individual GIEWS failures retain that country's prior dated brief and fetch clock, with an explicit failed-fetch flag. An undated brief has unavailable status. Each source has separate fetch-age and report-age limits in `shared/food-price-sources.json`. Health probes seed metadata rather than downloading history, and becomes strict after the first successful publish.

`GetFoodPrices` reads every source cache in one pipeline and makes no source requests. The latest source report's prices are compared only against the exact same market, market type, item, origin, unit and currency seven calendar days earlier. A missing baseline has `wowAvailable: false`; its numeric default is never a displayed zero change. Dropped items are not carried forward into the latest report. Tunisia, Uzbekistan and GIEWS never receive weekly changes. Country briefs have independent freshness status. Any incomplete/stale result is marked non-cacheable.

## Verification and proof limits

The fixtures under `tests/fixtures/food-prices/` are compact extracts of official reports fetched on 2026-10-29. PDF fixtures preserve text positions. They cover PIHPS 2026-10-15 through 29, PBS 2026-10-22, DA/CBSL 2026-10-29, SNIIM 2026-10-21, ONAGRI July 2026, and the Bangladesh GIEWS brief of 2026-09-04.

Parser, seed-merge, transport-boundary, handler and DOM tests exercise date identity, unit identity, missing prices, exact-week baselines, partial context, freshness, source switching and safe text rendering. Live read-only collection on 2026-10-29 succeeded for each adapter; the GIEWS catalog had undated briefs (Malaysia and Saudi Arabia). This does not prove production Redis publication, Railway scheduling, deployment or production acceptance. Those require separately authorized operations and natural-run evidence.
