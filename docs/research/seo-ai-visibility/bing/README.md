# Bing Webmaster snapshots

Dated output of `scripts/seo-bing-collect.mjs`, collected weekly next to the
[Search Console snapshots](../gsc/README.md) by the same workflow and review PR
(#10024).

## Files

- `<date>.json` is the snapshot. It has one section per Bing API method
  (`traffic`, `queries`, `pages`, `crawl`) plus `aiPerformance`. Each section
  carries its own `availability` (`available`, `partial` or `unavailable`) and a
  `reason`.
- `<date>.md` is the deterministic human summary generated from that snapshot.

## Running it

Against the recorded fixtures, which needs no credential:

```sh
node scripts/seo-bing-collect.mjs --fixtures tests/fixtures/bing/
```

Against the live API, with `BING_WEBMASTER_API_KEY` in `.env.local` (Bing
Webmaster Tools, Settings, API access):

```sh
node scripts/seo-bing-collect.mjs --live --stdout
```

The key is read through `loadEnvFile()` and never printed. The workflow reads it
from the Actions secret of the same name and skips the Bing step with a notice
when the secret is absent. A Bing failure never blocks the Search Console
snapshot.

## Reading it

**Totals come only from `traffic`.** `GetRankAndTrafficStats` returns one
complete row per day. The 28-day and 90-day windows end on the latest date it
reports, and the seven-day trend is summed from the same rows. A day Bing did
not report makes the section `partial` and is counted as nothing, not
estimated.

**Query and page sums are not totals.** `GetQueryStats` and `GetPageStats`
return weekly buckets dated on the Friday that ends each week, with at most 100
rows per bucket. Every sum over them is labelled `top-100-per-week`, and those
sections are always `partial`. `weeksAtRowCap` says how many buckets hit the
cap. A bucket counts toward a window when its Friday falls inside the window.
On 2026-11-02 the page rows of a week covered 85-90% of that week's daily
impressions with only about 35 rows, so an uncapped week is not complete either.

**Brand and non-brand use the Search Console pattern.** `BRAND_QUERY_PATTERN`
in `scripts/seo-gsc-collect.mjs` classifies each query row, so the two
collectors never disagree on what counts as brand.

**Click position is null.** Bing writes `-1` when it has no position, and on
2026-11-02 it did so on every query and page row. The snapshot records that as
`null`, and averages weight only the positions Bing did report.

**Pages map to families with `classifyUrl`.** A URL outside every family stays
in the window sums and is listed under `unmapped` with the reason, the same as
in the Search Console snapshot. URLs are written without their scheme.

**Crawl and index state is daily.** `crawl.latest` is the newest
`GetCrawlStats` row, and `crawl.change` is its difference from the row 28 days
earlier. Without that earlier row the change is `null` and the section is
`partial`.

**AI Performance is always unavailable.** Bing Webmaster Tools shows AI
citations and grounding queries in its UI only. The Webmaster API has no method
for them (checked against the API reference and by probing, 2026-11-02). The
section says so instead of reporting zero. Scraping the UI is out of scope.

## Secrets

The snapshot picks named fields from each response. The writer refuses a file
that contains the API key, the verified site URL in raw or encoded form, a
request query string carrying the key, or the type and date markers that only a
raw Bing payload contains. `tests/seo-bing-collector.test.mjs` runs every file in
this directory through the same check.
