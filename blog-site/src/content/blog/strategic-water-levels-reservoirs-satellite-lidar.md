---
title: "Strategic Water Levels: satellite lidar readings for 50 reservoirs"
description: "World Monitor now tracks 50 strategic reservoirs and lakes with NASA ICESat-2 lidar. What the levels show, what each status means, and where the data stops."
metaTitle: "Reservoir levels from NASA ICESat-2 lidar | World Monitor"
keywords: "reservoir water levels, ICESat-2 lidar, satellite altimetry, transboundary water, GERD water level, Lake Mead record low, drought monitoring"
audience: "Water-security analysts, hydropower and energy analysts, drought researchers, OSINT researchers"
heroImage: "/blog/images/blog/strategic-water-levels-reservoirs-satellite-lidar.jpg"
pubDate: "2026-11-12"
---

World Monitor now reports the water level of 50 reservoirs and lakes that matter for hydropower, irrigation, shipping and disputes over shared rivers.
The levels come from NASA's ICESat-2 satellite, which measures the height of the water surface with a laser.
The feature is called **Strategic Water Levels**. It is a dashboard panel, a map layer, an API endpoint and an MCP tool.

Each reading is a dated satellite pass, not a live gauge.
NASA publishes ICESat-2 inland water data 50 to 70 days after the satellite flies over, so the newest values describe late summer, not this week.
Every level in this post names the pass it comes from.

## One instrument for every reservoir

The watchlist includes the Grand Ethiopian Renaissance Dam (GERD) on the Blue Nile, Lake Nasser, the Ataturk and Mosul dams on the Euphrates and Tigris, Xiaowan on the upper Mekong, Kariba on the Zambezi, Lake Mead and Lake Powell on the Colorado, and the Dead Sea.
Each entry records why it is on the list. For GERD, the entry reads: "Ethiopia's fill of Africa's largest hydropower dam sets how much Blue Nile water reaches Sudan and Egypt."
37 of the 50 entries are tagged transboundary, because the water crosses a border or the dam controls flow to a country downstream.

Dam operators decide whether to publish their own gauge readings, and when.
On a river that two or more countries dispute, a level published by the operator comes from one of the parties.
ICESat-2 measures every reservoir on the list with the same laser, the same processing and the same quality rules, whoever runs the dam.
That gives an analyst an independent number to set beside official statements.

## How a level is measured

ICESat-2 carries a laser altimeter that records surface height along narrow ground tracks.
World Monitor reads NASA's [ATL13 inland water surface height product](https://nsidc.org/data/atl13), processed on the public [SlideRule Earth](https://slideruleearth.io) service.
For each overpass, it keeps the water segments inside a fixed open-water box on the main body of the reservoir, away from inflow arms and shorelines.
The level for that pass is the median of those heights, in metres above the EGM2008 geoid, a model of mean sea level.
Two reservoirs that ATL13 covers poorly, Darbandikhan in Iraq and Gibe III in Ethiopia, use the ATL06 surface height product instead.

Quality rules drop a pass that has fewer than 5 segments, a median absolute deviation above 0.25 m, or beams that disagree by more than 0.3 m.
By default, a pass that sits more than 1 m plus 0.05 m per day of gap outside the range of its two neighbours is dropped as mislocated.
Gibe III, whose level can move more than half a metre a day in the Omo flood, allows 0.3 m per day of gap instead.

We checked the method against the US Bureau of Reclamation's daily gauge at Lake Mead.
Over 156 matched overpasses from 2018 to 2026, across a gauge range of 17.8 m, the satellite levels agreed with the gauge to a root-mean-square error of 0.052 m after removing a fixed 0.046 m datum offset.
The largest single error was 0.149 m.

The satellite returns to each reservoir every few days on large lakes and about once a month on narrow gorge reservoirs.
A daily job adds the passes NASA has published since the previous run.

## What the data showed on November 12

In the data World Monitor served on November 12, 2026, 33 of the 50 reservoirs read normal.
Three were at record lows, four were low, three were high, one was rising fast, one was falling fast, and five had no recent pass.

**Colorado River.** Lake Mead's pass on September 6, 2026 measured 316.8 m. That is the lowest of its 156 qualifying passes since October 2018, and 8.2 m below its usual level for September.
Lake Powell's pass on September 19 measured 1,072.2 m, also the lowest in its record and 17.2 m below usual for September.
Lake Mead's level triggers the Colorado River shortage tiers for Arizona, Nevada and Mexico.

**Nile.** GERD's pass on August 4 measured 623.5 m. That is 12.1 m lower than a year earlier and 5.3 m lower than the previous pass on April 6.
Its status still reads high. There are too few earlier passes near early August for a seasonal comparison, so the status falls back to the position in the range recorded since November 2018, and that range starts before the reservoir was filled.
Downstream, Lake Nasser's pass on July 14 measured 178.5 m, 0.2 m above its usual July level.

**Tigris and Euphrates.** Mosul's pass on August 9 measured 320.8 m, 27.4 m higher than a year earlier.
Its status is normal, because the level is now 1.6 m above what earlier years show for August.
Lake Qadisiyah behind the Haditha Dam rose 11.5 m in the 90 days to its July 11 pass and reads rising fast.

