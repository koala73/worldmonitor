---
title: "Country risk with a memory"
description: "How daily country snapshots help analysts compare CII, resilience and selected headlines without hiding missing days or formula changes."
metaTitle: "Daily country history and risk trends | World Monitor"
keywords: "country risk history, CII timeline, resilience history, daily country snapshots"
audience: "Country-risk analysts and monitoring teams"
heroImage: "/blog/images/blog/country-risk-monitoring-workflow-for-analysts.jpg"
pubDate: "2026-10-19"
---

A current score tells you where to look. A dated record helps you explain what changed.
World Monitor's daily country history pairs CII and resilience observations with selected source-linked headlines.
History starts when the daily archive worker is activated. An empty archive means no daily snapshots are available yet.

Open a country's detail panel and select a date in **Daily country history**.
The panel shows the available scores, their formula identities and the headlines captured for that day.
Follow a headline link to inspect the publisher's reporting.

The two score lines answer different questions. Higher CII means more instability.
Higher resilience means more capacity to withstand shocks.
Reading both can help frame a question, but adding them together would produce a number with no defined meaning.

Missing days stay missing. The chart breaks its lines when a score is unavailable or its formula changes.
That prevents a methodology revision from looking like a measured improvement or deterioration.
No selected headline does not establish that nothing happened.
The archive uses explicit country-name mentions in English digest headlines and stores up to five per day.

Anonymous and free readers can request seven UTC days.
Pro readers can request 90 days. API and Enterprise readers can request 365 days.
These are access limits, not promises that every date already exists.
The server returns only the observed dates within the permitted window.

Developers can read the same archive through `get-country-history`.
MCP clients use `get_country_history` with a country code and a day window.
Both preserve source versions and observation gaps.

The [daily country history methodology](/docs/methodology/country-history) explains the snapshot fields, selection rules and comparison limits.
Full map playback and historical article bodies remain outside this feature.

For a repeatable investigation, use the [country-risk monitoring workflow](/blog/posts/country-risk-monitoring-workflow-for-analysts/) to select a question before comparing dates.
The archive groups dates in UTC and retains each score's source time. [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) explains why timestamps need an explicit relationship to UTC for interoperable comparisons.

## Frequently Asked Questions

**Does a 365-day plan include a full year of observations immediately?**

No. The plan permits a 365-day window, but the archive returns only dates captured after activation. Missing days remain missing.

**Can I compare scores across a formula change?**

Compare changes within one formula version. The chart breaks the line at formula changes and observation gaps so they do not appear as measured daily changes.

**Does a day without headlines mean that nothing happened?**

No. It means no eligible headline was stored by this selection process. The archive is a dated record of selected observations, not a complete event census.
