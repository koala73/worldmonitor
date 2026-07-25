---
title: "Monitor Disease Outbreaks and Air Quality on One Map"
description: "WorldMonitor merges WHO outbreak news, CDC travel notices, and outbreak trackers with OpenAQ and WAQI air-quality sensors into one global health-signals layer."
metaTitle: "Disease Outbreak & Air Quality Monitoring | WorldMonitor"
keywords: "disease outbreak map, epidemic monitoring dashboard, WHO outbreak tracker, air quality PM2.5 map, global health surveillance, health signals API"
audience: "Public-health analysts, NGO and travel-security teams, researchers, journalists, expats and frequent travelers"
heroImage: "/blog/images/blog/disease-outbreak-air-quality-monitoring-health-signals.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-07-22"
---

Health signals are geopolitical signals. An outbreak reshapes trade and travel; a smoke or smog crisis empties cities and moves elections; and health infrastructure under strain is one of the most concrete measures of a state losing capacity. Yet health monitoring usually lives in separate tools from the conflict, disaster, and market layers it interacts with.

WorldMonitor folds both halves — outbreaks and air quality — into the same dashboard as everything else.

## Outbreak tracking from official and specialist sources

The disease-outbreak pipeline merges complementary sources rather than betting on one:

- **WHO Disease Outbreak News** — the official record of internationally significant events, read from WHO's own API.
- **CDC travel health notices** — the practical layer: what a major public-health agency thinks travelers need to know, by destination.
- **Outbreak News Today** — specialist reporting that often moves days ahead of official confirmation.
- A dedicated **outbreak tracker dataset** for structured, ongoing events.

Outbreaks appear in the **Disease Outbreaks panel** and as a map layer, so an event sits in geographic context: next to the airports it may close, the displacement it may cause, and the [country risk](/blog/posts/country-risk-monitoring-due-diligence-worldmonitor/) it feeds into.

## Air quality as ground truth

The second half of the health layer is instrumented, not reported: **PM2.5 readings from OpenAQ's global sensor network plus WAQI station data**. Air quality is one of the few global datasets that is dense, numeric, and hourly — and it moonlights as an indirect sensor for other events. Wildfire smoke plumes, industrial incidents, and even conflict damage show up in particulate readings, sometimes before anything official is published.

For daily use it's simpler than that: if you live in, travel to, or manage people in a city with episodic air crises, a live PM2.5 layer next to your news feeds is just operationally useful.

## One health layer, one query

For agents and developers, the `get_health_signals` MCP tool returns current outbreak signals and air-quality readings in a single structured call, with the REST equivalents under the versioned health API. The [humanitarian workflow](/blog/posts/humanitarian-situational-awareness-ngo-security-monitoring-worldmonitor/) shows the field-security use; pairing it with [displacement data](/blog/posts/track-refugee-displacement-flows-unhcr-worldmonitor/) gives the fuller picture of pressure on a population.

A useful habit from the [15-minute briefing routine](/blog/posts/daily-intelligence-briefing-workflow-15-minutes/): scan health signals for the countries already on your watchlist. Outbreaks rarely stay health stories — they become border stories, supply stories, and political stories, and the analysts who tracked them from the WHO bulletin onward are never surprised by that.

## Limits

Outbreak reporting inherits the biases of surveillance: countries with strong health systems report more, so more reports don't always mean more disease. Official WHO confirmation lags the specialist press by design — that's what verification costs. Air-quality sensor density varies sharply by region, with the thinnest coverage often where conditions are worst. Read gaps as gaps, not as clean air or absent disease.

## Primary data sources

Check health events at [WHO Disease Outbreak News](https://www.who.int/emergencies/disease-outbreak-news) and [CDC Travel Health Notices](https://wwwnc.cdc.gov/travel/notices). Air-quality observations come from the documented [OpenAQ API](https://docs.openaq.org/) and [World Air Quality Index API](https://aqicn.org/api/).

## Frequently Asked Questions

**Which outbreak sources does WorldMonitor track?**

WHO Disease Outbreak News via WHO's API, CDC travel health notices, Outbreak News Today's specialist reporting, and a structured outbreak-tracker dataset — merged and deduplicated.

**Where does the air-quality data come from?**

PM2.5 measurements from OpenAQ's open sensor network and WAQI station data, displayed live and available through the same health-signals API.

**Is this a replacement for official public-health guidance?**

No. It's situational awareness — early, aggregated, and geographically contextualized. Decisions about vaccination, treatment, or travel restrictions belong with official guidance.

---

**Epidemics and air don't respect the borders between your dashboards. One health layer, on the same map as everything it affects, is how you stop being surprised.**
