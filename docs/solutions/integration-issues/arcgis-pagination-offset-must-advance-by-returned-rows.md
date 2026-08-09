---
module: seeders
date: 2026-07-28
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Multi-page ArcGIS FeatureServer query returns rows with a contiguous block silently missing (e.g. exactly 1,000 consecutive days absent from every chokepoint's series)"
  - "Row count comes back suspiciously identical across unrelated entities queried with the same WHERE shape"
  - "Missing block starts exactly at row index equal to the server's maxRecordCount and spans (requested pageSize - maxRecordCount) rows"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - background_job
tags:
  - arcgis
  - portwatch
  - pagination
  - resultoffset
  - exceededtransferlimit
  - data-loss
---

# ArcGIS pagination: advance resultOffset by rows returned, never by the requested page size

## Problem

Paginated queries against an ArcGIS FeatureServer (`resultOffset` /
`resultRecordCount` / `exceededTransferLimit`) silently skipped a contiguous
block of rows whenever the query spanned more than one server page. Found while
freezing the IMF PortWatch snapshot for the /research/ report pilot (PR #5721):
every chokepoint returned exactly 1,757 rows for a 2,757-day window, with the
same 1,000-day hole (2021-09-27 → 2024-06-22) in all four series.

## Symptoms

- All entities returned identical row counts — a deterministic server behavior,
  not per-entity data gaps.
- The missing block was exactly 1,000 rows starting at row 1,000: the layer's
  server-side `maxRecordCount` (1,000) is lower than the requested
  `resultRecordCount` (2,000).

## What Didn't Work

Trusting `exceededTransferLimit` alone. The server caps each page at its own
`maxRecordCount` regardless of the requested page size, sets
`exceededTransferLimit: true`, and the client loop advanced
`offset += PAGE_SIZE` (2,000) — skipping rows 1,000–1,999 before requesting the
next page. Nothing errors; the response is well-formed; the hole is invisible
unless row counts are checked against the expected calendar span.

## Solution

Advance the offset by the number of rows the server actually returned:

```js
// before (data loss on any multi-page query)
if (!body.exceededTransferLimit) break;
offset += PAGE_SIZE;

// after (scripts/seed-portwatch.mjs fetchAllPages, and the snapshot producer)
if (!body.exceededTransferLimit || !body.features?.length) break;
offset += body.features.length;
```

Fixed in both `scripts/seed-portwatch.mjs` and
`scripts/build-chokepoint-transit-snapshot.mjs` (PR #5721). The seeder had this
latent since inception — its 180-day window fits in one server page, so it
never paginated; any widening of `HISTORY_DAYS` past ~1,000 rows would have
started losing data silently.

## Why This Works

`resultOffset` is a row index into the full result set, so the only correct
increment is the count of rows consumed. `maxRecordCount` is a server-side
layer property the client does not control and should not assume; requesting a
larger `resultRecordCount` is legal but the server clamps it.

## Prevention

- Regression test drives both fetch loops through a mocked two-page response
  (page 1: 1,000 rows + `exceededTransferLimit: true`; page 2: 757 rows) and
  asserts the second request's `resultOffset` equals the rows actually returned
  (`tests/research-report-corpus.test.mjs`, "ArcGIS pagination advances by
  returned rows").
- When freezing time-series snapshots, validate completeness against the
  calendar: observed days + enumerated missing days must exactly tile the
  observation window (same test file, missing-days tiling assertions). That
  check is what surfaced this bug.
- Identical row counts across unrelated entities is a pagination-artifact
  smell, not a coincidence — investigate before trusting the data.
