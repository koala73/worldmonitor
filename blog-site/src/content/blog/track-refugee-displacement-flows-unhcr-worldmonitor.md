---
title: "Track Refugee and Displacement Flows with UNHCR Data"
description: "WorldMonitor maps refugee and IDP populations from UNHCR's official API — displacement flows on the map, a dedicated panel, and structured data for agents."
metaTitle: "Refugee & Displacement Tracking | WorldMonitor"
keywords: "refugee flow data, displacement tracking dashboard, UNHCR data visualization, IDP monitoring, forced displacement statistics, displacement data API"
audience: "Humanitarian and NGO teams, researchers, journalists, policy analysts, students"
heroImage: "/blog/images/blog/track-refugee-displacement-flows-unhcr-worldmonitor.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-07-22"
---

Displacement is the human ledger of every crisis. Conflict, drought, floods, economic collapse — whatever the driver, people moving in numbers is both the consequence that matters most and one of the most reliable indicators that a situation has crossed from tension into emergency.

WorldMonitor builds displacement into the same dashboard as the conflicts, disasters, and risk scores that drive it.

## What the displacement layer shows

The data comes from **UNHCR's official population API** — refugee populations by country of origin and country of asylum, plus internally displaced persons — the same statistics that anchor humanitarian planning worldwide.

It surfaces in three places:

- The **Displacement panel**: per-country refugee and IDP counts, ready to scan.
- The **displacement flows map layer**: origin-to-asylum movements drawn on the global map, so you can see corridor structure — who is leaving where, and where they arrive — next to the conflict zones and disasters producing the movement.
- The **population-exposure view**, which connects hazard footprints to the people inside them.

The point of the placement is context. A displacement chart in isolation tells you magnitude. The same numbers on a map with [live conflict events](/blog/posts/track-global-conflicts-in-real-time/), disaster tracking, and country instability scores tell you mechanism — and mechanism is what forecasting needs.

## Displacement as an early-warning input

For humanitarian teams, displacement data answers the operational questions: where caseloads are growing, which asylum countries are absorbing pressure, which corridors are active. The [NGO situational-awareness workflow](/blog/posts/humanitarian-situational-awareness-ngo-security-monitoring-worldmonitor/) walks through pairing it with advisories, disease alerts, and country risk for field-security planning.

For analysts, it's a lagging-but-honest confirmation layer. Rhetoric and skirmishes can be noise; six figures of new displacement is not. When the [Country Instability Index](/blog/posts/country-instability-index-methodology-explained/) rises and displacement follows, you're watching escalation confirm itself in the most consequential data there is.

## For developers and agents

The `get_displacement_data` MCP tool returns refugee and IDP counts by country in structured form, and the displacement REST endpoints expose the same under the versioned API. Combined with `get_country_risk` and `get_conflict_events`, an agent can produce a grounded humanitarian snapshot for any country in one pass — numbers with provenance, not vibes. Pair it with the [outbreak and air-quality signals](/blog/posts/disease-outbreak-air-quality-monitoring-health-signals/) for the fuller picture of conditions on the ground.

## Limits

UNHCR statistics are authoritative but not real-time: they update on reporting cycles, not hourly. Displacement flows drawn on a map represent stock and corridor structure, not live movement of individuals — nothing here tracks people, only aggregate populations as officially reported. Fast-moving situations will show up in news, conflict events, and advisories before they appear in the official counts; use the layers together and mind the lag.

## Primary Displacement Source

The authoritative reference is the UNHCR [Refugee Data Finder API](https://www.unhcr.org/refugee-statistics/insights/explainers/forcibly-displaced-api.html). Figures are estimates with reporting lags and revisions, so cite the observation date and avoid treating a missing value as zero displacement.

## Frequently Asked Questions

**Where does the displacement data come from?**

UNHCR's official population API — refugee populations by origin and asylum country, plus IDP figures — the reference dataset used across the humanitarian sector.

**Is it real-time?**

No, and no honest tool would claim otherwise. Official displacement statistics follow reporting cycles. WorldMonitor pairs them with real-time layers — conflict events, disasters, news — so you can see the leading edge and the confirmed magnitude side by side.

**Can I use this data in my own analysis or app?**

Yes — via the `get_displacement_data` MCP tool or the displacement REST endpoints. See the [API reference](https://www.worldmonitor.app/docs/api-reference) and the [developer platform overview](/blog/posts/build-on-worldmonitor-developer-api-open-source/).

---

**Every crisis eventually gets measured in people who had to move. Watch displacement next to its drivers, and you see both the cost and the confirmation.**
