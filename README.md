# World Monitor

**Real-time global intelligence dashboard** — AI-powered news aggregation, geopolitical monitoring, and infrastructure tracking in a unified situational awareness interface.

[![GitHub stars](https://img.shields.io/github/stars/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/network/members)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/koala73/worldmonitor)](https://github.com/koala73/worldmonitor/commits/main)
[![Latest release](https://img.shields.io/github/v/release/koala73/worldmonitor?style=flat)](https://github.com/koala73/worldmonitor/releases/latest)

<p align="center">
  <a href="https://worldmonitor.app"><img src="https://img.shields.io/badge/Web_App-worldmonitor.app-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Web App"></a>&nbsp;
  <a href="https://tech.worldmonitor.app"><img src="https://img.shields.io/badge/Tech_Variant-tech.worldmonitor.app-0891b2?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Tech Variant"></a>&nbsp;
  <a href="https://finance.worldmonitor.app"><img src="https://img.shields.io/badge/Finance_Variant-finance.worldmonitor.app-059669?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Finance Variant"></a>&nbsp;
  <a href="https://commodity.worldmonitor.app"><img src="https://img.shields.io/badge/Commodity_Variant-commodity.worldmonitor.app-b45309?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Commodity Variant"></a>&nbsp;
  <a href="https://happy.worldmonitor.app"><img src="https://img.shields.io/badge/Happy_Variant-happy.worldmonitor.app-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Happy Variant"></a>
</p>

<p align="center">
  <a href="https://worldmonitor.app/api/download?platform=windows-exe"><img src="https://img.shields.io/badge/Download-Windows_(.exe)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=macos-arm64"><img src="https://img.shields.io/badge/Download-macOS_Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS ARM"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=macos-x64"><img src="https://img.shields.io/badge/Download-macOS_Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=linux-appimage"><img src="https://img.shields.io/badge/Download-Linux_(.AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux"></a>
</p>

<p align="center">
  <a href="./docs/DOCUMENTATION.md"><strong>Full Documentation</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>All Releases</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## Why World Monitor?

| Problem                            | Solution                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| News scattered across 100+ sources | **Single unified dashboard** with 435+ curated feeds across 15 categories                                  |
| No geospatial context for events   | **Interactive map** with 45 toggleable data layers and CII country risk heatmap                             |
| Information overload               | **AI-synthesized briefs** with focal point detection and local LLM support                                 |
| Crypto/macro signal noise          | **7-signal market radar** with composite BUY/CASH verdict                                                  |
| Expensive OSINT tools ($$$)        | **100% free & open source**                                                                                |
| Static news feeds                  | **Real-time updates** with live video streams and AI-powered deductions                                    |
| Cloud-dependent AI tools           | **Run AI locally** with Ollama/LM Studio — no API keys, no data leaves your machine. Opt-in **Headline Memory** builds a local semantic index of every headline for RAG-powered queries |
| Web-only dashboards                | **Native desktop app** (Tauri) for macOS, Windows, and Linux + installable PWA with offline map support    |
| Flat 2D maps                       | **Dual map engine** — photorealistic 3D globe (globe.gl + Three.js) and WebGL flat map (deck.gl) with 45 toggleable data layers, runtime-switchable |
| English-only OSINT tools           | **21 languages** with native-language RSS feeds, AI-translated summaries, and RTL support for Arabic       |
| Siloed financial data              | **Finance variant** with 92 stock exchanges, 19 financial centers, 13 central banks, BIS data, WTO trade policy, and Gulf FDI tracking |
| Undocumented, fragile APIs         | **Proto-first API contracts** — 22 typed services with auto-generated clients, servers, and OpenAPI docs   |

---

## Live Demos

| Variant             | URL                                                          | Focus                                            |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| **World Monitor**   | [worldmonitor.app](https://worldmonitor.app)                 | Geopolitics, military, conflicts, infrastructure |
| **Tech Monitor**    | [tech.worldmonitor.app](https://tech.worldmonitor.app)       | Startups, AI/ML, cloud, cybersecurity            |
| **Finance Monitor** | [finance.worldmonitor.app](https://finance.worldmonitor.app) | Global markets, trading, central banks, Gulf FDI |
| **Commodity Monitor** | [commodity.worldmonitor.app](https://commodity.worldmonitor.app) | Mining, metals, energy commodities, critical minerals |
| **Happy Monitor**   | [happy.worldmonitor.app](https://happy.worldmonitor.app)     | Good news, positive trends, uplifting stories    |

All five variants run from a single codebase — switch between them with one click via the header bar.

---

## Key Features

### Maps & Visualization

- **Dual Map Engine** — 3D globe (globe.gl + Three.js) and WebGL flat map (deck.gl), runtime-switchable with 45 shared data layers. [Details →](./docs/MAP_ENGINE.md)
- **45 toggleable data layers** — conflicts, bases, cables, pipelines, flights, vessels, protests, fires, earthquakes, datacenters, and more across all variants
- **8 regional presets** — Global, Americas, Europe, MENA, Asia, Africa, Oceania, Latin America with time filtering (1h–7d)
- **CII choropleth heatmap** — five-stop color gradient paints every country by instability score on both map engines
- **URL state sharing** — map center, zoom, active layers, and time range encoded in shareable URLs

### AI & Intelligence

- **World Brief** — LLM-synthesized summary with 4-tier fallback: Ollama (local) → Groq → OpenRouter → browser T5. [Details →](./docs/AI_INTELLIGENCE.md)
- **AI Deduction & Forecasting** — free-text geopolitical analysis grounded in live headlines. [Details →](./docs/AI_INTELLIGENCE.md#ai-deduction--forecasting)
- **Headline Memory (RAG)** — opt-in browser-local semantic index using ONNX embeddings in IndexedDB. [Details →](./docs/AI_INTELLIGENCE.md#client-side-headline-memory-rag)
- **Threat Classification** — instant keyword classifier with async ML and LLM override. [Details →](./docs/AI_INTELLIGENCE.md#threat-classification-pipeline)
- **Country Brief Pages** — full-page intelligence dossiers with CII scores, AI analysis, timelines, and prediction markets. [Details →](./docs/AI_INTELLIGENCE.md#country-brief-pages)

### Data Layers

<details>
<summary><strong>Geopolitical</strong> — conflicts, hotspots, protests, disasters, sanctions, cyber IOCs, GPS jamming, Iran events</summary>

[Full details →](./docs/DATA_SOURCES.md#data-layers)
</details>

<details>
<summary><strong>Military & Strategic</strong> — 210+ bases, live flights (ADS-B), naval vessels (AIS), nuclear facilities, spaceports, orbital surveillance</summary>

[Full details →](./docs/DATA_SOURCES.md#data-layers) · [Orbital Surveillance →](./docs/ORBITAL_SURVEILLANCE.md)
</details>

<details>
<summary><strong>Infrastructure</strong> — undersea cables, pipelines, 111 AI datacenters, 83 strategic ports, 107 airports, trade routes</summary>

[Full details →](./docs/DATA_SOURCES.md#data-layers)
</details>

<details>
<summary><strong>Market & Crypto</strong> — 7-signal macro radar, market watchlist, Gulf economies, crypto, prediction markets, stablecoins, ETF flows</summary>

[Full details →](./docs/DATA_SOURCES.md#data-layers)
</details>

<details>
<summary><strong>Tech Ecosystem</strong> — company HQs, startup hubs, cloud regions, accelerators, conferences</summary>

[Full details →](./docs/DATA_SOURCES.md#data-layers)
</details>

<details>
<summary><strong>Finance & Markets</strong> — 92 stock exchanges, 19 financial centers, 13 central banks, BIS data, WTO trade policy, Gulf FDI</summary>

[Full details →](./docs/FINANCE_DATA.md)
</details>

### Live News & Video

- **435+ RSS feeds** across geopolitics, defense, energy, tech, and finance with server-side aggregation (95% fewer edge invocations). [Details →](./docs/DATA_SOURCES.md#server-side-aggregation)
- **30+ live video streams** — Bloomberg, Sky News, Al Jazeera, and more with HLS native streaming, idle-aware playback, and fullscreen mode
- **22 live webcams** — geopolitical hotspot streams across 5 regions with Iran/Attacks dedicated tab
- **Custom keyword monitors** — user-defined alerts with word-boundary matching and auto-coloring

### Scoring & Detection

- **Country Instability Index (CII)** — real-time stability scores using weighted multi-signal blend across 23 tier-1 nations + universal scoring for all countries. [Details →](./docs/ALGORITHMS.md#country-instability-index-cii)
- **Hotspot Escalation** — dynamic scoring blending news activity, CII, geo-convergence, and military signals. [Details →](./docs/ALGORITHMS.md#hotspot-escalation-scoring)
- **Strategic Risk Score** — composite geopolitical risk from convergence, CII, infrastructure, theater, and breaking news. [Details →](./docs/ALGORITHMS.md#strategic-risk-score-algorithm)
- **Signal Aggregation** — multi-source fusion with temporal baseline anomaly detection (Welford's algorithm). [Details →](./docs/ALGORITHMS.md#signal-aggregation)
- **Cross-Stream Correlation** — 14 signal types detecting patterns across news, markets, military, and predictions. [Details →](./docs/ALGORITHMS.md#cross-stream-correlation-engine)

### Finance & Markets

- **Macro Signal Analysis** — 7-signal market radar with composite BUY/CASH verdict. [Details →](./docs/FINANCE_DATA.md#macro-signal-analysis-market-radar)
- **Gulf FDI** — 64 Saudi/UAE investments plotted globally. [Details →](./docs/FINANCE_DATA.md#gulf-fdi-investment-database)
- **Stablecoin & BTC ETF** — peg health monitoring and spot ETF flow tracking. [Details →](./docs/FINANCE_DATA.md)
- **Oil & Energy** — WTI/Brent prices, production, inventory via EIA. [Details →](./docs/FINANCE_DATA.md#oil--energy-analytics)
- **BIS & WTO** — central bank rates, trade policy intelligence. [Details →](./docs/FINANCE_DATA.md)
- **Premium Stock Analysis** — analysis engine with stored history, backtesting, and daily market brief. [Details →](./docs/PREMIUM_FINANCE.md)

### Desktop & Mobile

- **Native desktop app** (Tauri) — macOS, Windows, Linux with OS keychain, local sidecar, and cloud fallback. [Details →](./docs/DESKTOP_APP.md)
- **Progressive Web App** — installable with offline map support (CacheFirst tiles, 500-tile cap)
- **Mobile-optimized map** — touch pan with inertia, pinch-to-zoom, bottom-sheet popups, GPS centering
- **Responsive layout** — ultra-wide L-shaped layout on 2000px+, collapsible panels, mobile search sheet

### Platform Features

- **21 languages** — lazy-loaded bundles with native-language RSS feeds, AI translation, and RTL support
- **Cmd+K command palette** — fuzzy search across 24 result types, layer presets, ~250 country commands
- **Proto-first API contracts** — 92 proto files, 22 services, auto-generated TypeScript + OpenAPI docs
- **Dark/light theme** — persistent toggle with 20+ semantic color variables
- **Story sharing** — intelligence briefs exportable to Twitter/X, LinkedIn, WhatsApp, Telegram, Reddit with OG images

---

## How It Works

### AI & Analysis Pipeline

**AI Summarization** — 4-tier provider chain (Ollama → Groq → OpenRouter → browser T5) with headline deduplication, variant-aware prompting, and Redis caching (24h TTL). [Details →](./docs/AI_INTELLIGENCE.md#ai-summarization-chain)

**AI Deduction** — interactive geopolitical forecasting grounded in 15 most recent headlines, cached 1 hour by query hash. [Details →](./docs/AI_INTELLIGENCE.md#ai-deduction--forecasting)

**Headline Memory** — opt-in ONNX-powered RAG system storing 5,000 headline vectors in IndexedDB for semantic search. [Details →](./docs/AI_INTELLIGENCE.md#client-side-headline-memory-rag)

**Threat Classification** — three-stage pipeline: instant keyword → browser ML → batched LLM, each improving confidence. [Details →](./docs/AI_INTELLIGENCE.md#threat-classification-pipeline)

**Browser-Side ML** — Transformers.js runs NER, sentiment, and embeddings entirely in the browser via Web Workers. [Details →](./docs/AI_INTELLIGENCE.md#browser-side-ml-pipeline)

### Scoring Algorithms

**Country Instability Index** — 0–100 score from baseline risk (40%), unrest (20%), security (20%), and information velocity (20%), with conflict-zone floors and travel advisory boosts. [Details →](./docs/ALGORITHMS.md#country-instability-index-cii)

**Hotspot Escalation** — blends news (35%), CII (25%), geo-convergence (25%), and military (15%) with 48-hour trend regression. [Details →](./docs/ALGORITHMS.md#hotspot-escalation-scoring)

**Strategic Theater Posture** — 9 operational theaters assessed for NORMAL → ELEVATED → CRITICAL based on aircraft, strike capability, naval presence, and regional CII. [Details →](./docs/ALGORITHMS.md#strategic-theater-posture-assessment)

**Geographic Convergence** — 1°×1° spatial binning detects 3+ event types co-occurring within 24 hours. [Details →](./docs/ALGORITHMS.md#geographic-convergence-detection)

**Trending Keywords** — 2-hour rolling window vs 7-day baseline flags surging terms with CVE/APT extraction. [Details →](./docs/ALGORITHMS.md#trending-keyword-spike-detection)

### Data Collection

**435+ RSS feeds** with 4-tier source credibility, server-side aggregation, and per-feed circuit breakers. [Details →](./docs/DATA_SOURCES.md)

**Military tracking** — ADS-B flights, AIS vessels, USNI fleet reports, Wingbits aircraft enrichment. [Details →](./docs/DATA_SOURCES.md#intelligence-feeds)

**Telegram OSINT** — 26 channels via MTProto with dedup and topic classification. [Details →](./docs/DATA_SOURCES.md#telegram-osint-intelligence-feed)

**OREF rocket alerts** — Israel Home Front Command sirens via residential proxy. [Details →](./docs/DATA_SOURCES.md#oref-rocket-alert-integration)

**Prediction markets** — Polymarket contracts with 4-tier fetch and country matching. [Details →](./docs/DATA_SOURCES.md#prediction-markets)

### Architecture Overview

**Vanilla TypeScript** — no framework, direct DOM manipulation, custom Panel/VirtualList classes. The entire app shell weighs less than React's runtime. [Details →](./docs/ARCHITECTURE.md)

**Proto-first APIs** — 22 typed service domains with auto-generated clients, servers, and OpenAPI docs. [Details →](./docs/ARCHITECTURE.md#proto-first-api-contracts)

**Edge functions** — 60+ Vercel Edge Functions split into per-domain thin entry points (~85% cold-start reduction). [Details →](./docs/ARCHITECTURE.md#edge-functions--deployment)

**3-tier caching** — in-memory → Redis → upstream with cache stampede prevention and stale-on-error fallback. [Details →](./docs/ARCHITECTURE.md#bandwidth--caching)

**Bootstrap hydration** — 15 Redis keys pre-fetched in a single pipeline call for sub-second first render. [Details →](./docs/ARCHITECTURE.md#bootstrap-hydration)

**SmartPollLoop** — adaptive refresh with exponential backoff, hidden-tab throttle, and circuit breaker integration. [Details →](./docs/ARCHITECTURE.md#smartpollloop--adaptive-data-refresh)

---

## Multi-Variant Architecture

A single codebase produces five specialized dashboards, each with distinct feeds, panels, map layers, and branding:

| Aspect                | World Monitor                                        | Tech Monitor                                    | Finance Monitor                                  | Commodity Monitor                                         | Happy Monitor                                         |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| **Domain**            | worldmonitor.app                                     | tech.worldmonitor.app                           | finance.worldmonitor.app                         | commodity.worldmonitor.app                                | happy.worldmonitor.app                                |
| **Focus**             | Geopolitics, military, conflicts                     | AI/ML, startups, cybersecurity                  | Markets, trading, central banks                  | Mining, metals, energy commodities, critical minerals     | Good news, conservation, human progress               |
| **RSS Feeds**         | 15 categories, 200+ feeds (politics, MENA, Africa, think tanks) | 21 categories, 152 feeds (AI, VC blogs, startups, GitHub) | 14 categories, 55 feeds (forex, bonds, commodities, IPOs) | 10 categories, 50+ feeds (gold/silver, energy, mining, critical minerals, base metals) | 5 categories, 21 positive-news sources (GNN, Positive.News, Upworthy) |
| **Panels**            | 45 (strategic posture, CII, cascade, trade policy, airline intel, predictions) | 28 (AI labs, unicorns, accelerators, tech readiness) | 27 (forex, bonds, derivatives, trade policy, gulf economies) | 16 (live prices, sector heatmap, gold/silver, energy, mining, critical minerals, base metals, supply chain) | 10 (good news, breakthroughs, conservation, renewables, giving) |
| **Unique Map Layers** | Military bases, nuclear facilities, hotspots         | Tech HQs, cloud regions, startup hubs           | Stock exchanges, central banks, Gulf investments | Mine sites, processing plants, commodity ports, commodity hubs, pipelines, trade routes | Positive events, kindness, species recovery, renewables |
| **Desktop App**       | World Monitor.app / .exe / .AppImage                 | Tech Monitor.app / .exe / .AppImage             | Finance Monitor.app / .exe / .AppImage           | (web-only)                                                | (web-only)                                            |

Single-deployment consolidation — all five variants serve from one Vercel deployment, determined by hostname. Build-time `VITE_VARIANT` tree-shakes unused data. Runtime variant selector in the header bar.

---

## Programmatic API Access

Every data endpoint is accessible programmatically via `api.worldmonitor.app`. The API uses the same edge functions that power the dashboard, with the same caching and rate limiting:

```bash
# Fetch market quotes
curl -s 'https://api.worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL,MSFT,GOOGL'

# Get airport delays
curl -s 'https://api.worldmonitor.app/api/aviation/v1/list-airport-delays'

# Fetch climate anomalies
curl -s 'https://api.worldmonitor.app/api/climate/v1/list-climate-anomalies'

# Get earthquake data
curl -s 'https://api.worldmonitor.app/api/seismology/v1/list-earthquakes'

# Company enrichment (GitHub, SEC filings, HN mentions)
curl -s 'https://api.worldmonitor.app/api/enrichment/company?domain=stripe.com'

# Company signal discovery (funding, hiring, exec changes)
curl -s 'https://api.worldmonitor.app/api/enrichment/signals?company=Stripe&domain=stripe.com'
```

All 22 service domains are available as REST endpoints following the pattern `POST /api/{domain}/v1/{rpc-name}`. GET requests with query parameters are supported for read-only RPCs. Responses include `X-Cache` headers (`HIT`, `REDIS-HIT`, `MISS`) for cache debugging and `Cache-Control` headers for CDN integration.

> **Note**: Use `api.worldmonitor.app`, not `worldmonitor.app` — the main domain requires browser origin headers and returns 403 for programmatic access.

---

## Security Model

| Layer                          | Mechanism                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CORS origin allowlist**      | Only `worldmonitor.app`, `tech.worldmonitor.app`, `finance.worldmonitor.app`, and `localhost:*` can call API endpoints. All others receive 403. Implemented in `api/_cors.js`.                                                                     |
| **RSS domain allowlist**       | The RSS proxy only fetches from explicitly listed domains (~90+). Requests for unlisted domains are rejected with 403.                                                                                                                             |
| **Railway domain allowlist**   | The Railway relay has a separate, smaller domain allowlist for feeds that need the alternate origin.                                                                                                                                               |
| **API key isolation**          | All API keys live server-side in Vercel environment variables. The browser never sees Groq, OpenRouter, ACLED, Finnhub, or other credentials.                                                                                                      |
| **Input sanitization**         | User-facing content passes through `escapeHtml()` (prevents XSS) and `sanitizeUrl()` (blocks `javascript:` and `data:` URIs). URLs use `escapeAttr()` for attribute context encoding.                                                              |
| **Query parameter validation** | API endpoints validate input formats (e.g., stablecoin coin IDs must match `[a-z0-9-]+`, bounding box params are numeric).                                                                                                                         |
| **IP rate limiting**           | AI endpoints use Upstash Redis-backed rate limiting to prevent abuse of Groq/OpenRouter quotas.                                                                                                                                                    |
| **Desktop sidecar auth**       | The local API sidecar requires a per-session `Bearer` token generated at launch. The token is stored in Rust state and injected into the sidecar environment — only the Tauri frontend can retrieve it via IPC. Health check endpoints are exempt. |
| **OS keychain storage**        | Desktop API keys are stored in the operating system's credential manager (macOS Keychain, Windows Credential Manager), never in plaintext files or environment variables on disk.                                                                  |
| **SSRF protection**            | Two-phase URL validation: protocol allowlist, private IP rejection, DNS rebinding detection, and TOCTOU-safe address pinning.                                                                                                                     |
| **IPC window hardening**       | All sensitive Tauri IPC commands gate on `require_trusted_window()` with a `TRUSTED_WINDOWS` allowlist.                                                                                                                                            |
| **Bot protection middleware**  | Edge Middleware blocks crawlers from `/api/*` routes. Social preview bots are selectively allowed on `/api/story` and `/api/og-story`.                                                                                                             |

---

## Regression Testing

The test suite includes **30 test files** with **554 individual test cases** across **147 describe blocks**, covering server handlers, caching behavior, data integrity, and map overlays.

**Unit & integration tests** (`npm test`) validate:

| Area | Test Files | Coverage |
| --- | --- | --- |
| **Server handlers** | `server-handlers`, `supply-chain-handlers`, `supply-chain-v2` | All 22 proto service handler imports, route registration, response schemas |
| **Caching** | `redis-caching`, `route-cache-tier`, `flush-stale-refreshes` | Cache key construction, TTL tiers, stale refresh coalescing, stampede prevention |
| **Data integrity** | `bootstrap`, `deploy-config`, `edge-functions` | Bootstrap key sync between `cache-keys.ts` and `bootstrap.js`, all 57 edge function self-containment (no `../server/` imports), version sync across package.json/tauri.conf.json/Cargo.toml |
| **Intelligence** | `military-classification`, `clustering`, `insights-loader`, `summarize-reasoning` | Military confidence scoring, news clustering algorithms, AI brief generation, LLM reasoning chain parsing |
| **Map & geo** | `countries-geojson`, `globe-2d-3d-parity`, `map-locale`, `geo-keyword-matching` | GeoJSON polygon validity, flat/globe layer parity, locale-aware map labels, 217-hub keyword matching |
| **Protocols** | `oref-proxy`, `oref-locations`, `oref-breaking`, `live-news-hls` | OREF alert parsing, 1480 Hebrew→English location translations, HLS stream detection |
| **Circuit breakers** | `hapi-gdelt-circuit-breakers`, `tech-readiness-circuit-breakers`, `smart-poll-loop` | Per-source failure isolation, adaptive backoff, hidden-tab throttling |
| **Data sources** | `gulf-fdi-data`, `ttl-acled-ais-guards`, `urlState` | Gulf FDI coordinate validation, ACLED/AIS TTL guards, URL state encoding/decoding |

**E2E map tests** use Playwright with the map harness (`/tests/map-harness.html`) for overlay behavior validation.

---

## Quick Start

```bash
# Clone and run
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
vercel dev       # Runs frontend + all 60+ API edge functions
```

Open [http://localhost:3000](http://localhost:3000)

> **Note**: `vercel dev` requires the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`). If you use `npm run dev` instead, only the frontend starts — news feeds and API-dependent panels won't load. See [Self-Hosting](#self-hosting) for details.

### Environment Variables (Optional)

The dashboard works without any API keys — panels for unconfigured services simply won't appear. For full functionality, copy the example file and fill in the keys you need:

```bash
cp .env.example .env.local
```

The `.env.example` file documents every variable with descriptions and registration links, organized by deployment target (Vercel vs Railway). Key groups:

| Group             | Variables                                                                  | Free Tier                                  |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| **AI (Local)**    | `OLLAMA_API_URL`, `OLLAMA_MODEL`                                           | Free (runs on your hardware)               |
| **AI (Cloud)**    | `GROQ_API_KEY`, `OPENROUTER_API_KEY`                                       | 14,400 req/day (Groq), 50/day (OpenRouter) |
| **Cache**         | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                       | 10K commands/day                           |
| **Markets**       | `FINNHUB_API_KEY`, `FRED_API_KEY`, `EIA_API_KEY`                           | All free tier                              |
| **Tracking**      | `WINGBITS_API_KEY`, `AISSTREAM_API_KEY`                                    | Free                                       |
| **Geopolitical**  | `ACLED_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `NASA_FIRMS_API_KEY`         | Free for researchers                       |
| **Relay**         | `WS_RELAY_URL`, `VITE_WS_RELAY_URL`, `OPENSKY_CLIENT_ID/SECRET`            | Self-hosted                                |
| **UI**            | `VITE_VARIANT`, `VITE_MAP_INTERACTION_MODE` (`flat` or `3d`, default `3d`) | N/A                                        |
| **Observability** | `VITE_SENTRY_DSN` (optional, empty disables reporting)                     | N/A                                        |

See [`.env.example`](./.env.example) for the complete list with registration links.

---

## Self-Hosting

World Monitor relies on **60+ Vercel Edge Functions** in the `api/` directory for RSS proxying, data caching, and API key isolation. Running `npm run dev` alone starts only the Vite frontend — the edge functions won't execute, and most panels (news feeds, markets, AI summaries) will be empty.

### Option 1: Deploy to Vercel (Recommended)

The simplest path — Vercel runs the edge functions natively on their free tier:

```bash
npm install -g vercel
vercel          # Follow prompts to link/create project
```

Add your API keys in the Vercel dashboard under **Settings → Environment Variables**, then visit your deployment URL. The free Hobby plan supports all 60+ edge functions.

### Option 2: Local Development with Vercel CLI

To run everything locally (frontend + edge functions):

```bash
npm install -g vercel
cp .env.example .env.local   # Add your API keys
vercel dev                   # Starts on http://localhost:3000
```

> **Important**: Use `vercel dev` instead of `npm run dev`. The Vercel CLI emulates the edge runtime locally so all `api/` endpoints work. Plain `npm run dev` only starts Vite and the API layer won't be available.

### Option 3: Static Frontend Only

If you only want the map and client-side features (no news feeds, no AI, no market data):

```bash
npm run dev    # Vite dev server on http://localhost:5173
```

This runs the frontend without the API layer. Panels that require server-side proxying will show "No data available". The interactive map, static data layers (bases, cables, pipelines), and browser-side ML models still work.

### Platform Notes

| Platform               | Status                  | Notes                                                                                                                          |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Vercel**             | Full support            | Recommended deployment target                                                                                                  |
| **Linux x86_64**       | Full support            | Works with `vercel dev` for local development. Desktop .AppImage available for x86_64. WebKitGTK rendering uses DMA-BUF with fallback to SHM for GPU compatibility. Font stack includes DejaVu Sans Mono and Liberation Mono for consistent rendering across distros |
| **macOS**              | Works with `vercel dev` | Full local development                                                                                                         |
| **Raspberry Pi / ARM** | Partial                 | `vercel dev` edge runtime emulation may not work on ARM. Use Option 1 (deploy to Vercel) or Option 3 (static frontend) instead |
| **Docker**             | Official image         | See [Docker image](#docker-image-official) ([#1260](https://github.com/koala73/worldmonitor/issues/1260))                    |

### Docker image (official)

An official Docker image is published to GitHub Container Registry on each [release](https://github.com/koala73/worldmonitor/releases) ([#1260](https://github.com/koala73/worldmonitor/issues/1260)):

- **Image**: `ghcr.io/koala73/worldmonitor`
- **Architectures**: `linux/amd64`, `linux/arm64`
- **Tags**: `latest`, `vX.Y.Z` (e.g. `v2.6.0`), and `X.Y` (e.g. `2.6`)

The image is **frontend-only**: it serves the Vite-built static app with nginx and proxies `/api/*` to an upstream API. No Node or edge functions run inside the container.

**Build (from repo root):**

```bash
docker build -t ghcr.io/koala73/worldmonitor:latest .
```

**Run (default API: `https://api.worldmonitor.app`):**

```bash
docker run -d --name worldmonitor -p 3000:80 ghcr.io/koala73/worldmonitor:latest
```

Then open [http://localhost:3000](http://localhost:3000).

**Environment variables:**

| Variable        | Default                        | Description                                      |
| --------------- | ------------------------------ | ------------------------------------------------ |
| `API_UPSTREAM`  | `https://api.worldmonitor.app` | Backend URL for `/api/*` proxy (set at runtime)  |

The proxy forwards the upstream host (`Host: <API_UPSTREAM host>`) so the default API receives the correct Host. If your backend expects a different Host, configure it accordingly.

Example with a custom API backend:

```bash
docker run -d -p 3000:80 -e API_UPSTREAM=http://my-api:3001 ghcr.io/koala73/worldmonitor:latest
```

Build-time options (optional, for custom builds): pass `VITE_VARIANT` and `VITE_WS_API_URL` via `--build-arg`. Other `VITE_*` vars the app uses (e.g. `VITE_PMTILES_URL`, `VITE_WS_RELAY_URL`) can be added the same way; see `.env.example` for the full list.

### Railway Relay (Optional)

The Railway relay is a multi-protocol gateway that handles data sources requiring persistent connections, residential proxying, or upstream APIs that block Vercel's edge runtime:

```bash
# On Railway, deploy with:
node scripts/ais-relay.cjs
```

| Service                 | Protocol        | Purpose                                                              |
| ----------------------- | --------------- | -------------------------------------------------------------------- |
| **AIS Vessel Tracking** | WebSocket       | Live AIS maritime data with chokepoint detection and density grids   |
| **OpenSky Aircraft**    | REST (polling)  | Military flight tracking across merged query regions                 |
| **Telegram OSINT**      | MTProto (GramJS)| 26 OSINT channels polled on 60s cycle with FLOOD_WAIT handling       |
| **OREF Rocket Alerts**  | curl + proxy    | Israel Home Front Command sirens via residential proxy (Akamai WAF)  |
| **Polymarket Proxy**    | HTTPS           | JA3 fingerprint bypass with request queuing and cache deduplication   |
| **ICAO NOTAM**          | REST            | Airport/airspace closure detection for 46 MENA airports              |

Set `WS_RELAY_URL` (server-side, HTTPS) and `VITE_WS_RELAY_URL` (client-side, WSS) in your environment. Without the relay, AIS, OpenSky, Telegram, and OREF layers won't show live data, but all other features work normally.

---

## Tech Stack

| Category              | Technologies                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**          | Vanilla TypeScript (no framework), Vite, globe.gl + Three.js (3D globe), deck.gl + MapLibre GL (flat map), vite-plugin-pwa (service worker + manifest) |
| **Desktop**           | Tauri 2 (Rust) with Node.js sidecar, OS keychain integration (keyring crate), native TLS (reqwest)                                             |
| **AI/ML**             | Ollama / LM Studio (local, OpenAI-compatible), Groq (Llama 3.1 8B), OpenRouter (fallback), Transformers.js (browser-side T5, NER, embeddings), IndexedDB vector store (5K headline RAG) |
| **Caching**           | Redis (Upstash) — 3-tier cache with in-memory + Redis + upstream, cross-user AI deduplication. Vercel CDN (s-maxage). Service worker (Workbox) |
| **Geopolitical APIs** | OpenSky, GDELT, ACLED, UCDP, HAPI, USGS, GDACS, NASA EONET, NASA FIRMS, Polymarket, Cloudflare Radar, WorldPop, OREF (Israel sirens), gpsjam.org (GPS interference), Telegram MTProto (26 OSINT channels) |
| **Market APIs**       | Yahoo Finance (equities, forex, crypto), CoinGecko (stablecoins), mempool.space (BTC hashrate), alternative.me (Fear & Greed)                  |
| **Threat Intel APIs** | abuse.ch (Feodo Tracker, URLhaus), AlienVault OTX, AbuseIPDB, C2IntelFeeds                                                                     |
| **Economic APIs**     | FRED (Federal Reserve), EIA (Energy), Finnhub (stock quotes)                                                                                   |
| **Localization**      | i18next (21 languages: en, bg, ro, fr, de, es, it, pl, pt, nl, sv, ru, ar, zh, ja, tr, th, vi, cs, el, ko), RTL support, lazy-loaded bundles, native-language feeds for 21 locales with one-time locale boost |
| **API Contracts**     | Protocol Buffers (92 proto files, 22 services), sebuf HTTP annotations, buf CLI (lint + breaking checks), auto-generated TypeScript clients/servers + OpenAPI 3.1.0 docs |
| **Analytics**         | Vercel Analytics (privacy-first, lightweight web vitals and page view tracking)                                                                 |
| **Deployment**        | Vercel Edge Functions (60+ endpoints) + Railway (WebSocket relay + Telegram + OREF + Polymarket proxy + NOTAM) + Tauri (macOS/Windows/Linux) + PWA (installable) |
| **Finance Data**      | 92 stock exchanges, 19 financial centers, 13 central banks, 10 commodity hubs, 64 Gulf FDI investments                                         |
| **Data**              | 435+ RSS feeds across all 4 variants, ADS-B transponders, AIS maritime data, VIIRS satellite imagery, 30+ live video channels (8+ default YouTube + 18+ HLS native), 26 Telegram OSINT channels |

---

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines, including the Sebuf RPC framework workflow, how to add data sources and RSS feeds, and our AI-assisted development policy. The project also maintains a [Code of Conduct](./CODE_OF_CONDUCT.md) and [Security Policy](./SECURITY.md) for responsible vulnerability disclosure.

```bash
# Development
npm run dev          # Full variant (worldmonitor.app)
npm run dev:tech     # Tech variant (tech.worldmonitor.app)
npm run dev:finance    # Finance variant (finance.worldmonitor.app)
npm run dev:commodity  # Commodity variant (commodity.worldmonitor.app)
npm run dev:happy      # Happy variant (happy.worldmonitor.app)

# Production builds
npm run build:full       # Build full variant
npm run build:tech       # Build tech variant
npm run build:finance    # Build finance variant
npm run build:commodity  # Build commodity variant
npm run build:happy      # Build happy variant

# Quality (also runs automatically on PRs via GitHub Actions)
npm run typecheck    # TypeScript type checking (tsc --noEmit)

# Desktop packaging
npm run desktop:package:macos:full      # .app + .dmg (World Monitor)
npm run desktop:package:macos:tech      # .app + .dmg (Tech Monitor)
npm run desktop:package:macos:finance   # .app + .dmg (Finance Monitor)
npm run desktop:package:windows:full    # .exe + .msi (World Monitor)
npm run desktop:package:windows:tech    # .exe + .msi (Tech Monitor)
npm run desktop:package:windows:finance # .exe + .msi (Finance Monitor)

# Generic packaging runner
npm run desktop:package -- --os macos --variant full

# Signed packaging (same targets, requires signing env vars)
npm run desktop:package:macos:full:sign
npm run desktop:package:windows:full:sign
```

Desktop release details, signing hooks, variant outputs, and clean-machine validation checklist:

- [docs/RELEASE_PACKAGING.md](./docs/RELEASE_PACKAGING.md)

---

## Roadmap

**Completed highlights** — 4 variant dashboards, 60+ edge functions, dual map engine, native desktop app (Tauri), 21 languages, proto-first API contracts, AI summarization + deduction + RAG, 30+ live video streams, Telegram OSINT, OREF rocket alerts, CII scoring, cross-stream correlation, and much more.

**Upcoming:**

- [ ] Mobile-optimized views
- [ ] Push notifications for critical alerts

See [full roadmap](./docs/DOCUMENTATION.md#roadmap).

---

## Support the Project

If you find World Monitor useful:

- **Star this repo** to help others discover it
- **Share** with colleagues interested in OSINT
- **Contribute** code, data sources, or documentation
- **Report issues** to help improve the platform

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](LICENSE) for the full text.

### What This Means

**You are free to:**

- **Use** — run World Monitor for any purpose, including commercial use
- **Study** — read, audit, and learn from the source code
- **Modify** — adapt, extend, and build upon the code
- **Distribute** — share copies with anyone

**Under these conditions:**

- **Source code disclosure** — if you distribute or modify this software, you **must** make the complete source code available under the same AGPL-3.0 license
- **Network use is distribution** — if you run a modified version as a network service (SaaS, web app, API), you **must** provide the source code to all users who interact with it over the network. This is the key difference from GPL-3.0 — you cannot run a modified version behind a server without sharing the source
- **Same license (copyleft)** — any derivative work must be released under AGPL-3.0. You cannot re-license under a proprietary or more permissive license
- **Attribution** — you must retain all copyright notices, give appropriate credit to the original author, and clearly indicate any changes you made
- **State changes** — modified files must carry prominent notices stating that you changed them, with the date of the change
- **No additional restrictions** — you may not impose any further restrictions on the rights granted by this license (e.g., no DRM, no additional terms)

**In plain terms:**

| Use Case | Allowed? | Condition |
|----------|----------|-----------|
| Personal / internal use | Yes | No conditions |
| Self-hosted deployment | Yes | No conditions if unmodified |
| Forking & modifying | Yes | Must share source under AGPL-3.0 |
| Commercial use | Yes | Must share source under AGPL-3.0 |
| Running as a SaaS/web service | Yes | Must share source under AGPL-3.0 |
| Bundling into a proprietary product | No | AGPL-3.0 copyleft prevents this |

**No warranty** — the software is provided "as is" without warranty of any kind.

Copyright (C) 2024-2026 Elie Habib. All rights reserved under AGPL-3.0.

---

## Author

**Elie Habib** — [GitHub](https://github.com/koala73)

---

## Contributors

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

---

## Security Acknowledgments

We thank the following researchers for responsibly disclosing security issues:

- **Cody Richard** — Disclosed three security findings covering IPC command exposure via DevTools in production builds, renderer-to-sidecar trust boundary analysis, and the global fetch patch credential injection architecture (2026)

If you discover a vulnerability, please see our [Security Policy](./SECURITY.md) for responsible disclosure guidelines.

---

<p align="center">
  <a href="https://worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://tech.worldmonitor.app">tech.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity.worldmonitor.app</a>
</p>

## Star History

<a href="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date" />
 </picture>
</a>
