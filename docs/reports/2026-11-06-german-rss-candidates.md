# German RSS candidates: Deutschlandfunk and ZDFheute

Evaluation date: 2026-11-06. Related requests:
[#10102](https://github.com/koala73/worldmonitor/issues/10102) and
[#10103](https://github.com/koala73/worldmonitor/issues/10103).
Source inspection started at `386bf186bec3a7948b1852e831d260516321c8e2`.

## Decision

Keep both candidates unintegrated until permission for the intended use is
confirmed. Both endpoints returned RSS, but transport success does not meet the
issues' licensing and ingestion acceptance criteria. This report records the
evaluation; it does not complete either source integration request.

No catalog, allowlist, source tier, publisher family, default selection, or
ingestion configuration changes are included. An optional source still enters
the ingestion and storage path when selected. Opt-in status does not resolve
the permission requirement.

## Publisher terms

The following official pages were read on the evaluation date:

| Candidate | Published guidance | Outstanding requirement |
|---|---|---|
| Deutschlandfunk | The [RSS guide](https://www.deutschlandfunk.de/rss-angebot-102.html) lists the proposed news feed and describes reading headlines or short descriptions with links to the publisher. The [general terms](https://www.deutschlandfunk.de/nutzungsbedingungen-102.html) require prior written consent for copying, republication, distribution, storage, or translation of protected content, including excerpts. They limit use to private, noncommercial purposes. | Confirm permission for WorldMonitor's aggregation, storage, display, and commercial contexts. The reader guide alone does not establish that scope. |
| ZDFheute | The [ZDF terms](https://www.zdf.de/nutzungsbedingungen) require prior written consent for copying, modification, distribution, or storage of protected information, including excerpts. They limit use to private, noncommercial purposes. | Confirm permission for feed metadata, headlines, excerpts, caching, and display in WorldMonitor, including commercial contexts. The separate video embedding provision does not establish RSS permission. |

No separate permission or RSS-specific grant covering WorldMonitor's intended
use was supplied in either issue or established by this evaluation. This is an
unmet integration requirement, not a legal determination about every possible
use of these feeds. Do not infer permission from endpoint availability.

The current server parser in
`server/worldmonitor/news/v1/list-feed-digest.ts` extracts article titles,
links, dates, and descriptions. Its fetch path caches parsed results. Any
permission assessment must cover that actual processing, rather than assume
that the product only shares links. Full articles, images, and videos are
outside the proposed integration scope.

## Endpoint observations

Bounded HTTPS GET requests were made at approximately 08:50 UTC on 2026-11-06.
The requests used a `WorldMonitor/1.0 RSS source evaluation` User-Agent, a
25-second limit, a three-redirect limit, and HTTPS-only redirects. Only aggregate
observations are retained in this report; publisher article content is not
committed.

| Observation | Deutschlandfunk | ZDFheute |
|---|---|---|
| Requested URL | `https://www.deutschlandfunk.de/nachrichten-100.rss` | `https://www.zdf.de/rss/zdf/nachrichten` |
| Redirects | None | HTTP 301 to `https://www.zdfheute.de/rss/zdf/nachrichten` |
| Final response | HTTP 200, `application/rss+xml;charset=UTF-8` | HTTP 200, `application/xml` |
| XML structure | RSS with 30 items | RSS with 195 items |
| Channel language | `de-DE` | No channel language value |
| Parseable item dates with explicit timezone | 30 of 30 | 195 of 195 |
| Newest item date, normalized to UTC | 08:40:11 | 08:49:39 |
| Article link hosts | `www.deutschlandfunk.de` | `www.zdfheute.de`, `www.zdf.de`, `3d.zdf.de`, `presseportal.zdf.de`, `www.phoenix.de` |

XML structure was checked with Python's `xml.etree.ElementTree`; dates were
checked with `email.utils.parsedate_to_datetime`. These checks establish basic
XML and timestamp validity for one response. They do not exercise WorldMonitor's
parser, date filtering, publisher-link gate, caches, or production proxy. One
sample does not prove sustained availability or freshness across refresh cycles.

## Current integration boundaries

- Neither candidate is registered in `shared/news-catalog.json`.
- The existing `isAllowedDomain()` predicate from
  `api/_rss-allowed-domain-match.js` returns `false` for both proposed URL hosts.
  Adding a catalog row alone would not enable proxy access.
- ZDF redirects to another host. Any later allowlist work must validate the
  canonical host and every required redirect through the existing SSRF guards.
  Article delivery hosts need a separate publisher-link review; a host appearing
  in this sample is not a reason to allow it automatically.
- `scripts/validate-rss-feeds.mjs --ci` reads the registered catalog and requires
  allowed HTTPS hosts. It was not run against these unregistered candidates.
  The direct requests above do not substitute for that validation.
- `src/config/feeds.ts` documents opt-in migration for returning denylist
  profiles. Omitting a candidate from the default list alone does not prove that
  it stays disabled for returning users.
- Publisher-family and originating-publisher safeguards remain unchanged.
  Distinct feed labels and syndicated articles must not create extra independent
  confirmations.

## Acceptance status and resumption

| Requirement | Status | Evidence needed before integration |
|---|---|---|
| Permitted use | Blocked for both candidates | Written permission or an applicable grant that covers the actual fields, caching, display, and commercial use. Record scope and conditions. |
| HTTPS, basic XML, and timestamps | Observed once | Run the existing validator and real parser after permission and configuration review; check redirects, retained items, and date filtering. |
| Approved ingestion pipeline | Unverified | Exercise the configured proxy and server ingestion without bypassing SSRF or publisher-link checks. |
| Attribution and language | Unimplemented | Use explicit `de` metadata, retain publisher links, review provenance and tiers, and validate publisher-family attribution. ZDF's missing channel language cannot supply the catalog metadata. |
| Optional activation | Unimplemented | Full variant, Europe category; verify new and returning profiles, explicit selections, enable/disable, reload, and source-cap ordering. Keep default activation off. |
| Added coverage and duplication | Unmeasured | Compare matched time windows with existing German publishers, including Tagesschau and DW. Report retained items, overlapping stories, and additional topics. Exclude syndication from independent corroboration counts. |
| Sustained reliability | Unverified | Observe multiple normal refresh cycles, cache behavior, failures, and recovery. Record the sample window and freshness. |

After permission is confirmed, use the canonical catalog and existing metadata,
allowlist generation, selection migration, and regression tests. Do not create a
parallel feed manager. Preserve category ordering so new sources do not displace
existing free-user selections. Capture source-settings UI evidence if the later
integration changes the rendered source list.

## Verification of this report

`npm run docs:check` passed. Direct endpoint and XML checks are described above.
The catalog and host observations were checked against the current local source.
No runtime behavior changed, so no new runtime regression tests were added.
Application dependencies are absent in this worktree; parser and browser suites
were not run. Production ingestion, licensing clearance, coverage benefit, and
source acceptance remain open. No deployment or production configuration change
is part of this evaluation.
