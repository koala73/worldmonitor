---
title: "IMF WEO PUBLICATION_DATE and UPDATE_DATE are dataset-level reference metadata; attributes=all returns them with the series attributes"
date: 2026-10-18
category: integration-issues
module: scripts/_seed-utils.mjs
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - 'Country brief IMF WEO indicator rows always rendered "IMF release not supplied"'
  - "imfSdmxFetchIndicator requested attributes=dsd and returned only numbers, so no release date reached the seeded payload"
  - "attributes=msd returns the dates but drops series-level DSD attributes"
  - "/metadata/structure/dataflow/IMF.RES/WEO/9.0.0 returns empty metadataSets"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - service_object
tags:
  - imf
  - sdmx
  - weo
  - publication-date
  - update-date
  - seed-utils
  - bootstrap-boundary
---

# IMF WEO release dates are reference metadata, not DSD attributes

## Problem

Economic-indicator rows built from IMF WEO data labelled every value "IMF release not supplied". The seeded payloads had no publication or update date. The shared SDMX helper requested `attributes=dsd`, and the WEO data structure does not carry release dates. The fix shipped in #9314 (merged 2026-10-18) for issue #9307.

## Symptoms

- Every IMF WEO source line read `IMF WEO · Year N · IMF release not supplied`, even when IMF published the dates.
- `imfSdmxFetchIndicator` returned values only. Its callers had no way to get a release date.
- On 2026-10-18 a `attributes=dsd` response for `IMF.RES:WEO(9.0.0)` had series attributes but no `PUBLICATION_DATE` or `UPDATE_DATE`.

## What Didn't Work

- **`attributes=msd`.** It returns the dates but sets `series.attributes` to null, so the series-level DSD attributes are lost.
- **A separate metadata request.** `/metadata/structure/dataflow/IMF.RES/WEO/9.0.0` returned empty `metadataSets` on 2026-10-18. Even with content, a second request does not describe the response the observations came from.
- **Changing the return type of `imfSdmxFetchIndicator` for all six callers.** This would have churned the national-debt and fiscal-space test stubs for no gain. A new sibling helper does the job, and the old helper delegates to it.
- **Inferring a WEO edition from the dates.** The dates do not name an edition (see Why This Works).
- **Pitfalls hit while writing the tests:**
  - A named ESM import of an export that does not exist yet makes the whole test file fail at link time. That is a red test for the wrong reason. The red-first suite uses a namespace import instead (`import * as seedUtils`, `tests/seed-utils-imf-release.test.mjs:5`).
  - V8 `Date.parse('2026-02-30')` succeeds. Date validation needs a `Date.UTC` calendar round-trip.
  - One mutation, replacing only the last `&&` term of the round-trip check, survived. The month comparison still caught Feb 30. Choose mutations that remove a check the test actually depends on.
  - The browser parser was at first more lenient than the seeder's and accepted `2026-13-40`. Review caught it. Both now use the same regex and round-trip.

## Solution

`imfSdmxFetchIndicatorWithRelease` (`scripts/_seed-utils.mjs:1783`) requests `attributes=all&measures=all`. It reads the structure the dataset names, not structure 0, and decodes the two dates by attribute ID (`scripts/_seed-utils.mjs:1806-1811`):

```js
const ds = json?.data?.dataSets?.[0];
const struct = json?.data?.structures?.[Number.isInteger(ds?.structure) ? ds.structure : 0];
const release = {
  publishedAt: imfDatasetDate(struct, ds, 'PUBLICATION_DATE'),
  updatedAt: imfDatasetDate(struct, ds, 'UPDATE_DATE'),
};
```

`imfSdmxFetchIndicator` (`scripts/_seed-utils.mjs:1842-1844`) now returns `.values` from the new helper, so its other callers see the same contract as before.

`imfDatasetDate` (`scripts/_seed-utils.mjs:1848`) looks up the descriptor by ID, and returns null if the ID is missing or appears more than once. It unwraps a one-element array, resolves an integer code through the descriptor's `values`, and rejects anything that is not a string. The value must match `IMF_RELEASE_DATE_RE` (`:1846`) and survive a calendar round-trip:

```js
const day = new Date(Date.UTC(y, m - 1, d));
return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d ? value : null;
```

The seeders store one release per displayed metric, keyed by the same names as `periods`:

- macro: `releases` for inflation, primary balance, expenditure and revenue (`scripts/seed-imf-macro.mjs:110-116`)
- growth: real GDP growth and GDP per capita (`scripts/seed-imf-growth.mjs:149-154`)
- labor: unemployment (`scripts/seed-imf-labor.mjs:93`)

External has no attributed metric.

In the browser, `selectImfCountryBundle` (`src/services/imf-country-data.ts:231`) parses `releases` at the bootstrap boundary. `releaseDate` (`:212`) applies the same regex and round-trip, so malformed values become null. `releaseText` (`:247`) renders one of four forms:

