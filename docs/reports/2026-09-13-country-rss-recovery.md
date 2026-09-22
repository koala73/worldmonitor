# Country reporting before dashboard caps: 2026-09-13

Related: [issue #7748](https://github.com/koala73/worldmonitor/issues/7748), following the [curated-feed expansion audit](2026-09-13-curated-country-coverage.md).

## Finding

The remaining gap includes reporting that WorldMonitor already acquires. The full digest ranks each category and keeps 20 items. Country snapshots read that dashboard selection, so a fresh article can exist in the RSS cache and still never reach its country page. Adding a regional feed alone does not fix this loss.

A read-only cache audit at **2026-09-13 10:46:25 UTC** found:

| Observation | Count |
|---|---:|
| Full digest articles, generated at 10:36:49 UTC | 287 |
| Countries named in that full digest | 53 |
| Available full English RSS caches / configured feeds | 244 / 245 |
| Fresh RSS items under the default 96-hour limit | 969 |
| Countries named in those RSS items | 94 |
| Countries in RSS but absent from the full digest | 44 |
| Countries named by their combined pool | 97 |

The digest reported `droppedCategoryCap=683`. Guardian Pacific had a fresh Vanuatu ferry article; Island Times had Palau reporting; France 24 Asia Pacific had Malaysia reporting; ERR, LRT and LSM had Baltic reporting. Those countries were absent from the full digest's selected pool. The tech, finance, commodity and happy digest keys were absent at this read, so this is a **full-digest comparison**, not an observed five-variant capture.

The RSS caches and digest were written at different times. These figures measure available reporting and demonstrate the cap's blind spot; they are not an exact same-build attribution of all 44 omissions to the cap. Three countries appeared only in the digest, which is why the union exceeds 94.

## Implemented recovery

`GET /api/news/v1/list-country-headlines?country_codes=PW&country_codes=VU` reads the existing full English RSS caches in one batch. It never fetches a publisher, writes a new index or generates prose. It returns up to five distinct URLs per requested country, selecting distinct publisher families before filling remaining slots. It applies the digest's shared age limit and future-date tolerance, checks headline country mentions and verifiable HTTPS article URLs, and fails closed when URL revocations cannot be read. Opaque aggregator redirects are excluded before selection. Trusted origin publisher names replace aggregator feed labels, while ordinary feeds keep their registered names. Regional editions retain their parent publisher identity.

`state`, `feedTotal` and `feedCached` distinguish complete cache availability from partial or unavailable reads. A cached empty feed counts as available, not as country reporting. Missing or malformed caches do not claim complete coverage. A country omitted from `countries` has no matching accepted article in the available pool.

The freeze keeps its existing digest headlines, adds recovered curated rows before GDELT top-up, and includes accepted URLs in the brief's citation provenance. It records `coverage.developmentsCuratedFeeds` with cache counts, added headline count and recovered country count. Failures appear in `errors.developments` as `stage: curated-feeds`; the existing digest and index paths remain available. This does not change the two-publisher floor, curated-source requirement, citation checks or dashboard rankings.

## Local verification

The initial Palau regression failed with zero headlines before the change and passes with the recovered article. Registered RPC tests exercise the real RSS parser, generated query parsing and validation, Redis readers and country matching with controlled Redis responses. They cover stale, future, malformed, wrong-country, duplicate and revoked articles; missing caches; a revocation outage; request bounds; and publisher-family selection. Capture tests verify that one publisher still withholds a brief, while recovered curated reporting plus independent GDELT reporting can produce a cited brief.

Replaying the captured cache data through the final handler at **11:25:17 UTC** produced 84 countries with accepted RSS articles. Combining it with the recorded digest produced **92 countries**, recovering **39** absent from that digest. The broader 97-country audit pool above included aggregator redirects that the final reader rejects. The replay used an empty controlled revocation set; it does not establish the production revocation state. No production cache, corpus snapshot or generated brief was written.

CI also caught the new operation crossing the public OpenAPI byte budget. Shortening the repeated inline JMESPath summary preserves its input/output limits, HTTP error status and full-contract reference, while reducing the served JSON to 948,236 bytes under the unchanged 950,000-byte cap. The existing low-reserve warning remains. Generated contracts expose the required 1-250-country input and five-headline output bound. Capture selection preserves existing digest rows and gives remaining slots to independent recovered publishers first.

## Remaining acquisition gap

The final replay's combined pool still had no accepted headline for **104 countries**. This is a new observation window, not a subtraction from the September 9 snapshot's 123-country register. Other variants, publisher cadence, cache availability and matching can all affect the result.

| Region | Countries without a match in the recorded combined pool |
|---|---|
| Europe | AD, AL, AT, BE, CY, CZ, DK, GR, HR, IS, IT, LI, LU, MC, MD, ME, NL, PT, SI, SK, SM, TJ, TM |
| Middle East / North Africa | BH, DJ, JO, MA, MT, QA |
| South Asia | BT, LK, MV |
| Latin America / Caribbean | AG, BB, BS, BZ, CR, CU, DM, DO, GD, GT, GY, HN, KN, LC, NI, PA, PY, SR, SV, TT, UY, VC |
| Sub-Saharan Africa | AO, BF, BI, BW, CF, CG, CM, CV, ER, GA, GN, GQ, GW, KM, LR, LS, MG, MR, MU, MW, MZ, NA, RW, SC, SL, ST, SZ, TD, TG, ZM, ZW |
| East Asia / Pacific | BN, FJ, FM, JP, KI, MH, MM, MN, MO, NR, NZ, PG, SB, SG, TH, TL, TO, TV, WS |

## Production acceptance

After authorized deployment, the PR owner should inspect the first scheduled snapshot within 24 hours. Check `curatedFeeds`, `curatedRecovered`, `briefEligibleCount`, `briefCountryCount` and the recorded capture errors; verify recovered source links and dates on affected country pages. A partial cache read must remain visible. Investigate zero recovery despite healthy matching RSS caches, a rise in unsupported citations, or repeated cache/revocation failures; revert this reader and capture integration if it publishes incorrect provenance. Leave the issue open for the remaining acquisition gap. The existing September 9 snapshot remains unchanged, and production freshness is a separate acceptance gate.