**Mekong.** Xiaowan, China's largest store on the Mekong, measured 1,222.5 m on September 13.
It had risen 34.6 m over the previous 90 days and was still 15.5 m below its usual level for September.

**Dnipro.** The Kakhovka reservoir was drained when its dam was destroyed in June 2023.
Its pass on July 30 measured 5.8 m, 10.0 m below the July level of earlier years, which include the years before the dam was destroyed.

**Dead Sea.** The pass on September 14 measured -442.4 m, a record low and 0.9 m lower than a year earlier.
The Dead Sea has fallen by about a metre a year as upstream users divert the Jordan River, so here a record low continues a long trend rather than marking a new event.

## How to read a status

Each reservoir gets one status. The rules are checked in this order:

- **No recent pass** (`no_recent_data`). The newest pass that met the quality rules is more than 150 days old. The panel keeps showing the last good level with its date.
- **Record low** or **record high**. The latest pass is the lowest or highest since the record began in late 2018. The record needs at least three years of passes and a range of at least 1 m.
- **Falling fast** or **rising fast**. Over 90 days the level moved by at least 2 m or 15% of the recorded range, whichever is larger. Where a seasonal baseline exists, the move must also exceed the usual seasonal swing by that amount, so a normal monsoon or snowmelt fill reads normal.
- **Low** or **high**. The level sits 1.5 standard deviations or more below or above the level of earlier years at the same time of year. The deviation is a robust estimate with a floor of 0.25 m. A seasonal baseline needs passes from at least three earlier years within 30 days of that date. Without one, the status uses the bottom 15% or top 15% of the recorded range.
- **Normal**. None of the above.
- **Too little history** (`insufficient_history`). The record is too short for any of these comparisons. No reservoir had this status on November 12.

The dashboard groups every status except normal, no recent pass and too little history under **Needs attention**. On November 12 that filter held 12 reservoirs.

## What the levels do not tell you

The data is 50 to 70 days behind. In the November 12 snapshot, the newest passes were 49 days old and the oldest was 307 days old.
Use it to follow change over weeks and seasons, not a flood or a release this week.
Our post on [data freshness in real-time intelligence](/blog/posts/real-time-intelligence-data-freshness/) explains how World Monitor labels sources that arrive late.

A level is not a volume.
A 1 m drop in a wide, shallow lake releases far more water than a 1 m drop in a narrow gorge reservoir. The dataset does not estimate storage.

A record means a record since late 2018, when ICESat-2 data begins.
Lake Mead's September pass is the lowest in the satellite record. It is not a claim about the lowest level in the reservoir's history.

"No recent pass" describes the reservoir, not the feed.
Five reservoirs had that status on November 12. One is Gatun Lake, which supplies the Panama Canal locks. Its newest qualifying pass was on April 19, 2026.

## Where to find it

- **Dashboard.** The Strategic Water Levels panel is on by default in [Energy Atlas](https://energy.worldmonitor.app/dashboard). On the main [World Monitor dashboard](https://www.worldmonitor.app/dashboard), add it from the panel list. Filter by **All**, **Needs attention** or **Transboundary**, and select a reservoir to see its level, its change since the previous pass and over 90 days and 12 months, and a 36-month chart.
- **Map.** Turn on the **Water Levels** layer to place every reservoir on the map, colored by status.
- **API.** `GET /api/climate/v1/list-reservoir-levels` returns the same records. The [ListReservoirLevels API reference](https://www.worldmonitor.app/docs/api-reference/climateservice/listreservoirlevels) lists the fields.
- **MCP.** The `get_reservoir_levels` tool filters by country, status or reservoir id. Set `include_series` to get each reservoir's passes over the 36 months before its latest one. The [environment and health tools reference](https://www.worldmonitor.app/docs/mcp-tools/environment-health) documents the parameters.

The [data sources guide](https://www.worldmonitor.app/docs/data-sources) has the full method, including the ATL06 rules and their validation.

## Frequently Asked Questions

**How current are the water levels?**

NASA publishes ICESat-2 inland water data 50 to 70 days after each overpass. World Monitor adds new passes daily, but the latest level for a reservoir is usually two months old or more. Each level shows the date of its pass.

**Does a record low mean the lowest level ever?**

No. It means the lowest level since the ICESat-2 record began in late 2018. Older lows from gauge records are not part of the comparison.

**Can I get reservoir storage volume?**

No. The dataset reports the height of the water surface in metres above the EGM2008 geoid. It does not convert level to volume.

**What does "No recent pass" mean?**

No pass over that reservoir met the quality rules in the last 150 days. World Monitor keeps the last good level and its date on screen so you can see how old it is.

**How accurate is a satellite level?**

At Lake Mead, 156 satellite passes from 2018 to 2026 matched the US Bureau of Reclamation gauge to a root-mean-square error of 0.052 m, with a largest error of 0.149 m. Accuracy at other reservoirs has not been measured against a gauge.
