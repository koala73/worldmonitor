---
name: conflict-pulse
description: Report active armed-conflict and unrest events with fatalities, dates and locations, alongside alert-flagged news for the same place, from World Monitor. Use when the user asks where fighting is happening, about a specific war or unrest, or for a conflict update on a country or region.
---

# Conflict pulse

Report current conflict activity from event-level data, then add the alert-flagged news that clusters with it.

## Tools

| Tool | Access |
|---|---|
| `get_conflict_events` | free-account |
| `get_news_intelligence` | free-account |

## Steps

1. Call `get_conflict_events` with `since_days: 14` (or the window the user asks for) and `limit: 0`, so event counts are not cut at the default 30 per list. For one country pass `country` with its English name (for example `"Sudan"`). For a region pass `lat`, `lon` and `radius_km`. Add `min_fatalities: 1` only when the user asks about deadly events; unrest events often record zero or unknown fatalities.
2. Call `get_news_intelligence` with `alerts_only: true`. Add `country` as the ISO alpha-2 code when the question is about one country. If no alert-flagged stories come back, call it again without `alerts_only`.
3. Group the events by location. For each group give the date range, number of events, best-estimate fatalities and the parties named in the data. If the result reports that output was truncated or simplified, say the counts are partial.
4. Add the news stories that match those locations, with their sources.

## Rules

- Fatality counts are best estimates from the source dataset (UCDP or the unrest feed). Say which one, and do not round them into totals the data does not give.
- Say how recent the newest event is. Conflict datasets lag events by hours to days.
- Name sides only as the data names them. Do not assign blame or predict escalation.
- An empty result means World Monitor has no recorded events in that filter, not that the area is calm. Say so.
