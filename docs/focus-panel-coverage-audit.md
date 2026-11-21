---
noindex: true
---

# Dashboard focus: remaining panel coverage

Audit for #10562 against main `d6d8408506b6f4dc1cebbdc439da7624fb2c2b45`, 12 November 2026.

| Surface | Country focus | Rule or remaining prerequisite |
| --- | --- | --- |
| Strategic Water Levels | Filters | Match the host **or any listed riparian**. GERD therefore matches Egypt, Sudan and Ethiopia. Optional neighbours use the same rule. Match each reservoir once; chosen matches precede neighbour matches. These are monitored water bodies, not complete national coverage. |
| Population Exposure | Unsupported; “Not filtered” | `DataLoaderManager` calls `enrichEventsWithExposure` with a limit of ten locations per source. Some inputs are already truncated upstream. Attribute and filter before both cuts; filtering the displayed slice could falsely imply a country is quiet. |
| Climate Anomalies | Unsupported; “Not filtered” | Zones represent regions. A centroid is not country coverage; a zone-to-country rule remains undecided. |
| Weather alerts, natural events, unrest | Map layers, no list panels | The travel preset selects layers. A future list needs country attribution; there are no panel registry entries to switch. |
| Internet Disruptions | Filters (Outages tab) | Country names resolve through `countryCodeFromName`; DDoS and Anomalies remain explicitly global. |

## Live outage-name sweep

Read-only `GET infra:outages:v1` through the approved environment loader on
12 November 2026. The source snapshot was fetched at 15:47:31 UTC
(`1794498451479`) and contained seven outages. The seed envelope was unwrapped
before running every distinct name through the actual browser attribution helper.

| Cloudflare country name | Resolved ISO code |
| --- | --- |
| Ukraine | UA |
| Dominican Republic | DO |
| Peru | PE |
| Guyana | GY |
| Bangladesh | BD |
| Syria | SY |
| Sri Lanka | LK |

**Misses: none in this snapshot.** This is a point-in-time sample, not a claim
about every country Cloudflare may return. The names are retained as a small
regression case in `tests/scope-attribution.test.mts`. Unknown names still use the
existing counted, revealable “No country” path. No seed was run or cache changed.

## Verification limits

The reservoir tests use the committed 48-reservoir fixture. DOM checks cover
host/riparian matching, optional neighbours, unknown attribution, status filters,
Show all, empty results, loading, failures and clearing focus. Browser checks
exercise the existing reservoir dashboard flow and the real focus editor wired
to real panels on the map harness at desktop and mobile widths. The harness
controls data and bypasses account setup; it does not prove entitlement,
persistence, deployed APIs or production acceptance. Climate and population
exposure retain their “Not filtered” chips under a focus.
