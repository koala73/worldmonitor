---
name: hazard-watch
description: List recent significant earthquakes, active wildfires and other natural hazard events worldwide or near a place, from World Monitor's USGS, NRCan and NASA FIRMS feeds. Use when the user asks about recent earthquakes, wildfires, storms or other natural disasters.
---

# Hazard watch

Report recent natural hazards from World Monitor's seeded feeds.

## Tools

| Tool | Access |
|---|---|
| `get_natural_disasters` | free-account |

## Steps

1. Call `get_natural_disasters`. When the user names a hazard type, pass `dataset` as an array: `["earthquakes"]`, `["wildfires"]` or `["other"]`. For a place, pass `lat`, `lon` and `radius_km` (up to 2000). Use `since_days: 7` unless the user asks for another window, and `active_only: true` for events still under way.
2. For earthquakes give magnitude, location, depth and time. For wildfires give location and detection time. For other events give type, location and whether the event is still active.
3. Sort by severity, then by time. Each list is capped at 30 items by default; when a list comes back with exactly 30, say there may be more and offer a narrower area or window.

## Rules

- The earthquake feed covers magnitude 4.5 and above. Say so when a user asks about smaller quakes.
- Give every time in UTC with its date.
- If the result reports simplified geometry or a source outage, tell the user which part is affected.
- Do not estimate casualties or damage the data does not report.
