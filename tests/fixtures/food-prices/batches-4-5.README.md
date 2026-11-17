# Food-price batches 4 and 5 fixtures

Captured from the official public endpoints on 2026-11-05. Collector endpoint
definitions are in `scripts/lib/food-prices-adapters/`; source identities and
attribution are in `shared/food-price-sources.json`.

- `fews-*.json`: bounded excerpts for one market per country, retaining source
  metadata, local and common units, monthly dates, and source organisations.
- `twmoa.json`: transaction excerpts including non-staples for exclusion checks.
- `geostat.json`: workbook cell values, retaining title, year/month headers, and
  food rows for the last three months.
- `cso.csv`: the latest month's rows, including non-food items to test exclusions.
- `statec.json`: the SDMX JSON response for annual June product prices.
- `csblv.json` and `makstat.json`: json-stat2 responses containing August and
  September 2026, preserving response dimension order and category indices.
- `foag.json`: three original observations per cube and their vocabulary labels.
- `pricecatcher.parquet`: the original November storage file as captured, including
  Brotli compression. `pricecatcher-items.csv` holds the 39 selected staple rows
  copied unchanged from the publisher's `lookup_item.csv` (fetched 2026-11-17).
  Each staple reports at 200 or more distinct premises on every fixture day; packaged
  rice, oil, sugar, flour, meat and most fruit appear only on irregular basket-survey
  days (2 November in this file) and are not selected.
- `mcba-*.zip`: original July 1 and November 4 XLS files repackaged from the
  publisher's November archives; other members, including nested RARs, omitted.
  The misplaced July report proves that archive names do not establish data dates.
- `batches-4-5-card.json`: controlled browser responses built through the real
  reader from local collector snapshots, limited to two products in two markets
  per source, except PriceCatcher. Its entry is the full 39-item response built by
  the collector and `buildFoodPriceSource` from the publisher's 2026-11 file as
  fetched on 2026-11-17 (16 November against 9 November), so the card is exercised
  with a full single-source table. These demonstrate rendering and interaction, not
  production data.

Tests construct malformed, future, changed-unit, and conflicting-quote cases from
these fixtures. No Redis snapshot or credential is included.
