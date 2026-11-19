---
title: "NZ fuel prices: MBIE went behind a bot wall, and ExcelJS cannot read the Commerce Commission XLSX that replaced it"
module: seed-fuel-prices
date: 2026-11-01
category: integration-issues
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - "New Zealand missing from the Fuel Prices panel from about 2026-05-20; NZ listed as a tolerated failed source on every seed-fuel-prices run"
  - "mbie.govt.nz weekly-table.csv answers HTTP 200 text/html (~212 B Incapsula stub) from residential, datacenter and proxy IPs; data.govt.nz and stats.govt.nz show the same wall"
  - "ExcelJS on the Commerce Commission workbook throws \"Cannot read properties of undefined (reading 'sheets')\"; after stripping the x: prefix it throws \"reading 'company'\" from docProps"
root_cause: wrong_api
resolution_type: code_fix
related_components: [testing_framework]
tags: [fuel-prices, new-zealand, comcom, mbie, incapsula, bot-wall, xlsx, exceljs, fflate, spreadsheetml, namespace-prefix, plausibility-bounds]
---

# NZ fuel prices: MBIE went behind a bot wall, and ExcelJS cannot read the Commerce Commission XLSX that replaced it

## Problem

`scripts/seed-fuel-prices.mjs` read New Zealand pump prices from MBIE's weekly CSV. Around 2026-05-20, MBIE moved the whole domain behind an Incapsula JS challenge, and New Zealand dropped out of the panel (#4010). The replacement source publishes an XLSX that ExcelJS, the repo's spreadsheet library, cannot open.

## Symptoms

- Every run logged NZ as a failed source. It did not block the publish only because NZ is in `TOLERATED_FAILURES` (`scripts/seed-fuel-prices.mjs:812`).
- MBIE, data.govt.nz and stats.govt.nz all return the Incapsula or "Pardon Our Interruption" page, even to a laptop. A proxy cannot fix this: the block is a JS challenge, not an IP-reputation 403.
- ExcelJS fails on the Commerce Commission workbook with the errors listed in the frontmatter.

## What Didn't Work

- **Proxy-preferred fetch for MBIE.** That path was written for an IP-reputation 403. A JS challenge blocks every IP.
- **A headless challenge solver.** This was option 1 in #4010 and was rejected: we do not circumvent bot checks.
- **Gaspy.** It is reachable, but its prices are crowd-sourced, not official national averages.
- **Rewriting the workbook so ExcelJS accepts it.** The workbook is written by the OpenXML SDK, which prefixes every SpreadsheetML element (`<x:worksheet>`, `<x:sheetData>`). Stripping `x:` and repacking with JSZip got past the sheet error, but ExcelJS then failed on `docProps`. Each layer exposed another assumption.

## Solution

**Source:** the NZ Commerce Commission publishes daily national average retail prices (91, 95 and diesel, in NZ cents per litre) as a spreadsheet with each fortnightly fuel monitoring report. It is licensed CC BY 4.0, robots.txt allows `/assets`, and there is no wall. The file name contains the data date (`Fuel-price-monitoring-Data-to-27-October-2026.xlsx`), so `latestComComFuelDataUrl` (`scripts/seed-fuel-prices.mjs:529`) reads the reports page and picks the newest dated link.

**Reader:** `readXlsxFirstSheet` (`scripts/seed-fuel-prices.mjs:555`) unzips the workbook with `fflate` and reads the XML parts directly:

- every element regex tolerates an optional prefix, `<(?:\w+:)?row\b`;
- it resolves the first sheet through `xl/workbook.xml` and `xl/_rels/workbook.xml.rels`, falling back to `sheet1.xml`;
- it reads shared strings (concatenating rich-text runs), inline strings and `<v>` values;
- it places each cell by the column letters in its reference.

**Parser:** `parseNzComComFuel` (`scripts/seed-fuel-prices.mjs:599`):

- requires the exact header `DATE|FUEL_TYPE|REFINED_COSTS|RETAIL_PRICES_AVG`;
- picks the latest day where both the 91 and diesel prices are plausible (50–1000 c/L);
- returns null if that day is more than 35 days old;
- converts c/L to NZD/L.

Two review findings on PR #9995 shaped the final code:

```js
// 1. Bound the column index. r="AAAAAAAA2" decodes to ~8.35e9; padding the row
//    to that length exhausts the heap, and an OOM abort is not catchable.
if (col >= XLSX_MAX_COLUMNS) throw new Error(`cell column ${ref ?? col} is past the last Excel column`);

// 2. Choose the day by the same bound used to accept a price. A check of
//    `!= null` passed blanks (Number('') === 0) and NaN, and published NZ with
//    a null fuel instead of falling back to the previous day.
const plausible = cents => Number.isFinite(cents) && cents >= 50 && cents <= 1000;
const latest = days.find(iso => plausible(day(iso)['91']) && plausible(day(iso).Diesel));
```

## Why This Works

- **Bot wall:** the Commerce Commission is a different agency on a different host, and its publishing path has no challenge.
- **Spreadsheet:** ExcelJS's loader looks up unprefixed element names, so namespace-prefixed SpreadsheetML (valid OOXML) leaves its parsed model undefined. A reader that matches on local names accepts both the prefixed and the unprefixed form.
- **Fail-closed checks:** the header check, the age limit and the plausibility check turn a layout change, a stalled publication or a unit change into "NZ not published this run", which `TOLERATED_FAILURES` already handles. Without them, wrong numbers would be published.

## Prevention

- When a government source goes behind a JS challenge, look for the same figures from another official publisher, such as a regulator or statistics office, before considering a proxy. Check the licence and robots.txt, and record both in `shared/source-attribution-manifest.json`. Retire the old host with `node scripts/source-attribution.mjs --write --retire <host>`.
- Before choosing ExcelJS for a new XLSX source, run it on the real file. Workbooks written by the OpenXML SDK or by .NET tooling often use the `x:` prefix.
- Any index decoded from untrusted input that then sizes an allocation needs an upper bound (here, 16,384 columns).
- Select records using the same validity check that accepts their values. Treat `''` as missing before calling `Number()`.
- Tests in `tests/seed-fuel-prices.test.mjs`:
  - the real file as a fixture (`tests/fixtures/fuel-prices/comcom-nz-data-to-2026-10-27.xlsx`);
  - a synthetic workbook built with `fflate.zipSync` covering inline strings, rich-text shared strings, gaps and a non-default sheet path;
  - an out-of-range column reference;
  - blank, non-numeric and out-of-range newest prices.

**Verified:** in a production run on 2026-11-01 the seeder published 36 countries from all 8 sources. NZ showed 91 at 3.587 NZD/L and diesel at 3.222 NZD/L, observed 2026-10-27, and appeared in the Fuel Prices panel on energy.worldmonitor.app. The data is fortnightly, so an NZ date up to about two weeks old is normal.

Related: [gb-tesco-anti-bot-blocked-both-scrape-and-fallback-providers.md](gb-tesco-anti-bot-blocked-both-scrape-and-fallback-providers.md) covers another anti-bot block, where the fix was also to change the source rather than its configuration.
