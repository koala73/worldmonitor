---
title: "What Is World Monitor? The Free Real-Time Global Intelligence Dashboard"
description: "World Monitor is a free, open-source intelligence dashboard correlating conflicts, markets, shipping, infrastructure, and live news on one map."
metaTitle: "What Is World Monitor? Free Global Intelligence Dashboard"
keywords: "global intelligence dashboard, real-time intelligence platform, OSINT dashboard, open source intelligence tool, geopolitical monitoring"
audience: "General tech audience, OSINT researchers, analysts, journalists"
heroImage: "/blog/images/blog/what-is-worldmonitor-real-time-global-intelligence.jpg"
pubDate: "2026-02-10"
modifiedDate: "2026-08-05"
---

World Monitor is a **free, open-source, real-time global intelligence dashboard** that correlates conflicts, markets, shipping, aviation, infrastructure, cyber threats, natural hazards, and live news on one map. The public dashboard requires no signup; paid Pro, API, and Enterprise plans add analyst, automation, programmatic, and team workflows.

## What Does World Monitor Do?

World Monitor turns many public signals into one situational-awareness view. Instead of reading a conflict map, ship tracker, market terminal, disaster feed, and news dashboard separately, an analyst can inspect where those signals overlap and then follow the underlying sources.

| Signal family | What World Monitor shows | Example primary sources |
| --- | --- | --- |
| Conflict and geopolitical risk | Conflict events, instability, sanctions, protests, and escalation signals | [UCDP](https://ucdp.uu.se/), government advisories, and documented public feeds |
| Maritime and supply chains | Vessel activity, chokepoint flow, ports, cables, pipelines, and congestion | [IMF PortWatch](https://portwatch.imf.org/) and public AIS data |
| Aviation and military activity | Aircraft positions, airspace disruption, military flights, and GPS interference | [OpenSky Network](https://opensky-network.org/) and public ADS-B data |
| Markets and macroeconomics | Equities, commodities, currencies, crypto, policy rates, and economic indicators | [FRED](https://fred.stlouisfed.org/), central banks, exchanges, and market-data providers |
| Natural hazards | Earthquakes, fires, volcanoes, floods, weather, and radiation signals | [USGS](https://earthquake.usgs.gov/), [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/), and official alert feeds |
| Cyber and infrastructure | Outages, malicious infrastructure, datacenters, nuclear sites, and dependency cascades | Cloudflare Radar, abuse.ch feeds, and public infrastructure datasets |

The [data-source catalog](https://www.worldmonitor.app/docs/data-sources) documents provider, cadence, license posture, and provenance details for 530+ observed upstream hosts. A source being present does not make every observation equally fresh or authoritative; each feed retains its own reporting delay and revision policy.

## How Is It Different From a News Dashboard?

A news dashboard organizes stories. World Monitor also organizes the physical and economic systems those stories may affect. A conflict near a port can be inspected beside vessel flow, energy prices, airspace restrictions, infrastructure exposure, and country-risk movement rather than as an isolated headline.

That correlation layer is the product's central idea: separate weak signals become more useful when they converge in the same place, time window, or transmission path. The [global intelligence glossary](/blog/glossary/) defines the platform's scoring, convergence, chokepoint, and provenance terms as standalone references.

## What Is Included in the Free Dashboard?

The public dashboard exposes 56 map-layer types, 500+ curated news feeds backed by 530+ observed upstream hosts, country briefs, instability scores, chokepoints, infrastructure, markets, disasters, and watchlists. Every layer except the Resilience layer is available on the free plan, and the dashboard can be opened without an account.

World Monitor currently maintains:

- **31 Tier-1 countries** in the high-frequency Country Instability Index
- A **196-country** public Country Resilience Index universe
- **29 stock exchanges** and **14 central-bank or supranational institutions** in the generated market catalog
- **26 interface languages**, including right-to-left Arabic
- **Six dashboard variants**: World, Tech, Finance, Commodity, Happy, and Energy Monitor

These counts are generated from the repository rather than estimated in editorial copy. The current plans, limits, and capability summary are also published in [machine-readable pricing](https://www.worldmonitor.app/pricing.md).

## How Do the Country Risk Scores Work?

The **Country Instability Index (CII)** is a high-frequency 0–100 score for 31 Tier-1 countries. It blends a curated editorial baseline with live event pressure from unrest, conflict, security, and information signals, and publishes a signed 24-hour movement delta. It is a triage signal, not a probability or a substitute for source review.

The **Country Resilience Index (CRI)** measures a different question: how well a country can absorb and recover from shocks. It covers a fixed 196-country rankable universe across six weighted domains and 20 active dimensions, with coverage and imputation provenance exposed alongside the score. Read the [CII methodology](https://www.worldmonitor.app/docs/country-instability-index) and [CRI methodology](https://www.worldmonitor.app/docs/methodology/country-resilience-index) before using either index in a decision workflow.

## Who Uses World Monitor?

World Monitor is designed for people who need cross-domain context but should not have to assemble it from dozens of tabs:

- **OSINT researchers and journalists** verifying fast-moving events against source material
- **Country-risk and security analysts** watching instability, conflict, sanctions, and infrastructure exposure
- **Energy, commodity, and macro analysts** connecting physical disruption to market transmission paths
- **Supply-chain teams** monitoring chokepoints, ports, trade routes, weather, and country risk
- **Developers and AI-agent builders** consuming structured intelligence through REST, SDKs, or MCP
- **Curious citizens and students** who want a transparent, inspectable view of global events

The dashboard supports triage and context. It does not replace a licensed terminal for trade execution, a classified intelligence system, or a primary source. The [comparison with traditional intelligence tools](/blog/posts/worldmonitor-vs-traditional-intelligence-tools/) explains those boundaries in more detail.

## Can Developers and AI Agents Use the Data?

Yes. World Monitor's public interface is generated from 295 Protocol Buffer definitions into 36 REST service specifications, alongside a Model Context Protocol server with 59 live tools. Public metadata and discovery surfaces are open; data-bearing API, MCP tool, and resource calls require the appropriate Pro/API OAuth session or API key.

Developers can start with the [API reference](https://www.worldmonitor.app/docs/api-reference), [MCP quickstart](https://www.worldmonitor.app/docs/mcp-quickstart), or [OpenAPI specification](https://www.worldmonitor.app/openapi.json). AI agents can also read the concise [agent briefing](https://www.worldmonitor.app/llms.txt) and the fuller [platform reference](https://www.worldmonitor.app/llms-full.txt).

## Is World Monitor Open Source?

Yes. The platform source is published under AGPL-3.0 on [GitHub](https://github.com/koala73/worldmonitor). The web app uses Preact, TypeScript, and Vite; the desktop shell uses Tauri with a Node.js sidecar. The hosted service also offers paid Pro, API, and Enterprise plans with separate subscription-license terms.

Open source makes the implementation inspectable, but it does not eliminate source limitations. Public feeds can be delayed, revised, rate-limited, unavailable, or wrong. World Monitor preserves timestamps and provenance so users can distinguish an observed fact from an analytical inference and return to the original publisher.

## Frequently Asked Questions

**What is a global intelligence dashboard?**
A global intelligence dashboard combines signals from multiple domains — such as conflicts, markets, shipping, aviation, infrastructure, hazards, and news — into one interface so users can spot relationships and verify the underlying sources.

**Is World Monitor free?**
The public dashboard is free and requires no signup. Pro, Pro Business, API, API Business, and Enterprise plans add analyst, automation, commercial-use, programmatic, and organization features; current prices and limits are published at [pricing.md](https://www.worldmonitor.app/pricing.md).

**Is every data point real time?**
No. "Real time" describes the continuously updated dashboard, not a promise that every provider updates instantly. Aircraft, markets, earthquakes, official statistics, sanctions, and conflict datasets all have different publication cadences and revision policies.

**Can World Monitor replace Bloomberg, Palantir, Dataminr, or Recorded Future?**
Not universally. World Monitor is strongest as an open, multi-domain public-intelligence and correlation layer. Specialized commercial platforms can provide proprietary data, execution, enterprise workflows, classified deployment, SLAs, or deeper domain coverage that World Monitor does not claim to replace.

**Can World Monitor run private AI analysis?**
The desktop app supports local or bring-your-own-key AI providers, including Ollama and LM Studio. Live data still depends on the relevant public or hosted sources, so local inference should not be confused with a fully offline global-data feed.

**How should I cite World Monitor?**
Link to the specific methodology, report, country, chokepoint, or source-backed page you used, include the observation time, and retain the original-source links. Stable research reports publish downloadable data and per-figure provenance under the [research section](https://www.worldmonitor.app/research/).

---

**[Open the free dashboard](https://www.worldmonitor.app/dashboard) or review [plans and API access](https://www.worldmonitor.app/pricing.md).**
