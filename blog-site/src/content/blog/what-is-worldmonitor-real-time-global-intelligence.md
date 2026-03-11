---
title: "What Is WorldMonitor? The Free Real-Time Global Intelligence Dashboard"
description: "WorldMonitor is a free, open-source global intelligence dashboard that aggregates news, markets, geopolitical data, and infrastructure monitoring into one unified view. No login required."
metaTitle: "WorldMonitor: Free Real-Time Global Intelligence Dashboard | Open Source OSINT"
keywords: "global intelligence dashboard, real-time intelligence platform, OSINT dashboard, open source intelligence tool, geopolitical monitoring"
audience: "General tech audience, OSINT researchers, analysts, journalists"
pubDate: "2026-02-10"
---

Imagine opening 100 browser tabs every morning: one for Reuters, another for flight tracking, a third for earthquake monitors, a fourth for stock markets, a fifth for military ship positions. Now imagine replacing all of them with a single dashboard.

That's WorldMonitor.

## A Bloomberg Terminal for the Rest of Us

WorldMonitor is a **free, open-source, real-time global intelligence dashboard** that pulls together news, financial markets, military movements, natural disasters, cyber threats, and geopolitical risk scoring into one interactive map.

It's the kind of tool that used to be locked behind six-figure enterprise contracts. Now it's available to anyone with a browser. No login. No paywall. No data collection.

## What You See When You Open WorldMonitor

The first thing you notice is the globe. A 3D interactive map powered by globe.gl and Three.js, dotted with live data points: conflict zones pulsing red, military bases marked by operator, undersea cables tracing the ocean floor, and ADS-B aircraft positions updating in real time.

On the left, a panel system lets you pull up any combination of 45+ data layers:

- **Geopolitical:** Active conflicts, protests, hotspot escalation scores, strategic theater posture assessments across 9 operational theaters (Taiwan Strait, Persian Gulf, Baltic, and more)
- **Military:** 210+ military bases, live flight tracking, naval vessel positions merged with USNI fleet reports, GPS jamming detection zones
- **Infrastructure:** Nuclear facilities, AI datacenters (111 mapped), undersea cables, pipelines, strategic ports (83), and airports (107)
- **Financial:** 92 stock exchanges, 13 central bank policy trackers, commodity prices, Fear & Greed Index, Bitcoin ETF flows, stablecoin peg monitoring
- **Natural Disasters:** USGS earthquakes (M4.5+), NASA satellite fire detection, volcanic activity, flood alerts
- **Cyber Threats:** Feodo Tracker botnet C2 servers, URLhaus malicious URLs, internet outage detection via Cloudflare Radar

Every data point is sourced from public, verifiable feeds: 435+ RSS sources, government APIs, satellite data, and open maritime/aviation transponders.

## Five Dashboards, One Codebase

WorldMonitor isn't one dashboard. It's five:

| Dashboard | Focus | URL |
|-----------|-------|-----|
| **World Monitor** | Geopolitics, conflicts, military, infrastructure | worldmonitor.app |
| **Tech Monitor** | AI labs, startups, cybersecurity, cloud infrastructure | tech.worldmonitor.app |
| **Finance Monitor** | Markets, central banks, forex, Gulf FDI | finance.worldmonitor.app |
| **Commodity Monitor** | Mining, metals, energy, supply chain disruption | commodity.worldmonitor.app |
| **Happy Monitor** | Good news, breakthroughs, conservation, renewable energy | happy.worldmonitor.app |

Switch between them with a single click. Each variant curates panels and layers for its specific audience while sharing the same underlying intelligence engine.

## AI That Runs on Your Machine

Here's where WorldMonitor gets interesting for privacy-conscious users. The platform includes a **4-tier AI fallback chain**:

1. **Local LLMs** (Ollama or LM Studio) for fully offline, private analysis
2. **Groq** (Llama 3.1 8B) for fast cloud inference
3. **OpenRouter** as a fallback provider
4. **Browser-based T5** (Transformers.js) that runs entirely in your browser via Web Workers

This means you can generate intelligence briefs, classify threats, and run sentiment analysis without sending a single byte to external servers. The desktop app (built with Tauri for macOS, Windows, and Linux) takes this further with OS keychain integration and a local Node.js sidecar for complete offline operation.

## The Country Intelligence Dossier

Click any country on the map and you get a full intelligence dossier:

- **Country Instability Index (CII):** A real-time 0-100 score calculated from baseline risk (40%), unrest indicators (20%), security events (20%), and information velocity (20%)
- **AI-generated analysis** with inline citations from current headlines
- **Active signals:** Protests, conflicts, natural disasters, and cyber incidents
- **7-day timeline:** What happened this week
- **Prediction markets:** What Polymarket bettors think happens next
- **Infrastructure exposure:** Pipelines, cables, and datacenters within 600km

## Who Uses WorldMonitor?

The dashboard serves a surprisingly wide audience:

- **OSINT researchers** who need a unified view instead of 100 tabs
- **Financial analysts** tracking macro signals across 92 exchanges
- **Journalists** who need instant context for breaking stories
- **Supply chain managers** monitoring disruption risk at ports and commodity hubs
- **Policy researchers** studying government spending and trade policy
- **Developers** who want to build on top of open, typed APIs (92 proto files, 22 services)

## Available Everywhere

WorldMonitor works as:

- A **web app** at worldmonitor.app (no install needed)
- A **Progressive Web App** you can install on any device with offline map caching
- A **native desktop app** via Tauri for macOS, Windows, and Linux
- Fully **mobile-optimized** with touch gestures, pinch-to-zoom, and bottom-sheet panels

It supports **21 languages** including Arabic (with full RTL layout), Japanese, Chinese, and all major European languages. RSS feeds are localized per language, and AI analysis can be generated in your preferred language.

## Open Source, No Strings

WorldMonitor is released under AGPL-3.0. The entire codebase, every data source, every algorithm, is open for inspection, contribution, and self-hosting. There's no "enterprise tier" waiting behind the free version. This is the product.

The tech stack is modern and approachable: React + TypeScript + Vite on the frontend, Vercel Edge Functions for the API layer, and Tauri for the desktop app.

---

**Try WorldMonitor now at [worldmonitor.app](https://worldmonitor.app). No signup required.**
