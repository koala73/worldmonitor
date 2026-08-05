---
title: "Real-Time Radiation Monitoring: Read the Sensors, Not the Rumors"
description: "WorldMonitor merges EPA RadNet stations and the Safecast citizen-sensor network into a live radiation layer, with nuclear sites and IAEA irradiators for context."
metaTitle: "Real-Time Radiation Monitoring Map | WorldMonitor"
keywords: "real time radiation map, radiation levels live, nuclear radiation monitoring, Safecast radiation data, EPA RadNet, radiation monitoring dashboard"
audience: "OSINT analysts, journalists, researchers, emergency-preparedness planners, concerned readers during nuclear events"
heroImage: "/blog/images/blog/real-time-radiation-monitoring-radnet-safecast.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-07-22"
---

Every nuclear scare follows the same script. An incident at a plant, shelling near a reactor, a test rumor — and within an hour, social media fills with screenshots of dosimeters, decade-old maps, and numbers with no units. Radiation is uniquely suited to panic because it's invisible, poorly understood, and genuinely serious when real.

It's also one of the best-instrumented hazards on Earth. The sane response to a radiation rumor is to read the sensor networks — which is exactly what WorldMonitor's Radiation Watch does.

## Two networks, merged

The radiation layer merges two complementary systems:

- **EPA RadNet** — the United States' official fixed monitoring network, read directly from the EPA's public data service. Calibrated, maintained, government-operated stations.
- **Safecast** — the global citizen-science network born after Fukushima, with volunteer-operated sensors contributing measurements worldwide through an open API.

The merge is deliberate. Official networks are trustworthy but geographically bounded; Safecast reaches places no government feed covers. Each observation keeps its source attribution, so you always know whether you're reading a federal station or a community sensor.

Readings appear in the **Radiation Watch panel** and on the **radiation map layer** — and the map gives them context that a standalone radiation site can't: **nuclear facilities** and **IAEA-listed gamma irradiator** locations as reference layers, plus conflicts, fires, and weather on the same canvas. A radiation question is never just "what's the reading?" — it's "what's the reading, where, relative to what, and which way does the wind blow?"

## What the network read while this was written

Pulled live from the merged feed on July 22, 2026:

| Station | Reading | Its own baseline | Deviation | Verdict |
|---|---|---|---|---|
| Honolulu (EPA RadNet) | 28 nSv/h | 27.8 | +0.2 (z = 0.2) | normal |
| Seattle (EPA RadNet) | 27 nSv/h | 26.9 | +0.1 (z = 0.1) | normal |
| Houston (EPA RadNet) | 39 nSv/h | 36.4 | +2.6 (z = 1.8) | normal |

The Houston row is the whole lesson in one line. Its 39 nSv/h is forty percent "hotter" than Seattle — and completely normal, because Houston's own baseline runs high. Someone screenshotting absolute numbers would call that a story; the z-score says it's a Tuesday. Every observation in the feed carries exactly this context: source attribution, freshness, the station's own baseline, a z-score, and a severity classification — so "elevated" means elevated *for that place*, not elevated compared to a city with different geology.

## How to read a radiation event

When radiation is in the news, three checks separate signal from noise:

1. **Are sensors actually elevated, or is the map just red on social media?** Look at readings near the event, with units and source attribution.
2. **Is the elevation local or spreading?** One anomalous sensor is an instrument story; a coherent gradient across stations is an event.
3. **Does the pattern match the claim?** Real releases propagate with weather and distance. The [breaking-news verification workflow](/blog/posts/verify-breaking-news-osint-workflow-journalists/) applies here directly: multiple independent instruments, or it's still a rumor.

Background radiation also varies naturally from place to place — granite geology, altitude, and medical facilities all move the baseline. Absolute numbers matter less than deviation from a location's own normal.

## For developers and agents

The `get_radiation_data` MCP tool returns current observation levels from the monitoring stations in structured form, alongside the radiation REST endpoints. An agent fielding "is the radiation spike near X real?" can pull actual sensor readings with source attribution instead of summarizing panic — and cross-reference [natural-disaster](/blog/posts/natural-disaster-monitoring-earthquakes-fires-volcanoes/) and conflict layers in the same pass.

## Limits

Sensor coverage is uneven: dense in the US, Japan, and Europe, sparse exactly where geopolitical radiation risk is highest — active conflict zones rarely host functioning public sensor networks. Citizen sensors vary in calibration and siting. A quiet map in an uninstrumented region means "no data," never "no radiation." And a dashboard is not a civil-defense system: in a genuine emergency, official local guidance wins.

## Primary data sources

Verify readings and network coverage at the [EPA RadNet program](https://www.epa.gov/radnet), [Safecast radiation map](https://map.safecast.org/), and the IAEA's [Directory of Radiotherapy Centres](https://dirac.iaea.org/). A dashboard view is context, not an emergency instruction.

## Frequently Asked Questions

**Where does the radiation data come from?**

Two merged networks: the US EPA's RadNet fixed monitoring stations and the global Safecast citizen-sensor network, with per-observation source attribution.

**Why do some regions show no readings?**

Because no public sensors report there. Coverage follows sensor deployment, not risk. WorldMonitor shows gaps as gaps rather than interpolating reassuring values.

**What should I do if readings genuinely rise near me?**

Follow official emergency guidance for your area. WorldMonitor is a situational-awareness tool for understanding events; it is not an emergency-alert or civil-defense system.

---

**Radiation is the rare threat you can actually measure from your desk. When the next scare hits, skip the screenshots and read the instruments.**
