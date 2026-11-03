---
title: "IMF WEO fiscal-year mapping lives in per-country METHODOLOGY_NOTES, returned only by single-country SDMX queries"
date: 2026-10-21
category: integration-issues
module: scripts/seed-national-debt.mjs
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - "National debt clock anchored every fiscal-year economy at December 31, so Egypt and Pakistan (June-end) and India (March-end) were off by months"
  - "A multi-country WEO SDMX probe (EGY+IND+USA) returned only SCALE, DECIMALS_DISPLAYED, OVERLAP, COUNTRY_UPDATE_DATE, PRECISION, DERIVATION_TYPE and SOURCE"
  - "Issue #9425 recorded that the feed had no fiscal-year metadata and called for a hand-built table"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - documentation
tags:
  - imf
  - sdmx
  - weo
  - fiscal-year
  - national-debt
  - methodology-notes
  - middleware-bundle
---

# IMF WEO fiscal-year mapping lives in per-country METHODOLOGY_NOTES

## Problem

IMF World Economic Outlook gross debt (`GGXWDG_NGDP`) for year Y is the stock at the end of that economy's reporting period. WEO Online Table F lists 32 economies whose government-finance data use a non-calendar reporting period. For 30 of them, WEO's year Y is a single fiscal year that does not end on December 31. The other two are Singapore, whose WEO calendar years blend two fiscal years, and Puerto Rico, a territory the debt seeder excludes. WEO also labels those fiscal years two different ways: some by the calendar year the fiscal year ends in, some by the year it starts in. The national debt clock needed both facts for each country. The WEO SDMX feed appeared not to carry them.

## Symptoms

- Every fiscal-year economy reached its IMF figure on December 31. That is six months late for Egypt and Pakistan. For India, with a start-year label, it was three months early.
- A three-country probe (`EGY+IND+USA`) with `attributes=all` returned only `SCALE`, `DECIMALS_DISPLAYED`, `OVERLAP`, `COUNTRY_UPDATE_DATE`, `PRECISION`, `DERIVATION_TYPE` and `SOURCE`.
- Issue #9425 recorded that the feed "has no fiscal-year metadata" and proposed a per-country table compiled by hand from WEO country notes.

## What Didn't Work

- **Concluding from a multi-country query.** Country-level attributes are dropped when the key covers more than one country, whether as a `+` list or `*`. The "no metadata" conclusion in #9425 came from exactly such a query.
- **Table F alone.** Online Table F (statistical appendix, page 13) gives the reporting months, such as July/June. It does not say which calendar year WEO assigns a fiscal year to. #9429 recorded this in the table's coverage note: "Table F month ranges alone do not establish the year label." That is why #9429 shipped only the two economies it could prove from other IMF documents.
- **`with { type: 'json' }` for the shared table.** The table is imported by `scripts/live-pages/national-debt.mjs`, which `middleware.ts` imports. Vercel's middleware bundler rejects import attributes; that broke the #9367 preview build. `tests/live-topic-pages.test.mts:423` guards the whole middleware import graph against them, so a JSON import there fails CI. Plain Node, however, requires the attribute for JSON imports.
- **Fetching the PDFs with curl.** imf.org returns an HTML bot page for the statistical appendix and staff reports. WebFetch saved the binary, which `pdftotext -layout` then extracted.

## Solution

Query the feed **one country at a time** with `attributes=all`:

```
https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.RES/WEO/+/<ISO3>.GGXWDG_NGDP.A?dimensionAtObservation=TIME_PERIOD&attributes=all&measures=all
```

The response then includes `METHODOLOGY_NOTES`, `START_END_MONTHS_OF_REPORTING_YEAR` and `LATEST_ACTUAL_ANNUAL_DATA`. The notes state the mapping directly:

| Note text | Meaning | `yearLabel` |
|---|---|---|
| `FY(t-1/t) = CY(t)` (Egypt, Pakistan, Nepal) | WEO year Y = fiscal year **ending** in Y | `end` |
| `FY(t/t+1) = CY(t)` (India, Botswana, Iran) | WEO year Y = fiscal year **starting** in Y | `start` |
| `SY(t/t+1)=CY(t)` (Afghanistan, solar year) | as above | `start` |
| `CY(t) = 0.25*FY(t-1/t) + 0.75*FY(t/t+1)` (Singapore) | a blend of two fiscal years | none; stays on the calendar fallback |

The notes reproduced both rows #9429 had verified by other means (EGY `end`, IND `start`). Some notes also give exact end days: Afghanistan and Iran March 20, Nepal July 15. Hong Kong SAR and Thailand have no mapping sentence. #9496 matched IMF staff-report figures to WEO columns for them: Country Report 25/15 for Hong Kong (start) and 25/45 for Thailand (end).

#9496 (closes #9425) stores the result in `scripts/shared/weo-fiscal-periods.mjs`. It maps those 30 economies, each row with its IMF citation. Singapore stays on the December 31 fallback because of its blended convention, and Puerto Rico is left out because the seeder excludes territories. The file is a plain ES module, so the middleware bundle and Node both load it without import attributes. `computeEntries` looks rows up at `scripts/seed-national-debt.mjs:92`, and the public explainer list is generated from the same table (`scripts/live-pages/national-debt.mjs:21`).

The same PR also fixed a follow-on bug that Codex review found. When a fiscal period has already closed, for example Bangladesh's FY2025/26 on June 30, the clock runs from the period end. It must accrue at the **next** period's projected deficit and GDP, not the closed year's (`scripts/seed-national-debt.mjs:100`, `:123`). On live October 2026 data this affected 23 economies, and some changed direction: Samoa and Tonga move from surplus to deficit, and Marshall Islands from deficit to surplus.

## Why This Works

WEO's SDMX data structure attaches country-specific documentation at the country level. The API returns those attributes only when the key resolves to a single country. Multi-country responses keep only attributes that are valid across the whole slice. The mapping sentence is the IMF's own statement of how each fiscal year is placed in a calendar column. Reading it is therefore authoritative, and avoids inferring the convention from month ranges or press transcripts.

## Prevention

- **Probe SDMX metadata with a single-country key** before concluding an attribute is absent. Repeat the probe for at least two countries whose conventions differ.
- **Re-verify the table at each WEO vintage.** Conventions have changed before: Fiji moved to August/July in 2016, Myanmar restored April/March from FY2021/22, and Mauritius returned to fiscal-year reporting. The table records `weoVintage`, and its coverage note says to re-check every row.
- **Tie each row to its own evidence in tests.** `tests/national-debt-seed.test.mjs:485` asserts that `yearLabel` matches the quoted mapping. `:494` asserts that `endMonth` matches the quoted reporting months. Mutating Pakistan's label or end month fails these tests.
- **Data imported both under `middleware.ts` and by plain Node scripts should be a JS module.** Bundled TypeScript can import JSON without attributes, and `middleware.ts` already imports `agent-request-policy.json` that way. Plain Node ESM requires `with { type: 'json' }`, though, and the middleware bundler rejects import attributes. The guard at `tests/live-topic-pages.test.mts:423` rejects the attributes, not JSON itself.
- **Once a period-anchored clock passes the period end, switch the accrual rate to the next period.** Test the deficit-to-surplus transition explicitly.

## Related

- `docs/solutions/integration-issues/imf-weo-release-dates-are-dataset-reference-metadata.md`: the same SDMX endpoint, where release dates are dataset-level reference metadata that `attributes=all` also returns.
- #9419 (current-year WEO selection), #9420 (year-end anchor), #9429 (Egypt and India), #9496 (all Table F economies and next-period accrual), #9425 (the issue).
