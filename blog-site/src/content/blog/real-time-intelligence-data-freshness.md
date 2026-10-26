---
title: "What Real-Time Means in an Intelligence Dashboard"
description: "Learn how event time, source publication, ingestion and refresh differ, so you can judge the freshness of news, flight, vessel and disaster data."
metaTitle: "Real-Time Intelligence and Data Freshness | WorldMonitor"
keywords: "real time intelligence data, OSINT data freshness, live dashboard delays, observation time, stale data"
audience: "Analysts and teams monitoring developing events"
heroImage: "/blog/images/blog/what-is-worldmonitor-real-time-global-intelligence.jpg"
pubDate: "2026-10-26"
---

A real-time intelligence dashboard brings together sources that update on different schedules. A screen refreshed seconds ago can contain an aircraft position from minutes ago, a news report about yesterday, and a weekly published series. To judge freshness, check when the underlying observation was made and whether the source is still reporting successfully.

WorldMonitor puts these inputs in a common workspace. That makes comparison easier, but it does not give every layer the same clock. This guide shows how to decide whether an observation is recent enough for your question.

*The cover is an archive dashboard screenshot. Its markers and displayed times are not current observations.*

## The five clocks behind a live view

| Clock | What it tells you | What it does not establish |
|---|---|---|
| Event time | When the reported event happened | When anyone learned about it |
| Observation time | When a sensor or source measured something | When the dashboard received it |
| Publication time | When a report or dataset was released | That the event itself is new |
| Ingestion time | When the platform received the input | That the input is recent |
| Display refresh | When your screen requested or rendered data | That a newer observation exists |

These clocks need not all be available. A news report may give only a publication time. A dataset may describe a reporting period rather than one instant. Preserve the precision the source actually supplies; do not turn a date-only record into a precise event timestamp.

For example, a panel reloaded at 09:10 might display a vessel observation from 08:45. The visible observation is 25 minutes old at the time of review, even if the request took milliseconds. This is an illustrative calculation, not a WorldMonitor latency measurement.

## Why one refresh interval cannot describe the whole dashboard

Aircraft and vessel observations depend on transmissions, reception and provider delivery. News depends on reporting and publication. Satellite products depend on acquisition and processing. Published economic series describe their own reference periods.

NASA's [LANCE near-real-time service](https://www.earthdata.nasa.gov/data/projects/lance) illustrates why a provider's “near real time” label needs context: it describes Earth observation data made available within three hours of a satellite observation. That is a provider product description, not a promise that every satellite observation reaches WorldMonitor in that time.

Use the [data sources documentation](https://www.worldmonitor.app/docs/data-sources) to identify the input behind a view. Then ask whether its publication cadence fits your task. A weekly series may be suitable for a trend comparison while being unsuitable for determining what happened in the last hour.

## Healthy, stale, empty and unavailable are different outcomes

A useful monitoring workflow distinguishes these cases:

- **Recent observations:** the source has supplied dated records within the period you need.
- **Older retained observations:** the last useful data remains visible, but it may no longer describe current conditions.
- **Valid empty result:** a successful query returned no matching records within its coverage.
- **Unavailable result:** the source or request did not provide a usable answer.
- **Partial coverage:** some locations, sources or fields are missing even though other results are present.

Do not convert the last three into “nothing happened.” A valid empty result is evidence about a query and its coverage, not universal evidence of absence.

WorldMonitor's [health documentation](https://www.worldmonitor.app/docs/health-endpoints) describes source-specific freshness, failure and retained-data states. These are operational signals. An overall healthy platform does not establish that every input behind a particular conclusion is current.

The maritime snapshot handler, for example, can [retain a prior snapshot when a relay request fails](https://github.com/koala73/worldmonitor/blob/0e64055aad55aeedf38136f0322905054a014b38/server/worldmonitor/maritime/v1/get-vessel-snapshot.ts). Retention can preserve useful context during an interruption. It also makes checking observation age essential.

## A practical freshness check

### 1. Define the period your question needs

“Are conditions changing this morning?” and “How does this month compare with last month?” need different evidence. Set the window before inspecting the result so the most recent-looking chart does not dictate the question.

### 2. Identify the source and its time field

Use the source label, record details or linked report. Write down the observation or publication time and its timezone. If it is unclear what “updated” refers to, record that uncertainty rather than treating it as event time.

### 3. Check coverage and delivery state

Look for missing-source, stale or unavailable indicators where exposed. If the interface does not expose the information you need, follow the source link or narrow your conclusion. Repeatedly refreshing the page cannot establish that a provider has produced a newer record.

### 4. Compare like periods

Compare this morning's observations with a comparable earlier window, not with an entire previous day. For published series, use the same unit and reference period. If the coverage changed between windows, record it alongside the apparent change.

### 5. Keep an as-of statement

End the check with a sentence that names the observation period and the retrieval time. This gives a colleague enough information to decide whether they need to repeat it.

## Example: a new port report and an older vessel snapshot

Suppose a report is published at 09:05 about a possible terminal disruption. You open a map at 09:10. Its most recent vessel observation for the relevant area is from 08:45.

The observation predates the report's publication, but the event time is still unknown. You cannot use that map alone to say the disruption has or has not changed traffic. First establish when the reported disruption began, then seek observations covering the later period.

A defensible note would be:

> Reviewed at 09:10 UTC. The available vessel observation is dated 08:45 UTC. The report was published at 09:05 UTC but does not establish the event time. Current traffic effects remain unresolved.

All times in this example are invented to explain the method. For vessel-specific interpretation, see [AIS tracking accuracy and coverage](/blog/posts/ais-vessel-tracking-accuracy/).

## Make the timing part of the briefing

A simple record is enough: **question, source, observation period, retrieved at, coverage gap, conclusion**. Keep these fields with the source links when handing work to another person.

Start in [WorldMonitor](https://www.worldmonitor.app/) and choose the layers relevant to your question. Use [AI summaries as a reading aid](/blog/posts/ai-intelligence-summary-reliability/) while retaining the timestamps of the underlying evidence. A newly generated summary does not refresh its source material.

## Frequently Asked Questions

**Does real-time mean every data point is current to the second?**

No. Sources have different observation and publication schedules. Judge the relevant record's age and coverage rather than the dashboard label alone.

**Does reloading the page make stale data fresh?**

No. It can request another response, but a new request does not guarantee a new upstream observation.

**Is an empty map evidence that nothing happened?**

Not by itself. Check the selected time window, filters, source coverage and whether the query succeeded.

**Can older data still be useful?**

Yes, for context or a historical comparison. Label its age and avoid using it to make claims about conditions after the observation period.

**How should I compare two live dashboards?**

Compare the same source type, place and observation period. Note missing data and delivery failures separately; a faster screen refresh is not necessarily fresher evidence.
