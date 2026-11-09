# Search Console snapshots

Dated output of `scripts/seo-gsc-collect.mjs`, which answers the questions the
coverage export cannot: which URLs Google declined, why, and which families earn
impressions per indexed page.

## Files

- `<date>.json` — the snapshot. Inventory by family, response kind and host; the
  inspected sample and its index states; performance per window and family;
  flagged disagreements; sampling notes.
- `<date>.md` — the deterministic human summary generated from that snapshot.

The first snapshot is `2026-09-25`. Later ones arrive through the weekly
workflow's review PR.

## Running it

Against the recorded fixtures, which needs no credential:

```sh
node scripts/seo-gsc-collect.mjs --fixtures tests/fixtures/gsc/
```

Against the live property, once the owner has created the service account,
granted it Restricted access on the property, and stored the values in
`.env.local`:

```sh
node scripts/seo-gsc-collect.mjs --live
```

`GSC_SERVICE_ACCOUNT_JSON` holds the base64 service-account key.
`GSC_PROPERTY` holds the property identifier in whichever form Search Console
assigns it, a Domain property or a URL prefix. Both are read through
`loadEnvFile()` and neither is ever printed or written. The identifier format
belongs in a comment on issue #8606; the value belongs nowhere in this
repository.

The domain-property prefix is deliberately not spelled out in this directory.
`tests/seo-gsc-collector.test.mjs` greps every committed file here for it, and a
grep that has to carve out documentation is a grep that stops catching leaks.

Add `--search-export <path>` to also emit the per-family rows in the shape
`scripts/seo-ai-visibility-collector.mjs` accepts under
`sources.googleSearchConsole`. The scorecard stays the single report; this is a
feed into it, not a second one. Its window totals are the by-property site
totals, never the page-row sum. The weekly workflow does not need this flag:
`scripts/seo-weekly-baseline.mjs` maps the committed snapshot through the same
`toScorecardSearchExport`, adding the reviewed query rows.

## Reading it

Three habits are built into the output because the 2026-09-24 hand-parse showed
a report without them misleads.

**Indexability is reported for HTML pages on their own.** Most of the
"Crawled, currently not indexed" population that day was `/docs/_next/*` render
assets already serving `noindex`. A headline that counts them moves when the
docs build renames a hash-versioned chunk rather than when a page we own
changes. Every URL therefore carries a `kind` (`html`, `data`, `markdown-twin`,
`subresource`, `feed`) alongside its family, and the headline counts only the
cell that warrants attention: crawled, declined, serving no `noindex`, and still
answering as HTML.

**Google state and the live response are both recorded.** Most of the reported
404s that day already redirected. `coverageState` sits next to a live probe
status, and disagreement appears under `liveStateDisagreements` rather than
being silently resolved in either direction.

**Every URL carries its host.** The apex and the variant dashboards share the
Domain property with `www`, so a per-family denominator that ignores the host is
wrong rather than merely coarse.

**Site totals are counted by property; family rows are summed over pages.**
Search Console counts a search once per URL it shows when rows are grouped by
page: one brand search that shows the homepage, three sitelinks and `/pro`
counts five impressions. The performance chart groups by property and counts
it once. On 2026-09-25 the page-row sum was 800,092 impressions for 28 days,
roughly twice what the chart shows. `siteTotals` therefore asks Google for the
by-property number directly, and the window `totals` are labelled
`totalsBasis: sum-of-page-rows`. Compare family rows with each other, and
compare the site with the chart, never one with the other.

**Brand and non-brand are split with one pattern.** `BRAND_QUERY_PATTERN` in
the collector names World Monitor and its misspellings, including the
`worldmoniter` family Bing reports. Google applies
it as a query filter; the snapshot applies the same source to its own top
queries. A query filter drops anonymized queries, so the site table reports
them as the remainder (`anonymized`) instead of losing them, and per-family
`nonBrandImpressions` counts only non-brand queries Google attributes. If the
quota cuts that view short, the family values are `null` with the truncation
as `nonBrandReason`, never a smaller number. The
non-brand numbers are the ones the corpus pages exist to move.

**Non-brand queries are listed with their page and desktop share.**
`performance.nonBrandQueries` holds up to 500 non-brand queries from the first
window, each with the page that shows most for it, its desktop share, and
`likelyAutomated`. The flag needs zero clicks, at least 200 impressions and at
least 90% desktop. In October 2026 "kerch strait" had 19,585 impressions at 98%
desktop and no clicks, while "pizza index" sat at 20% desktop. The flag is an
inference, because Search Console cannot say who searched. It sets a query
aside when choosing what to improve and does not change the non-brand totals,
which stay comparable from week to week. The summary reports the total with
and without flagged queries. This repository is public, so a query needs 20
impressions before its text joins this list. The `topQueries` rows take the 20
largest queries overall and have no such floor.

