---
title: "Embed a Live Global Intelligence Map in Any Article"
description: "World Monitor now supports a public iframe map for conflicts, earthquakes, protests, and weather, with attribution and validated embed parameters."
metaTitle: "Embed a Live Global Intelligence Map"
keywords: "embeddable map, live conflict map, earthquake map embed, geopolitical map iframe, World Monitor embed"
audience: "Journalists, publishers, researchers, analysts"
heroImage: "/blog/og/embed-live-global-map-worldmonitor.png"
pubDate: "2026-06-11"
---

Maps are most useful when they appear next to the story people are reading.

World Monitor now includes a public iframe embed for the live map. Publishers, analysts, and researchers can place a small real-time map in an article, briefing page, or internal dashboard without shipping the full World Monitor app.

```html
<iframe
  src="https://www.worldmonitor.app/embed?layers=conflicts,earthquakes,weather&center=20,0&zoom=1&theme=dark&variant=full"
  title="World Monitor live map"
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
  style="width:100%;height:420px;border:0;display:block"
  allowfullscreen
></iframe>
```

## What the Embed Includes

The first version is intentionally focused on public map layers:

- Conflicts
- Earthquakes
- Protests
- Weather

The embed accepts `layers`, `center`, `zoom`, `theme`, and `variant` query parameters. Unknown layers are ignored, and premium or authenticated surfaces are not exposed through the iframe.

## What It Does Not Include

This is a map embed, not a full dashboard embed. It does not load panels, account state, saved preferences, premium layers, or notification state. That keeps it lightweight enough for article pages and safe enough for anonymous cross-origin distribution.

## Publisher Examples

For a regional conflict story:

```html
https://www.worldmonitor.app/embed?layers=conflicts,protests&center=31,35&zoom=4&theme=dark&variant=full
```

For a natural disaster live blog:

```html
https://www.worldmonitor.app/embed?layers=earthquakes,weather&center=37,-122&zoom=5&theme=light&variant=full
```

For an energy-security briefing:

```html
https://www.worldmonitor.app/embed?layers=conflicts,weather&center=26,51&zoom=4&theme=dark&variant=energy
```

Every embed includes a permanent attribution link back to World Monitor with campaign context so traffic can be traced to the host page.

The easiest way to create a snippet is to open the dashboard, move the map to the view you want, and use the **Embed** button in the header.
