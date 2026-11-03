---
title: "How Accurate Is AIS Vessel Tracking? A Guide for OSINT Research"
description: "Read AIS vessel positions, identity fields and transmission gaps with care. Learn what ship-tracking data can support in a WorldMonitor investigation."
metaTitle: "AIS Vessel Tracking Accuracy and Limits | WorldMonitor"
keywords: "AIS vessel tracking accuracy, ship tracking OSINT, AIS gaps, military ship tracking, maritime data coverage"
audience: "Maritime researchers, journalists and supply-chain analysts"
heroImage: "/blog/images/blog/what-is-a-maritime-chokepoint.jpg"
pubDate: "2026-10-26"
---

AIS vessel tracking is useful evidence of reported ship positions and movement. Its value depends on the transmitted data, reception coverage, observation age and correct vessel identity. A dot on a map is not a guarantee of a vessel's present location, and a gap is not proof that the vessel deliberately went dark.

WorldMonitor lets researchers compare maritime observations with chokepoint conditions and reporting. Use that combined view to decide what to investigate next, while keeping the limits of each input visible.

*The cover is an archive WorldMonitor maritime view. Its values are not current traffic measurements.*

## What an AIS record actually says

The US Coast Guard distinguishes position reports from static and voyage-related messages. These can arrive at different times, so a position may appear before a name or voyage field. It also documents duplicate identifiers and the possibility of spoofed targets. See the [USCG AIS frequently asked questions](https://www.navcen.uscg.gov/ais-frequently-asked-questions).

For research, review the fields separately:

| Field | How to check it |
|---|---|
| Position and time | Check the age and whether the location makes sense. |
| Speed and course | Use several dated points before describing a movement pattern. |
| MMSI and name | Check that the identity agrees with authoritative vessel records. |
| Destination and ETA | Check when the stated voyage was updated; seek separate arrival evidence. |
| Navigation status | Compare the status with the dated movement records. |

Do not treat a destination field as a verified port call. A declared destination, an observed position near a port and a confirmed arrival are three different kinds of evidence.

## A tracking gap is a question to investigate

IMO's [operational AIS guidelines](https://wwwcdn.imo.org/localresources/en/OurWork/Safety/Documents/AIS/Resolution%20A.1106%2829%29.pdf) explain that AIS does not provide a complete picture: some vessels may not carry it, transmissions can cease, and sensor or configuration problems can produce incorrect information.

On a public tracking service, a missing observation can also reflect the collection and delivery path. Before attributing intent, check whether other vessels in the same area also disappeared, whether the source reports a problem, and whether the observations resume later.

Use neutral wording first: “No observations were available in this source for the selected period.” A claim such as “the vessel disabled AIS to evade monitoring” needs additional evidence about the vessel and the cause of the gap.

This distinction is especially important near a conflict zone. Geographic proximity can guide a search; it does not establish why a vessel changed course or stopped appearing.

## Can AIS show every military ship?

No. The IMO guidelines explicitly include warships among vessels that may not be fitted with AIS. An AIS map cannot establish a complete military order of battle.

WorldMonitor also uses sources with different roles, including [maritime observations and navigational warnings](https://www.worldmonitor.app/docs/maritime-intelligence). A reported naval deployment and a transponder observation should retain their separate source and time labels. Do not present a reported operating area as an exact current AIS position.

The same principle applies when comparing aircraft with ships: each dataset has its own visibility limits. The [military flight tracking guide](/blog/posts/military-flight-tracking-osint/) explains the aviation side.

## A five-step vessel research workflow

### 1. Write a narrow question

Start with something the data might answer: “Do the available observations show this vessel near the port during the reported period?” Avoid starting with an assumed explanation such as sanctions evasion or military intent.

### 2. Resolve identity before joining records

Record the identifiers supplied by the source. Check whether the name and identifiers agree with the vessel you mean. Similar names alone are not enough to combine two tracks or attach reporting about one vessel to another.

If identifiers disagree, preserve both records and the conflict. Do not force a match to complete the narrative.

### 3. Check age, coverage and continuity

Record the source, observation time and retrieval time. Review the available observations around the period of interest. A later point does not reveal the route taken through an unobserved interval.

WorldMonitor's [vessel snapshot implementation](https://github.com/koala73/worldmonitor/blob/0e64055aad55aeedf38136f0322905054a014b38/server/worldmonitor/maritime/v1/get-vessel-snapshot.ts) can retain earlier data when a relay request fails. Check the record rather than assuming every response contains new positions. The [data freshness guide](/blog/posts/real-time-intelligence-data-freshness/) explains the difference.

### 4. Compare independent context

Look for dated port notices, navigational warnings and reporting that addresses the same place and period. Ask what each source establishes. A warning identifies a reported hazard; it does not establish that a particular ship encountered it.

For corridor-level research, use the [chokepoint and freight monitoring workflow](/blog/posts/tracking-global-trade-routes-chokepoints-freight-costs/). Vessel positions, transit counts and modeled disruption indicators should not be substituted for one another.

### 5. Report the observation and its limit together

A useful conclusion names the vessel identifier, source, observation period and unresolved gap. Keep the evidence links so another analyst can repeat the check.

For example, write “The available observations place the identified vessel near the port before the reported incident; no later observation was available in the checked source.” Do not shorten that to “The vessel remained at the port.”

## Worked example: a gap near a port

Suppose a vessel has an observation outside a port at 08:00 UTC and another farther offshore at 11:00 UTC. A report describes an incident at the port at 09:00 UTC. These are hypothetical facts for this example.

The two points do not establish a port entry, a three-hour stop or a response to the incident. Your research note should separate:

- **Observed:** two dated positions attributed to the same identifier, subject to the identity check.
- **Unobserved:** the route and activity between those positions.
- **Reported separately:** an incident at the port.
- **Next evidence needed:** a relevant port notice, verified arrival record or additional observations covering the gap.

This gives the next researcher a concrete task rather than a speculative story.

## Choose coverage for the question you need to answer

Open [WorldMonitor](https://www.worldmonitor.app/) for maritime context alongside other signals. Before choosing any tracking service, check whether it provides the geography, historical period, identity detail and permitted use your investigation needs. A subscription price is not an accuracy measurement, and public access does not imply a complete history.

For WorldMonitor's analyst and integration features, consult [current access and plans](https://www.worldmonitor.app/docs/pricing). Use primary vessel and port records when a conclusion depends on identity or a specific visit.

## Frequently Asked Questions

**How accurate is AIS vessel tracking?**

There is no single accuracy figure for every service and situation. Check transmitted information, identity, reception coverage and observation age for the record you are using.

**Does an AIS gap prove a ship turned off its transponder?**

No. A public dataset's gap alone does not establish the cause. Check source coverage and independent evidence before assigning intent.

**Can I track all military ships with a free dashboard?**

No. AIS does not cover every military vessel, and paying for a service does not guarantee that a non-broadcasting vessel will become visible.

**Is a destination field proof of a port visit?**

No. Treat the stated destination as a lead. Establish a visit with dated observations and appropriate port or vessel records.

**Can I use this workflow for navigation?**

This is an OSINT research workflow. The IMO guidance treats AIS as one input alongside other navigational information; a public dashboard is not a substitute for the equipment and procedures used to navigate a vessel.
