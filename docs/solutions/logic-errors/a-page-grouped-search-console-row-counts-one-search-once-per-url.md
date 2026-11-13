---
module: seo-gsc-collect
date: 2026-11-10
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "A query whose distinct searches are under the 20-impression floor is still committed to the public snapshot"
  - "Summed impressions for one query exceed what the by-property chart reports for it"
root_cause: logic_error
resolution_type: code_fix
related_components: [documentation]
tags: [search-console, privacy-floor, page-dimension, impressions, public-repo]
---

# A page-grouped Search Console row counts one search once per URL

## Problem

`performance.queryPages` in the weekly snapshot lists non-brand queries with the pages Google showed for each. This repository is public, so a query's text is committed only when it has at least 20 impressions. The first version applied that floor to the query's total, summed over its page rows.

## Root cause

When Search Console groups rows by page, it counts one search once for every URL it shows. That includes fragment and query-string variants of a single page, such as `/tools/` and `/tools/#faq`. Summing those rows counts the same search several times. In one case, 15 + 10 impressions on two variants of one page reached the floor, although the query may have had only 15 distinct searches.

## Solution

`buildQueryPages` in `scripts/seo-gsc-collect.mjs` keeps the largest single raw URL row for each query and applies `MIN_LISTED_QUERY_IMPRESSIONS` to that row. A single row counts distinct searches. The summed page impressions are still used to rank pages, but not for the floor. The method field is named `minSingleUrlImpressions`, so the snapshot states which rule it used. The `tests/seo-gsc-collector.test.mjs` test "publishes a query only when one URL alone reaches the floor" pins the behavior. 15 + 10 across variants does not publish. 20 + 4 publishes as one page with 24 impressions. Shipped in #10366.

## Prevention

Any threshold that stands for "this many people searched" must read a row that counts each search once. That means the by-property total, or one URL row. A sum over the page dimension never qualifies. The same rule already applies to site totals (`siteTotals` versus `totalsBasis: sum-of-page-rows`; see `docs/research/seo-ai-visibility/gsc/README.md`).