**Reviewed queries are looked up directly.** `reviewedQueries` holds one
`equals` lookup per query in `query-set.json` and per window, 50 small requests
through the same retrying transport, plus the set's `querySetId` and
`querySetDigest`. A live probe on 2026-11-09 found that `equals` ignores case
but not spacing, so the expression is the reviewed text trimmed, with inner
whitespace collapsed, and lowercased. The request groups by query because a
request with no dimension answers an unknown query with a zero row, while
grouped it answers with no row. Each lookup is `reported`, `not-reported` (no
row: under Google's privacy threshold or no impressions, not a zero) or
`unavailable` (the request failed, with the reason). A daily-quota 429 stops the
remaining lookups and marks them `unavailable`. The mapping into the scorecard
refuses lookups made for a different query set. A snapshot from before these
lookups maps to no query rows, because no reviewed query ever reached the
top-20 list that used to feed them.

**The daily series is by property.** `performance.daily` holds one row per date
over the widest window, all queries and non-brand. The summary sums it into
seven-day periods ending on the latest date (rolling, not Monday-to-Sunday
weeks). Google omits a date with no data rather than returning zero.

**Search Analytics URLs outside every family are listed, not dropped.** A
sitemap URL with no family stops the run, because the sitemaps are ours to fix.
Search Analytics also reports URLs we never declared: legacy paths such as
`/zh/…` and `/download`, and other hosts in the Domain property such as
`status.`. On 2026-09-25 that was 30 of 1,056 page rows in the 28-day window.
They stay in the window totals and appear by name under `unmapped`, so each
recurring one can be given a family.

**A brand-only unmapped URL at position 1 is likely a sitelink, not a page
that ranks.** The snapshot cannot show this on its own. Its `topQueries` cover
the whole window, not one URL, and it holds no inspection result for an
undeclared URL. The 2026-09-25 snapshot recorded `/zh/map-engine` with 9,486
impressions at position 1.18. A separate check on 2026-09-29 ran URL
Inspection and Search Analytics filtered to that page, by query and by week
([results on #8700](https://github.com/koala73/worldmonitor/issues/8700#issuecomment-5886812477)).
It found the following:

- Every impression came from a brand query such as "world monitor", at
  position 1.0 to 1.2. That is the same slot as the homepage and its other
  sitelinks.
- Google's canonical for the URL is its 308 destination,
  `/docs/zh/map-engine`.
- The row began the week of 2026-09-06 and fell to 153 impressions by the
  week of 2026-09-20.
- `/'to` followed the same pattern.

The unprefixed path comes from Mintlify's server-rendered navigation data. Our
`<a href>` and `hreflang` links carry `/docs`. Before chasing a row like this,
rerun that page-filtered split.

## Page indexing report totals

The Search Console Page indexing report ("Page with redirect", "Not found
(404)", "Crawled, currently not indexed") has no API, and its totals are not
tracked. Every number here comes from the API. URL Inspection covers each
sitemap URL individually. URLs outside the sitemap appear only through
performance rows: those with a known family count toward that family's numbers,
and only URLs with no matching family are listed under "URLs outside every
family".

## Run time and failures

An inspection call took about 6.6 s on 2026-09-25, so the collector keeps five
in flight (`--concurrency`, at most 10). That stays far under the 600-per-minute
quota and keeps the live probes gentle on the docs host. Search Analytics runs
first, so a permission failure stops the run before any inspection quota is
spent. Every request has a deadline. A 5xx, a timeout or a per-minute 429 is
retried up to four times. A daily-quota 429 stops inspecting and marks the
snapshot partial, and an inspection that still fails is recorded under
`inspectionErrors` rather than ending the run.

## Sampling

`urlInspection` is capped by quota, and Google caps a coverage example export at
its own row limit with unspecified ordering. Those rows are not a random sample.
Every ratio in the snapshot carries the denominator it was measured over and an
`extrapolated` field that is always false: a share measured on capped rows is
never multiplied up to a reported total. `samplingNotes` says, per export,
whether the rows seen match the reported total.

## Secrets

The property identifier stays `null` in committed output, matching the rule in
the parent README. The collector picks named fields out of each API response
rather than copying payloads, because the inspection result carries a console
deep link that embeds the property identifier. The writer then refuses to emit a
file containing a credential marker or the configured property string.

`tests/seo-gsc-collector.test.mjs` greps every file in this directory for those
markers, and the recorded fixture deliberately contains the deep link so the
grep has something to catch. That is why neither marker is written out here in
full.
