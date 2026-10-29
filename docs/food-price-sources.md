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

Report discovery follows publisher links. The PBS archive's annex date is authoritative, since post slugs can differ from the report date. PDF dates must agree with discovery dates. PDF layout checks, bounded response sizes and same-publisher HTTPS redirects prevent a changed or blocked document from becoming price data. Mexico requests the most recent completed weekday and the same date seven days earlier; missing holiday quotes stay absent. Paginated SNIIM responses fail rather than silently truncate.

## Storage and failure behavior

Run `node scripts/seed-food-prices-<suffix>.mjs`. Each script uses `loadEnvFile()` and `runSeed()` and writes its own `economic:food-prices:<suffix>:v1`, `seed-meta:economic:food-prices-<suffix>` and activation marker. The macro bundle schedules the seven independent jobs. Railway watch patterns include the entrypoints, shared registry and parser/fetch/seed helpers. No new credential is required.

A successful run merges at most 14 calendar days of history with the new observations. A strict prior-cache read prevents an unavailable Redis read from erasing a baseline. `runSeed()` retains last-good data on collection or validation failure; it does not advance the successful fetch clock. Individual GIEWS failures retain that country's prior dated brief and fetch clock, with an explicit failed-fetch flag. An undated brief has unavailable status. Each source has separate fetch-age and report-age limits in `shared/food-price-sources.json`. Health probes seed metadata rather than downloading history, and becomes strict after the first successful publish.

`GetFoodPrices` reads the seven caches in one pipeline and makes no source requests. The latest source report's prices are compared only against the exact same market, market type, item, origin, unit and currency seven calendar days earlier. A missing baseline has `wowAvailable: false`; its numeric default is never a displayed zero change. Dropped items are not carried forward into the latest report. Tunisia and GIEWS never receive weekly changes. Country briefs have independent freshness status. Any incomplete/stale result is marked non-cacheable.

## Verification and proof limits

The fixtures under `tests/fixtures/food-prices/` are compact extracts of official reports fetched on 2026-10-29. PDF fixtures preserve text positions. They cover PIHPS 2026-10-15 through 29, PBS 2026-10-22, DA/CBSL 2026-10-29, SNIIM 2026-10-21, ONAGRI July 2026, and the Bangladesh GIEWS brief of 2026-09-04.

Parser, seed-merge, transport-boundary, handler and DOM tests exercise date identity, unit identity, missing prices, exact-week baselines, partial context, freshness, source switching and safe text rendering. Live read-only collection on 2026-10-29 succeeded for each adapter; the GIEWS catalog had undated briefs (Malaysia and Saudi Arabia). This does not prove production Redis publication, Railway scheduling, deployment or production acceptance. Those require separately authorized operations and natural-run evidence.
