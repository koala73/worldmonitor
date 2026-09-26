# Search Console snapshots

Dated output of `scripts/seo-gsc-collect.mjs`, which answers the questions the
coverage export cannot: which URLs Google declined, why, and which families earn
impressions per indexed page.

## Files

- `<date>.json` — the snapshot. Inventory by family, response kind and host; the
  inspected sample and its index states; performance per window and family;
  flagged disagreements; sampling notes.
- `<date>.md` — the deterministic human summary generated from that snapshot.

No snapshot is committed yet. The owner prerequisites in issue #8606 were
completed and verified against the live API on 2026-09-25, so the first file
arrives through the weekly workflow's review PR.

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
feed into it, not a second one.

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

**Search Analytics URLs outside every family are listed, not dropped.** A
sitemap URL with no family stops the run, because the sitemaps are ours to fix.
Search Analytics also reports URLs we never declared: legacy paths such as
`/zh/…` and `/download`, and other hosts in the Domain property such as
`status.`. On 2026-09-25 that was 30 of 1,056 page rows in the 28-day window.
They stay in the window totals and appear by name under `unmapped`, so each
recurring one can be given a family.

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