- `IMF published D`
- `IMF published D, updated U`, only when U differs from D
- `IMF updated U, publication date not supplied`
- `IMF release not supplied`

## Why This Works

All findings below were observed against `https://api.imf.org/external/sdmx/3.0` on 2026-10-18.

- **Where the dates live.** `PUBLICATION_DATE` and `UPDATE_DATE` are not in `IMF.RES:DSD_WEO(9.0.0)`. They are attributes of the reference-metadata structure `IMF.RES:MSD_WEO_METADATA_EXTERNAL(2.0.0)`, with concepts `IMF:CS_MASTER.PUBLICATION_DATE` and `UPDATE_DATE` (DateTime). The concept text defines the publication date as when the data was "formally issued". It also says "data may have minor updates throughout the year".
- **What each `attributes` mode returns.**
  - `dsd`: series attributes, no dates.
  - `msd`: dates, but `series.attributes` is null.
  - `all`: both. This is the only mode that keeps both.
- **How the dates are encoded.**
  - `structures[ds.structure].attributes.dataSet` is a list of descriptors, 18 in the capture. It lines up by index with `dataSets[0].attributes`. In the capture, `PUBLICATION_DATE` was at index 9 and `UPDATE_DATE` at index 10. Lookup is by ID because those positions are not guaranteed.
  - Dates come as one-element string arrays.
  - Coded attributes such as `PUBLISHER` are integer indexes into the descriptor's `values`.
  - Absent values are null.
  - Localized fields are arrays of `{en: ...}`, which the parser rejects as dates.
- **The dates do not name an edition.**
  - Live `WEO(9.0.0)` had published = updated = `2026-10-13T02:00:00Z`.
  - Separate edition dataflows exist. `IMF.RES:WEO_2025_OCT_VINTAGE(1.0.0)` has PUBLICATION_DATE `2025-10-14T13:00Z` and UPDATE_DATE `2025-11-19T21:00Z`, which is a post-release revision. `WEO_2026_APR_VINTAGE(1.0.0)` has `2026-04-14` and `2026-04-15`.
  - The SYSTEM annotations `VINTAGE` and `REF_PERIOD` on those flows match the publication date. No official rule binds them, though.
  - No `WEO_2026_OCT_VINTAGE` existed yet.
  - So the UI shows dates and never an edition label.
- **`COUNTRY_UPDATE_DATE` is not a release date.** It is a series-level DSD attribute in free-text M/D/YYYY, one per country and indicator.
- **The values did not change.**
  - For 7 indicators (113 to 208 countries each), the new helper's values were identical to the `attributes=dsd` values.
  - The cost is response size: about 2x, from 5.5 KB to 11.8 KB for a single series.

## Prevention

- **Rules for any IMF SDMX consumer that needs provenance:**
  - Request `attributes=all`.
  - Decode dataset attributes by ID, through the structure the dataset names.
  - Treat absent, duplicated, malformed or non-calendar values as unknown.
  - Keep publication, update and retrieval (`seededAt`/`fetchedAt`) as separate fields.
  - Use the `WEO_*_VINTAGE` flows when a named edition is required. These flows can receive revisions, so save the response used when results must be repeatable.
- **Validate dates with a regex plus a `Date.UTC` round-trip.** Use the same rule in the seeder and in the browser parser.
- **Tests that pin this behavior:**
  - `tests/seed-utils-imf-release.test.mjs` runs against a real capture, `tests/fixtures/imf-weo/ngdpd-usa-attributes-all-2026-10-18.json`:
    - The request uses `attributes=all` (`:44`).
    - The real dates come back with unchanged values (`:53`).
    - Lookup still works after the descriptors are reordered (`:66`).
    - The structure the dataset names is used, not structure 0 (`:75`).
    - Non-calendar values such as `2026-02-30T00:00:00Z`, `2026-10-13T25:00:00Z`, `13/10/2026`, `[{en:...}]` and `true` give unknown (`:98`).
    - Duplicate IDs and multi-element arrays give unknown (`:105`).
    - Direct, single-element and coded values are all accepted (`:114`).
    - A code index with no matching value gives unknown (`:122`).
    - Dates never come from a second dataset (`:127`).
  - `tests/seed-imf-releases.test.mjs` bundles each seeder with esbuild against a stub `_seed-utils`. Each indicator gets a distinct release, which proves each metric stores its own indicator's release (`:33`, `:45`, `:55`).
  - `tests/imf-country-data.test.mts:46` checks that each metric shows its own theme's release without naming an edition. `:69-72` checks that missing or malformed bootstrap releases, including `2026-13-40` and `2026-02-30T00:00:00Z`, render `IMF release not supplied`.
- **For red-first tests of a new export, use a namespace import.** The file then fails on the assertion, not at module link time.

## Related Issues

- Issue #9307; fixed by #9314 (merged 2026-10-18).
