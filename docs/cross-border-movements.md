---
noindex: true
---

# Cross-border movement sources

Issue #9023 extends the ODP situation view with independently published route reports. Counts keep their source, date and measure. Stocks, arrivals, returnees, deaths and enforcement encounters must not be added together. Countries and situations can overlap.

| Source | Automatic retrieval | Normal cadence | Maximum report age | Licence and access evidence, 2026-10-19 |
| --- | --- | --- | --- | --- |
| UNHCR Operational Data Portal | Existing situation JSON | Daily worker | 45 days per country report | [ODP](https://data.unhcr.org/) footer states datasets are CC BY 4.0. Credit UNHCR and the situation; identify WorldMonitor transformations. |
| UK Home Office | GOV.UK Content API, daily table and linked SB_01 ODS sheet | Daily worker | 3 days | [OGL v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Contains public sector information licensed under the Open Government Licence v3.0. |
| US CBP | Official Nationwide Encounters AOR CSV, southwest land border only | Daily discovery of monthly releases | 75 days | [CBP copyright notice](https://www.cbp.gov/site-policy-notices/copyright-notice). US government work unless otherwise noted. Encounters count enforcement events, not unique people or new arrivals. |
| Frontex | Inactive | Monthly | Not configured | [Legal disclaimer](https://www.frontex.europa.eu/legal-disclaimer/) requires permission for non-private reuse. No provider contact or permission is recorded. |
| IOM Missing Migrants / HDX | Inactive | Weekly | Not configured | Package metadata identifies CC BY IGO. HDX automated retrieval returned an explicit bot-activity block and a direction to contact HDX. A separately readable CSV does not establish worker access. No bypass or automated feed is enabled. |
| Panama Darien | Inactive | Monthly | Not configured | Statistics PDF was discoverable; terms page could not be read. Permission review remains incomplete. |
| IDMC | Inactive | Provider dependent | Not configured | Required client ID remains blocked under #9014. |

The UK series returns rolling 7- and 30-day totals only when every day in that window is present. A missing observation is unknown; an explicitly reported zero remains zero. Thirty-day change compares two disjoint 30-day windows. Revisions in the daily table replace the same date in the ODS history. A weekly surge requires more than 10,000 arrivals, or at least 1,000 arrivals and twice the median of prior complete weekly windows over 90 days, with at least three complete baseline windows. Cross-source signals use the source report clock. CII v12 adds five points once per explicitly named country for fresh arrival surges, including the existing ODP monthly arrival acceleration. Stocks and CBP encounters cannot trigger it.

`GetCrossBorderMovements` reads only Redis and supports an ISO alpha-2 `country_code` and exact `route` ID. The unfiltered shared request is public; filtered requests use the existing authenticated API path. MCP `get_displacement_data` retains its annual default. Set `view=movements` for operational reports, `countries` and `route` for filters, and `limit=0` for all rows. The default movement limit is 30, so it is not a global coverage inventory. Licence, credit and transformation notice survive projections. Stock changes retain their observation interval and remain distinct from arrival totals.

Each new source has its own key, original fetch clock, report clock, seed metadata, activation marker and last-good policy. Health stays activation-gated before the first successful publication. A failing source cannot suppress another source. The API keeps stale reports labeled as stale; the map excludes them and draws deaths separately. ODP country points without a complete monthly observation are omitted rather than mislabeled with a year-to-date total.

## Acceptance limits

Read-only local fetches succeeded for both new active adapters. The UK report ended 2026-10-18; CBP ended 2026-08-31. All 16 curated ODP situations were readable, but the newest Americas report was 2025-12-31, DRC 2026-04-30 and Central Asia 2026-06-30. These old reports remain visibly stale. Consequently, 15 fresh routes/situations on four continents are **not accepted**. The inactive feeds above and stale ODP coverage remain open under #9023. This change must not close that issue.

No production seeds, deployment, activation or live acceptance run was performed. After authorized deployment, the operator must inspect `seed-meta:displacement:border-uk`, `seed-meta:displacement:border-cbp`, their canonical keys and `/api/health`; require source-specific fetch/content clocks and valid rows over two daily runs. Check that a failure preserves the original clock and another source remains readable. Stop the affected worker on parser or licence failures. Do not convert unavailable or missing periods into zero.
