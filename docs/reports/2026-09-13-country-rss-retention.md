# Country reporting after the RSS entry cap: 2026-09-13

Related: [issue #7748](https://github.com/koala73/worldmonitor/issues/7748). Follows the [regional feed expansion](2026-09-13-curated-country-coverage.md) and [country RSS recovery](2026-09-13-country-rss-recovery.md).

## Finding and change

The country reader added in PR #8095 can recover articles excluded by dashboard category caps. Its input still loses reporting earlier: the RSS parser keeps only the first five entries from each fetched body. A country article at entry six never reaches that cache reader.

The full-variant parser now retains lightweight headline records from entries six through twenty in the same parsed-feed cache. Country recovery combines them with the original first-five items. Extra records contain only source identity, title, article URL, publication time and origin-publisher provenance. They do not run dashboard classification or story enrichment. Other variants still parse five entries.

The dashboard keeps its first-five selection, date-drop counters, feed-cap counters and category caps. Country selection keeps the existing freshness limit, future-date tolerance, HTTPS article checks, country matcher, publisher-family selection and URL revocations. A single publisher still cannot produce a brief. The public RPC schema and frozen snapshot format are unchanged.

The shared RSS key advances from `rss:feed:v9` to `rss:feed:v10` so existing five-entry caches cannot delay the change. Missing caches remain visible as partial or unavailable until normal acquisition warms them. Empty and failed fetches keep their existing short TTL.

## Same-response public-feed replay

Eight already-registered public feeds returned HTTP 200 during the read at approximately **2026-09-13 17:17 UTC**: Guardian Africa, Caribbean and Pacific; France 24 Africa and Asia Pacific; Africanews; RFI Afrique; and BBC Africa. No new source was added. The raw feed bodies were kept locally for a before/after replay.

The initial title-and-date scan found 17 countries in the first five entries and 30 in the first twenty. That scan did not apply all article acceptance rules. Replaying those same responses through the actual parser and country reader at **17:24 UTC** gives the accepted result:

| Measure | First five entries | Through entry twenty |
|---|---:|---:|
| Countries with accepted headlines | 15 | 22 |
| Configured feeds represented in the replay | 8 of 245 | 8 of 245 |
| Cache availability state | partial | partial |

The additional countries are Hong Kong, India, North Korea, the Philippines, Russia, Ukraine and South Africa. North Korea also appears in the September 9 register of countries without curated reporting. The other six were covered in that older snapshot; their recovery in this sample is not a reduction of the original 123-country gap.

This replay used a controlled empty revocation set. It proves selection from the sampled public responses, not production revocation state, whole-catalog coverage, successful brief generation or publication. The added cache data was 4,153–5,151 bytes per sampled feed. Retention is bounded by the first twenty entry positions; later entries, missing publishers and publisher cadence remain acquisition limits.

## Verification

The initial registered-RPC regressions returned no Cameroon or Niger headlines from entries six and twenty. They pass after the change, while entry twenty-one remains excluded. The same test exercises a cold publisher fetch, Redis cache write, warm cache read, registered RPC and country grounding with controlled HTTP responses. It confirms one publisher fetch and unchanged dashboard items and counters.

Further coverage checks stale, future, undated, revoked, invalid-URL and wrong-country records beyond entry five; Atom provenance; an untitled first-five window; missing caches; revocation outages; publisher-family selection; and the existing freeze integration. The original date, description, provenance, digest-coverage and snapshot suites are retained.

## Production acceptance

The PR owner should inspect normal acquisition and the first scheduled snapshot within 24 hours after authorized deployment. Check that v10 caches contain the bounded country records, `list-country-headlines` reports actual cache availability, and `coverage.developmentsCuratedFeeds` records recovery. Compare `briefEligibleCount`, `briefCountryCount`, `briefMatchedCount`, capture errors and dated source links with the previous snapshot.

Investigate missing v10 caches, repeated cache read failures, increased digest timeout or latency, incorrect publisher provenance, or zero recovery where current RSS bodies contain accepted later entries. Revert the retention and reader changes if they cause a digest regression or publish incorrect provenance. A missing fresh snapshot blocks production acceptance. Issue #7748 remains open for the remaining acquisition gap.

No production cache, snapshot or generated brief was written during this work. No merge or deployment was performed.
