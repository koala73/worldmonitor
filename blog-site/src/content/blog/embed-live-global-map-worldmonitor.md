---
title: "Embed a Live Global Intelligence Map in Any Article"
description: "World Monitor now supports a public iframe map for conflicts, earthquakes, protests, and weather, with attribution and validated embed parameters."
metaTitle: "Embed a Live Global Intelligence Map | World Monitor"
keywords: "embeddable map, live conflict map, earthquake map embed, geopolitical map iframe, World Monitor embed"
audience: "Journalists, publishers, researchers, analysts"
heroImage: "/blog/images/blog/embed-live-global-map-worldmonitor.jpg"
pubDate: "2026-06-11"
modifiedDate: "2026-07-22"
---

Maps are most useful when they appear next to the story people are reading. A live conflict map, earthquake map, or weather-risk map can turn a static explainer into something readers can revisit as conditions change.

World Monitor now includes a public iframe embed for the live map. Publishers, analysts, and researchers can place a small real-time map in an article, briefing page, or internal dashboard without shipping the full World Monitor app. The same source layers are used across the [real-time conflict tracker](/blog/posts/track-global-conflicts-in-real-time/), [natural disaster monitor](/blog/posts/natural-disaster-monitoring-earthquakes-fires-volcanoes/), and [supply-chain risk workflows](/blog/posts/monitor-global-supply-chains-and-commodity-disruptions/).

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

## Why Use a Live Map Instead of a Screenshot?

Screenshots are easy, but they go stale immediately. A live intelligence map is better when the reader needs to understand where something is happening and whether the situation is still active.

Use a live map when:

- A conflict, protest, storm, quake, or outage may keep changing after publication.
- Readers need geographic context rather than only a written summary.
- Your newsroom, research note, or internal briefing needs a reusable visual module.
- You want one source of truth instead of manually replacing static images.

Use a screenshot when the map is only historical evidence, when your CMS blocks iframes, or when you need a fixed visual for print or social distribution.

## SEO and Performance Checklist

Iframe embeds can be search-friendly when the surrounding page carries the context. Treat the map as supporting evidence, not the whole article.

Before publishing:

- Put the target topic in the page title and H1, such as "live conflict map" or "earthquake map."
- Add a paragraph before the iframe explaining what the reader should look for.
- Use a descriptive iframe `title` so screen readers understand the embedded map.
- Keep `loading="lazy"` unless the map is the main first-screen experience.
- Set a fixed height to avoid layout shift.
- Link to the related World Monitor layer or source article for readers who want the full dashboard.

The embed is intentionally lightweight: no panels, no saved account state, no premium layers, and no notification preferences. That keeps article pages faster and avoids exposing authenticated surfaces.

## Layer Recipes

Start with the fewest layers that answer the story. Too many overlays make the map harder to read.

| Story type | Suggested layers | Example use |
|---|---|---|
| Conflict update | `conflicts,protests` | Show active unrest and conflict context around a city or border |
| Natural disaster | `earthquakes,weather` | Add quake or weather context to a live blog |
| Regional risk brief | `conflicts,earthquakes,weather` | Give executives a broad map view without the full dashboard |
| Energy security | `conflicts,weather` with `variant=energy` | Frame route risk near Gulf, Red Sea, or Black Sea exposure |

If the reader needs deeper source evidence, pair the map with the [OSINT verification workflow](/blog/posts/verify-breaking-news-osint-workflow-journalists/) or expose the same signals programmatically through the [WorldMonitor MCP server](/blog/posts/worldmonitor-mcp-server-ai-agents-real-time-intelligence/).

## Standards and implementation references

The embed follows the HTML standard's [`iframe` element](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#the-iframe-element), while WorldMonitor's public implementation remains inspectable in the [open-source embed module](https://github.com/koala73/worldmonitor/tree/main/src/embed).

## Frequently Asked Questions

**Can I embed the World Monitor map on a public article?**
Yes. The public iframe is designed for articles, briefing pages, research notes, and internal dashboards that need a lightweight live map.

**Which layers can I use in the embed?**
The current public embed supports conflicts, earthquakes, protests, and weather. Premium and authenticated layers are ignored by the iframe.

**Does the iframe expose user or account data?**
No. The embed does not load account state, saved preferences, notification settings, or premium surfaces.

**How should I optimize an embedded map for SEO?**
Use the map alongside explanatory text, descriptive headings, a useful iframe title, and internal links to related coverage. Search engines need the surrounding article to understand the topic.
