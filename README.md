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

![World Monitor Dashboard](new-world-monitor.png)

---

## Why World Monitor?

| Problem                            | Solution                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| News scattered across 100+ sources | **Single unified dashboard** with 170+ curated feeds across 15 categories                                  |
| No geospatial context for events   | **Interactive map** with 45+ toggleable data layers and CII country risk heatmap                            |
| Information overload               | **AI-synthesized briefs** with focal point detection and local LLM support                                 |
| Crypto/macro signal noise          | **7-signal market radar** with composite BUY/CASH verdict                                                  |
| Expensive OSINT tools ($$$)        | **100% free & open source**                                                                                |
| Static news feeds                  | **Real-time updates** with live video streams and AI-powered deductions                                    |
| Cloud-dependent AI tools           | **Run AI locally** with Ollama/LM Studio — no API keys, no data leaves your machine. Opt-in **Headline Memory** builds a local semantic index of every headline for RAG-powered queries |
| Web-only dashboards                | **Native desktop app** (Tauri) for macOS, Windows, and Linux + installable PWA with offline map support    |
| Flat 2D maps                       | **Dual map engine** — photorealistic 3D globe (globe.gl + Three.js) and WebGL flat map (deck.gl) with 45+ toggleable data layers, runtime-switchable |
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
| **Happy Monitor**   | [happy.worldmonitor.app](https://happy.worldmonitor.app)     | Good news, positive trends, uplifting stories    |

All four variants run from a single codebase — switch between them with one click via the header bar.

---

## Key Features

### Localization & Regional Support

- **Multilingual UI** — Fully localized interface supporting **21 languages: English, Bulgarian, Romanian, French, Spanish, German, Italian, Polish, Portuguese, Dutch, Swedish, Russian, Arabic, Chinese, Japanese, Turkish, Thai, Vietnamese, Czech, Greek, and Korean**. Language bundles are lazy-loaded on demand — only the active language is fetched, keeping initial bundle size minimal.
- **RTL Support** — Native right-to-left layout support for Arabic (`ar`) and Hebrew.
- **Localized News Feeds** — Region-specific RSS selection based on language preference (e.g., viewing the app in French loads Le Monde, Jeune Afrique, and France24). 21 locales have dedicated native-language feed sets: Bulgarian (BNR, Dnevnik, Capital), Romanian, French, Arabic, German, Spanish, Italian, Dutch, Swedish, Turkish (BBC Türkçe, Hurriyet, DW Turkish), Polish (TVN24, Polsat News, Rzeczpospolita), Russian (BBC Russian, Meduza, Novaya Gazeta Europe), Thai (Bangkok Post, Thai PBS), Vietnamese (VnExpress, Tuoi Tre News), Korean (Yonhap, Chosun Ilbo), Greek (Kathimerini, Naftemporiki, in.gr, Proto Thema), Portuguese (O Globo, Folha), Japanese (Asahi Shimbun), Chinese (MIIT, MOFCOM), and Czech (iDNES, Novinky). On first load for non-English users, a one-time locale boost automatically enables these native-language sources without overwriting manual preferences.
- **AI Translation** — Integrated LLM translation for news headlines and summaries, enabling cross-language intelligence gathering.
- **Regional Intelligence** — Dedicated monitoring panels for Africa, Latin America, Middle East, and Asia with local sources.

### Dual Map Engine — 3D Globe + Flat Map

Two rendering engines are available, switchable at runtime via Settings or the `VITE_MAP_INTERACTION_MODE` environment variable (`globe` or `flat`). The preference is persisted in localStorage.

**3D Globe (globe.gl + Three.js)** — a photorealistic 3D Earth with full pitch and rotation:

- **Earth textures** — topographic-bathymetric day surface (`earth-topo-bathy.jpg`), specular water map for ocean reflections, and a starfield night-sky background
- **Atmosphere shader** — a Fresnel limb-glow effect simulates atmospheric scattering at the globe's edge
- **Auto-rotation** — the globe slowly rotates when idle, pausing on any user interaction and resuming after 60 seconds of inactivity
- **HTML marker layer** — all 28+ data categories (conflicts, intel hotspots, AIS vessels, flights, protests, fires, etc.) render as HTML elements pinned to geographic coordinates on the globe surface
- **Geopolitical polygon overlays** — the Korean DMZ and other boundary polygons render directly on the globe under the conflicts layer
- **Debounced marker flush** — rapid data updates are coalesced via `debounceFlushMarkers()` to prevent Three.js scene graph crashes during high-frequency data refresh
- **Configurable render quality** — a Settings dropdown offers five pixel-ratio presets: Auto (matches device DPR, capped at 2×), Eco (1×), Sharp (1.5×), 4K (2×), and Insane (3×). The setting updates the Three.js renderer live without page reload. Desktop (Tauri) builds cap the default at 1.25× to avoid software-rendering fallback on machines without discrete GPUs
- **Desktop-optimized defaults** — Tauri desktop builds request the high-performance GPU (`powerPreference: 'high-performance'`), disable the logarithmic depth buffer (saves shader overhead), and turn off auto-rotation and camera damping to eliminate continuous render loop wakeups when idle — addressing reports of 1 fps performance on some machines
- **Background pause** — when the desktop app window loses focus or the globe panel is hidden, the WebGL render loop pauses entirely, stopping the Three.js animation loop and canceling auto-rotate. Data updates received while paused are queued and flushed in a single batch when the globe returns to view, eliminating background GPU load on laptops
- **Beta indicator** — a pulsing cyan "BETA" badge appears when the globe is active, signaling the feature is newer than the flat map

**Flat Map (deck.gl + MapLibre GL JS)** — a WebGL-accelerated 2D map with smooth 60fps rendering and thousands of concurrent markers:

- **Layer types** — `GeoJsonLayer`, `ScatterplotLayer`, `PathLayer`, `IconLayer`, `TextLayer`, `PolygonLayer`, `ArcLayer`, `HeatmapLayer` composited in a single render pass
- **Smart clustering** — Supercluster groups markers at low zoom, expands on zoom in. Cluster thresholds adapt to zoom level
- **Progressive disclosure** — detail layers (bases, nuclear, datacenters) appear only when zoomed in; zoom-adaptive opacity fades markers from 0.2 at world view to 1.0 at street level
- **Label deconfliction** — overlapping labels (e.g., multiple BREAKING badges) are automatically suppressed by priority, highest-severity first
- **Day/night overlay** — a terminator line divides the map into sunlit and dark hemispheres based on the current UTC time

**Shared across both engines:**

- **45+ data layers** — conflicts, military bases, nuclear facilities, undersea cables, pipelines, satellite fire detection, protests, natural disasters, datacenters, displacement flows, climate anomalies, cyber threat IOCs, GPS/GNSS jamming zones, CII country risk heatmap, geopolitical boundaries (Korean DMZ), stock exchanges, financial centers, central banks, commodity hubs, Gulf investments, trade routes, airport delays, and more. All layer definitions are maintained in a single shared catalog (`map-layer-definitions.ts`) consumed by both renderers — adding a new layer is a single-file operation
- **8 regional presets** — Global, Americas, Europe, MENA, Asia, Africa, Oceania, Latin America
- **Time filtering** — 1h, 6h, 24h, 48h, 7d event windows
- **URL state sharing** — map center, zoom, active layers, and time range are encoded in the URL for shareable views (`?view=mena&zoom=4&layers=conflicts,bases`)
- **Mobile touch gestures** — single-finger pan with inertial velocity animation (0.92 decay factor, computed from 4-entry circular touch history), two-finger pinch-to-zoom with center-point preservation, and bottom-sheet popups with drag-to-dismiss. An 8px movement threshold prevents accidental interaction during taps
- **Timezone-based region detection** — on first load, the map centers on the user's approximate region derived from `Intl.DateTimeFormat().resolvedOptions().timeZone` — no network dependency, no geolocation prompt. On mobile, the browser's Geolocation API is queried (5-second timeout) and the map auto-centers on the user's precise GPS coordinates at zoom level 6. If the URL already contains shared coordinates, the shared view takes precedence and geolocation is skipped
- **Cmd+K map navigation** — the command palette supports `Map:` prefixed commands to fly to any country or region on either engine

### AI-Powered Intelligence

- **World Brief** — LLM-synthesized summary of top global developments with a 4-tier provider fallback chain: Ollama (local) → Groq (cloud) → OpenRouter (cloud) → browser-side T5 (Transformers.js). Each tier is attempted with a 5-second timeout before falling through to the next, so the UI is never blocked. Results are Redis-cached (24h TTL) and content-deduplicated so identical headlines across concurrent users trigger exactly one LLM call
- **Local LLM Support** — Ollama and LM Studio (any OpenAI-compatible endpoint) run AI summarization entirely on local hardware. No API keys required, no data leaves the machine. The desktop app auto-discovers available models from the local instance and populates a selection dropdown, filtering out embedding-only models. Default fallback model: `llama3.1:8b`
- **AI Deduction & Forecasting** — an interactive geopolitical analysis tool where analysts enter a free-text query (e.g., "What will happen in the next 24 hours in the Middle East?") and receive an LLM-generated near-term timeline deduction. The panel auto-populates context from the 15 most recent live headlines via `buildNewsContext()`, so the AI always has current situational awareness. Other panels can pre-fill and auto-submit queries via the `wm:deduct-context` custom event for seamless cross-panel deep-linking into contextual forecasts. Results are Redis-cached (1-hour TTL) by query hash to avoid redundant LLM calls
- **Headline Memory (RAG)** — an opt-in client-side Retrieval-Augmented Generation system. When enabled in Settings, every incoming RSS headline is embedded using an ONNX model (`all-MiniLM-L6-v2`, 384-dimensional float32 vectors) running in a dedicated Web Worker, then stored in IndexedDB (`worldmonitor_vector_store`, capped at 5,000 vectors with LRU eviction by ingestion time). Any component can semantically search the headline archive using natural-language queries — results are ranked by brute-force cosine similarity and returned in score order. The entire pipeline runs locally in the browser with zero server dependency, enabling persistent semantic intelligence across sessions
- **Hybrid Threat Classification** — instant keyword classifier with async LLM override for higher-confidence results
- **Focal Point Detection** — correlates entities across news, military activity, protests, outages, and markets to identify convergence
- **Country Instability Index** — real-time stability scores for every country with incoming data using weighted multi-signal blend. 23 curated tier-1 nations have tuned baseline risk profiles; all other countries receive universal scoring with sensible defaults when any event data (protests, conflicts, outages, displacement, climate anomalies) is detected. A **CII choropleth heatmap** paints every country on both flat and 3D globe views in a five-stop gradient (green → yellow → orange → red → dark-red) based on live instability scores (0–100), enabling analysts to scan global risk distribution at a glance. Clicking any country row in the CII panel navigates directly to that country's full intelligence brief
- **Trending Keyword Spike Detection** — 2-hour rolling window vs 7-day baseline flags surging terms across RSS feeds, with CVE/APT entity extraction and auto-summarization
- **Strategic Posture Assessment** — composite risk score combining all intelligence modules with trend detection
- **Country Brief Pages** — click any country for a full-page intelligence dossier with CII score ring, AI-generated analysis, top news with citation anchoring, prediction markets, 7-day event timeline, active signal chips, infrastructure exposure, and stock market index — exportable as JSON, CSV, or image

### Real-Time Data Layers

<details>
<summary><strong>Geopolitical</strong></summary>

- Active conflict zones with escalation tracking (UCDP + ACLED)
- Intelligence hotspots with news correlation
- Social unrest events (dual-source: ACLED protests + GDELT geo-events, Haversine-deduplicated)
- Natural disasters from 3 sources (USGS earthquakes M4.5+, GDACS alerts, NASA EONET events)
- Sanctions regimes
- Cyber threat IOCs (C2 servers, malware hosts, phishing, malicious URLs) geo-located on the globe
- GPS/GNSS jamming zones from ADS-B transponder analysis (H3 hex grid, interference % classification)
- Geopolitical boundary overlays — Korean DMZ (43-point closed-ring polygon based on the Korean Armistice Agreement), with typed boundary categories (demilitarized, ceasefire, disputed, armistice) and info popups
- Weather alerts and severe conditions

</details>

<details>
<summary><strong>Military & Strategic</strong></summary>

- 210+ military bases from 9 operators
- Live military flight tracking (ADS-B)
- Naval vessel monitoring (AIS)
- Nuclear facilities & gamma irradiators
- APT cyber threat actor attribution
- Spaceports & launch facilities

</details>

<details>
<summary><strong>Infrastructure</strong></summary>

- Undersea cables with landing points, cable health advisories (NGA navigational warnings), and cable repair ship tracking
- Oil & gas pipelines
- AI datacenters (111 major clusters)
- 83 strategic ports across 6 types (container, oil, LNG, naval, mixed, bulk) with throughput rankings
- Internet outages (Cloudflare Radar)
- Critical mineral deposits
- NASA FIRMS satellite fire detection (VIIRS thermal hotspots)
- 19 global trade routes (container, energy, bulk) with multi-segment arcs through strategic chokepoints
- Airport delays and closures across 107 monitored airports (FAA + AviationStack + ICAO NOTAM)

</details>

<details>
<summary><strong>Market & Crypto Intelligence</strong></summary>

- 7-signal macro radar with composite BUY/CASH verdict
- **Gulf Economies panel** — live data for GCC financial markets across three sections: **Indices** (Tadawul/Saudi Arabia, Dubai Financial Market, Abu Dhabi, Qatar, WisdomTree Gulf Dividend, Muscat MSM 30), **Currencies** (SAR, AED, QAR, KWD, BHD, OMR vs USD), and **Oil** (WTI Crude, Brent Crude). All quotes fetched from Yahoo Finance with staggered batching, Redis-cached for 8 minutes, with mini sparklines per quote and 60-second polling
- Real-time crypto prices (BTC, ETH, SOL, XRP, and more) via CoinGecko
- BTC spot ETF flow tracker (IBIT, FBTC, GBTC, and 7 more)
- Stablecoin peg health monitor (USDT, USDC, DAI, FDUSD, USDe)
- Fear & Greed Index with 30-day history
- Bitcoin technical trend (SMA50, SMA200, VWAP, Mayer Multiple)
- JPY liquidity signal, QQQ/XLP macro regime, BTC hash rate
- Inline SVG sparklines and donut gauges for visual trends

</details>

<details>
<summary><strong>Tech Ecosystem</strong> (Tech variant)</summary>

- Tech company HQs (Big Tech, unicorns, public)
- Startup hubs with funding data
- Cloud regions (AWS, Azure, GCP)
- Accelerators (YC, Techstars, 500)
- Upcoming tech conferences

</details>

<details>
<summary><strong>Finance & Markets</strong> (Finance variant)</summary>

- 92 global stock exchanges — mega (NYSE, NASDAQ, Shanghai, Euronext, Tokyo), major (Hong Kong, London, NSE/BSE, Toronto, Korea, Saudi Tadawul), and emerging markets — with market caps and trading hours
- 19 financial centers — ranked by Global Financial Centres Index (New York #1 through offshore centers: Cayman Islands, Luxembourg, Bermuda, Channel Islands)
- 13 central banks — Federal Reserve, ECB, BoJ, BoE, PBoC, SNB, RBA, BoC, RBI, BoK, BCB, SAMA, plus supranational institutions (BIS, IMF)
- BIS central bank data — policy rates across major economies, real effective exchange rates (REER), and credit-to-GDP ratios sourced from the Bank for International Settlements
- 10 commodity hubs — exchanges (CME Group, ICE, LME, SHFE, DCE, TOCOM, DGCX, MCX) and physical hubs (Rotterdam, Houston)
- Gulf FDI investment layer — 64 Saudi/UAE foreign direct investments plotted globally, color-coded by status (operational, under-construction, announced), sized by investment amount
- WTO trade policy intelligence — active trade restrictions, tariff trends, bilateral trade flows, and SPS/TBT barriers sourced from the World Trade Organization

</details>

### Live News & Video

- **170+ RSS feeds** across geopolitics, defense, energy, tech, and finance — domain-allowlisted proxy prevents CORS issues. Each variant loads its own curated feed set: ~25 categories for geopolitical, ~20 for tech, ~18 for finance. **Server-side feed aggregation** — a single `listFeedDigest` RPC call fetches all feeds server-side (batched at 20 concurrent requests with 8-second per-feed timeouts and a 25-second overall deadline), caches the categorized digest in Redis for 15 minutes, and serves it to all clients. This eliminates per-client feed fan-out, reducing Vercel Edge invocations by approximately 95%. Individual feed results are separately cached for 10 minutes, so repeated digest builds within that window reuse previously fetched content
- **Smart default sources with locale boost** — new installations start with a curated subset (~101 sources, Tier 1+2 per panel, minimum 8 per panel) rather than all 170+ feeds. For non-English users, a one-time locale-aware boost automatically enables native-language feeds matching the browser's language (e.g., viewing in Korean enables Yonhap and Chosun Ilbo; viewing in Greek enables Kathimerini, Naftemporiki, and Proto Thema). 21 languages have dedicated native-language feed sets — feeds declare their `lang` field and the boost function matches against the browser locale
- **9 default live video streams** — Bloomberg, Sky News, Al Jazeera, Euronews, DW, France24, CNBC, CNN, Al Arabiya — with automatic live detection that scrapes YouTube channel pages every 5 minutes to find active streams. 70+ additional channels available from an expandable library (Fox, BBC, CNN Turk, TRT, RT, CBS, NBC, CNN Brasil, and more) across 6 region tabs including **Oceania** (ABC News Australia). On mobile, channel tabs scroll horizontally with native touch inertia and snap-to-button alignment instead of wrapping to multiple rows
- **HLS native streaming** — 18+ channels (Sky News, Euronews, DW, France24, Al Arabiya, CBS News, TRT World, Sky News Arabia, Al Hadath, RT, ABC News AU, Tagesschau24, India Today, KAN 11, TV5Monde Info, Arise News, NHK World, Fox News, and more) stream via native HLS `<video>` elements instead of YouTube iframes, bypassing cookie popups, bot checks, and WKWebView autoplay restrictions. CNN and CNBC stream via a proxied HLS path through the sidecar. HLS failure triggers automatic 5-minute cooldown with YouTube iframe fallback. RT (Russia Today) — banned from YouTube — streams exclusively via HLS
- **Fullscreen live video** — a toggle button in the Live News panel header expands the video grid to fill the entire viewport, hiding all other panels. The fullscreen state applies CSS overrides to both the panel element and the document body, with an icon that swaps between expand and collapse states
- **Desktop embed bridge** — YouTube's IFrame API restricts playback in native webviews (error 153). The dashboard detects this and transparently routes through a cloud-hosted embed proxy with bidirectional message passing (play/pause/mute/unmute/loadVideo)
- **Idle-aware playback** — video players pause and are removed from the DOM after 5 minutes of inactivity, resuming when the user returns. Tab visibility changes also suspend/resume streams. A **"Keep live streams running"** toggle in Settings disables the idle timer entirely, keeping streams active indefinitely regardless of inactivity — useful for always-on monitoring stations
- **Global streaming quality control** — a user-selectable quality setting (auto, 360p, 480p, 720p) that applies to all live video streams across the dashboard. The preference persists in localStorage and propagates to active players via a `stream-quality-changed` CustomEvent — no reload required when switching quality
- **22 live webcams** — real-time YouTube streams from geopolitical hotspots across 5 regions (Iran/Attacks, Middle East, Europe, Americas, Asia-Pacific). Grid view shows 4 strategic feeds simultaneously; single-feed view available. Region filtering (IRAN/MIDEAST/EUROPE/AMERICAS/ASIA), idle-aware playback that pauses after 5 minutes, and Intersection Observer-based lazy loading. The Iran/Attacks tab provides a dedicated 2×2 grid of Tehran, Tel Aviv, and Jerusalem feeds for real-time visual monitoring during escalation events. On mobile, the grid view is disabled and the panel is locked to single-stream mode to conserve battery and bandwidth — region tabs scroll horizontally with native touch inertia and snap-to-button alignment
- **Custom keyword monitors** — user-defined keyword alerts with word-boundary matching (prevents "ai" from matching "train"), automatic color-coding from a 10-color palette, and multi-keyword support (comma-separated). Monitors search across both headline titles and descriptions and show real-time match counts
- **Breaking news click-through** — clicking a breaking news banner scrolls the page to the RSS panel that sourced the alert and applies a 1.5-second flash highlight animation. The source mapping uses `getSourcePanelId()` to resolve each news source name to its parent category panel
- **Entity extraction** — Auto-links countries, leaders, organizations
- **Instant flat render** — news items appear immediately as a flat list the moment feed data arrives. ML-based clustering (topic grouping, entity extraction, sentiment analysis) runs asynchronously in the background and progressively upgrades the view when ready — eliminating the 1–3 second blank delay that would occur if clustering blocked initial render. Finance variant categories fetch with 5 concurrent requests (vs 3) for ~10–15 second faster cold starts
- **Virtual scrolling** — news panels with 15+ items use a custom virtual list renderer that only creates DOM elements for visible items plus a 3-item overscan buffer. Viewport spacers simulate full-list height. Uses `requestAnimationFrame`-batched scroll handling and `ResizeObserver` for responsive adaptation. DOM elements are pooled and recycled rather than created/destroyed

### Signal Aggregation & Anomaly Detection

- **Multi-source signal fusion** — internet outages, military flights, naval vessels, protests, AIS disruptions, satellite fires, and keyword spikes are aggregated into a unified intelligence picture with per-country and per-region clustering
- **Temporal baseline anomaly detection** — Welford's online algorithm computes streaming mean/variance per event type, region, weekday, and month over a 90-day window. Z-score thresholds (1.5/2.0/3.0) flag deviations like "Military flights 3.2x normal for Thursday (January)" — stored in Redis via Upstash
- **Regional convergence scoring** — when multiple signal types spike in the same geographic area, the system identifies convergence zones and escalates severity

### Story Sharing & Social Export

- **Shareable intelligence stories** — generate country-level intelligence briefs with CII scores, threat counts, theater posture, and related prediction markets
- **Multi-platform export** — custom-formatted sharing for Twitter/X, LinkedIn, WhatsApp, Telegram, Reddit, and Facebook with platform-appropriate formatting
- **Deep links** — every story generates a unique URL (`/story?c=<country>&t=<type>`) with dynamic Open Graph meta tags for rich social previews
- **Canvas-based image generation** — stories render as PNG images for visual sharing, with QR codes linking back to the live dashboard
- **Dynamic Open Graph images** — the `/api/og-story` endpoint generates 1200×630px SVG cards on-the-fly for each country story. Cards display the country name, CII score gauge arc with threat-level coloring, a 0–100 score bar, and signal indicator chips (threats, military, markets, convergence). Social crawlers (Twitter, Facebook, LinkedIn, Telegram, Discord, Reddit, WhatsApp) receive these cards via `og:image` meta tags, while regular browsers get a 302 redirect to the SPA. Bot detection uses a user-agent regex for 10+ known social crawler signatures

### Desktop Application (Tauri)

- **Native desktop app** for macOS, Windows, and Linux — packages the full dashboard with a local Node.js sidecar that runs all 60+ API handlers locally
- **OS keychain integration** — API keys stored in the system credential manager (macOS Keychain, Windows Credential Manager), never in plaintext files
- **Token-authenticated sidecar** — a unique session token prevents other local processes from accessing the sidecar on localhost. Generated per launch using randomized hashing
- **Cloud fallback** — when a local API handler fails or is missing, requests transparently fall through to the cloud deployment (worldmonitor.app) with origin headers stripped
- **Settings window** — dedicated configuration UI (Cmd+,) with three tabs: **LLMs** (Ollama endpoint, model selection, Groq, OpenRouter), **API Keys** (12+ data source credentials with per-key validation), and **Debug & Logs** (traffic log, verbose mode, log files). Each tab runs an independent verification pipeline — saving in the LLMs tab doesn't block API Keys validation
- **Automatic model discovery** — when you set an Ollama or LM Studio endpoint URL in the LLMs tab, the settings panel immediately queries it for available models (tries Ollama native `/api/tags` first, then OpenAI-compatible `/v1/models`) and populates a dropdown. Embedding models are filtered out. If discovery fails, a manual text input appears as fallback
- **Cross-window secret sync** — the main dashboard and settings window run in separate webviews with independent JS contexts. Saving a secret in Settings writes to the OS keychain and broadcasts a `localStorage` change event. The main window listens for this event and hot-reloads all secrets without requiring an app restart
- **Consolidated keychain vault** — all secrets are stored as a single JSON blob in one keychain entry (`secrets-vault`) rather than individual entries per key. This reduces macOS Keychain authorization prompts from 20+ to exactly 1 on each app launch. A one-time migration reads any existing individual entries, consolidates them, and cleans up the old format
- **Verbose debug mode** — toggle traffic logging with persistent state across restarts. View the last 200 requests with timing, status codes, and error details
- **DevTools toggle** — Cmd+Alt+I opens the embedded web inspector for debugging
- **Auto-update checker** — polls the cloud API for new versions every 6 hours. Displays a non-intrusive update badge with direct download link and per-version dismiss. Variant-aware — a Tech Monitor desktop app links to the correct Tech Monitor release asset

### Progressive Web App

- **Installable** — the dashboard can be installed to the home screen on mobile or as a standalone desktop app via Chrome's install prompt. Full-screen `standalone` display mode with custom theme color
- **Offline map support** — MapTiler tiles are cached using a CacheFirst strategy (up to 500 tiles, 30-day TTL), enabling map browsing without a network connection
- **Smart caching strategies** — APIs and RSS feeds use NetworkOnly (real-time data must always be fresh), while fonts (1-year TTL), images (7-day StaleWhileRevalidate), and static assets (1-year immutable) are aggressively cached
- **Auto-updating service worker** — checks for new versions every 60 minutes. Tauri desktop builds skip service worker registration entirely (uses native APIs instead)
- **Offline fallback** — a branded fallback page with retry button is served when the network is unavailable

### Additional Capabilities

- Signal intelligence with "Why It Matters" context
- Infrastructure cascade analysis with proximity correlation
- Maritime & aviation tracking with surge detection
- Prediction market integration (Polymarket) with 3-tier JA3 bypass (browser-direct → Tauri native TLS → cloud proxy)
- **Telegram intelligence feed** — 26 OSINT and breaking news channels (Aurora Intel, BNO News, OSINTdefender, DeepState, LiveUAMap, and more) polled via MTProto client on the Railway relay. Messages are deduplicated, topic-classified (breaking/conflict/alerts/osint/politics), and served through a Vercel edge proxy with 30-second client caching
- **OREF rocket alert integration** — near-real-time Israeli Home Front Command siren data (incoming rockets, missiles, drones) polled from `oref.org.il` via residential proxy through the Railway relay (Akamai WAF blocks datacenter IPs). Tracks live alerts and rolling 24-hour history with wave detection. Alert counts feed into CII scoring for Israel (up to +50 conflict score boost)
- **Government travel advisory aggregation** — security advisories from 4 governments (US State Dept, Australia DFAT, UK FCDO, New Zealand MFAT), 13 US Embassy country-specific feeds, and health agencies (CDC, ECDC, WHO) are aggregated, country-mapped, and deduplicated. Advisory levels feed into CII as both score boosts (+5 to +15) and minimum score floors (Do-Not-Travel forces CII ≥ 60), preventing optimistic drift for countries with active travel warnings from multiple governments
- **GPS/GNSS interference mapping** — ADS-B transponder data from gpsjam.org identifies H3 hex cells where aircraft report GPS anomalies. Cells with >2% interference are classified as medium (amber), >10% as high (red). Interference zones feed into CII security scoring (up to +35 points per country) and are region-tagged across 12 conflict zones (Iran-Iraq, Ukraine-Russia, Levant, Baltic, etc.)
- Service status monitoring (cloud providers, AI services)
- Shareable map state via URL parameters (view, zoom, coordinates, time range, active layers)
- Data freshness monitoring across 28+ data sources with explicit intelligence gap reporting
- Per-feed circuit breakers with 5-minute cooldowns to prevent cascading failures
- **Browser-side ML worker** (Transformers.js) for NER and sentiment analysis without server dependency — controllable via a "Browser Local Model" toggle in AI Flow settings. When disabled, the ML worker is never initialized, eliminating ONNX model downloads and WebGL memory allocation. The toggle propagates dynamically — enabling it mid-session initializes the worker immediately, disabling it terminates it
- **Cmd+K command palette** — fuzzy search across 20+ result types (news, countries, hotspots, markets, bases, cables, datacenters, nuclear facilities, and more), plus layer toggle commands, layer presets (e.g., `layers:military`, `layers:finance`), and instant country brief navigation for all ~250 ISO countries with flag emoji icons. Commands are disambiguated by prefix — `Map: France` flies the map to France, `Brief: France` opens the intelligence dossier, and `Panel: Europe` scrolls to the Europe RSS panel. Curated countries include search aliases (e.g., typing "kremlin" or "putin" finds Russia). Scoring ranks exact matches (3pts) above prefix matches (2pts) above substring matches (1pt). Recent searches are stored in localStorage (max 8 entries). An empty-state tips rotator shows 4 random contextual hints from 6 categories (clickable to prefill the search). Fully localized across all 21 languages
- **Historical playback** — dashboard snapshots are stored in IndexedDB. A time slider allows rewinding to any saved state, with live updates paused during playback
- **TV Mode** — an ambient fullscreen panel cycling mode designed for the Happy variant (also available on all variants). Entering TV Mode goes fullscreen, hides all panels except one, and cycles through each panel and the map on a configurable timer (30 seconds to 2 minutes, default 1 minute). The interval is persisted in localStorage. Press Escape to exit. Driven by CSS via `[data-tv-mode]` data attribute with visual overrides in `happy-theme.css`
- **Badge animation toggle** — an opt-in setting in the unified settings panel ("Badge Animation") enables a CSS `bump` keyframe animation on panel count badges whenever their count increases. Disabled by default to avoid distraction. The Intelligence Findings badge has its own always-on `pulse` animation for new findings
- **Cache purge admin endpoint** — `POST /api/cache-purge` allows targeted Redis key deletion without redeploying. Accepts up to 20 explicit keys and/or 3 glob patterns, uses SCAN-based resolution (max 5 iterations, 200 deletion cap), protects rate-limit and durable data prefixes, and requires timing-safe HMAC authentication via `RELAY_SHARED_SECRET`. Supports `dryRun: true` for preview
- **Mobile-optimized map** — on mobile devices, the map fills the full viewport height for an immersive app-like experience. Touch gestures include single-finger pan with an 8px movement threshold and inertial velocity animation (0.92 decay factor, velocity computed from 4-entry circular touch history), two-finger pinch-to-zoom with center-point preservation, and a bottom-sheet popup mode that slides up from the bottom with drag-to-dismiss (96px threshold). A click guard prevents accidental popup opens after drag gestures. On first load, the browser's GPS is queried (5-second timeout) and the map auto-centers on the user's position at regional zoom — shared map links with embedded coordinates take precedence
- **Mobile detection** — screens below 768px receive a warning modal since the dashboard is designed for multi-panel desktop use. On mobile, the GitHub link is replaced with a settings gear icon for quick access to the unified settings panel
- **World Clock panel** — zero-API-dependency live clocks for 30 curated global financial centers. Auto-detects the user's home city from browser timezone. Each row shows current local time, market open/closed status, and a day/night progress bar. Users add or remove cities via a settings gear. Rows are drag-to-reorder (using `mousedown`/`mousemove`/`mouseup` for WKWebView compatibility), with order persisted to localStorage. Available on full, tech, and finance variants
- **UCDP conflict classification** — countries with active wars (1,000+ battle deaths/year) receive automatic CII floor scores, preventing optimistic drift. The UCDP GED API integration uses automatic version discovery (probing multiple year-based API versions in parallel), negative caching (5-minute backoff after upstream failures), discovered-version caching (1-hour TTL), and stale-on-error fallback to ensure conflict data is always available even when the upstream API is intermittently down
- **HAPI humanitarian data** — UN OCHA humanitarian access metrics and displacement flows feed into country-level instability scoring with dual-perspective (origins vs. hosts) panel
- **Idle-aware resource management** — animations pause after 2 minutes of inactivity and when the tab is hidden, preventing battery drain. Video streams are destroyed from the DOM and recreated on return. On desktop (Tauri), the 3D globe's WebGL render loop pauses when the window loses focus or the globe panel is hidden — any data updates received while paused are queued and flushed in a single batch on resume
- **Country-specific stock indices** — country briefs display the primary stock market index with 1-week change (S&P 500 for US, Shanghai Composite for China, etc.) via the `/api/stock-index` endpoint
- **Climate anomaly panel** — 15 conflict-prone zones monitored for temperature/precipitation deviations against 30-day ERA5 baselines, with severity classification feeding into CII
- **Country brief export** — every brief is downloadable as structured JSON, flattened CSV, or rendered PNG image, enabling offline analysis and reporting workflows
- **Print/PDF support** — country briefs include a print button that triggers the browser's native print dialog, producing clean PDF output
- **Oil & energy analytics** — WTI/Brent crude prices, US production (Mbbl/d), and inventory levels via the EIA API with weekly trend detection
- **Population exposure estimation** — WorldPop density data estimates civilian population within event-specific radii (50–100km) for conflicts, earthquakes, floods, and wildfires
- **Trending keywords panel** — real-time display of surging terms across all RSS feeds with spike severity, source count, and AI-generated context summaries
- **Download banner** — persistent notification for web users linking to native desktop installers for their detected platform
- **Download API** — `/api/download?platform={windows-exe|windows-msi|macos-arm64|macos-x64|linux-appimage}[&variant={full|tech|finance}]` redirects to the matching GitHub Release asset, with fallback to the releases page
- **Universal country coverage** — every country with incoming event data receives a live CII score automatically, not just the 23 curated tier-1 nations. Clicking any country opens a full brief with available data (news, markets, infrastructure), and non-curated countries use sensible default baselines (`DEFAULT_BASELINE_RISK = 15`) with display names resolved via `Intl.DisplayNames`
- **Feature toggles** — 15 runtime toggles (AI/Ollama, AI/Groq, AI/OpenRouter, FRED economic, EIA energy, internet outages, ACLED conflicts, threat intel feeds, AIS relay, OpenSky, Finnhub, NASA FIRMS) stored in `localStorage`, allowing administrators to enable/disable data sources without rebuilding
- **AIS chokepoint detection** — the relay server monitors 8 strategic maritime chokepoints (Strait of Hormuz, Suez Canal, Malacca Strait, Bab el-Mandeb, Panama Canal, Taiwan Strait, South China Sea, Turkish Straits) and classifies transiting vessels by naval candidacy using MMSI prefixes, ship type codes, and name patterns
- **AIS density grid** — vessel positions are aggregated into 2°×2° geographic cells over 30-minute windows, producing a heatmap of maritime traffic density that feeds into convergence detection
- **Panel resizing** — drag handles on panel edges allow height adjustment (span-1 through span-4 grid rows), persisted to localStorage. Double-click resets to default height
- **Ultra-wide monitor layout** — on screens 2000px+ wide, the layout automatically switches from vertical stacking to an L-shaped arrangement: the map floats left at 60% width while panels tile to the right and below it, maximizing screen real estate on ultra-wide and 4K monitors. Uses CSS `display: contents` and float-based wrapping — no JavaScript layout engine required
- **Dark/light theme** — persistent theme toggle with 20+ semantic color variable overrides. Dark theme is the default. Theme preference is stored in localStorage, applied before first paint (no flash of wrong theme), and syncs the `<meta name="theme-color">` for native browser chrome. A `theme-changed` custom event allows panels to react to switches
- **Panel drag-and-drop reordering** — panels can be reordered via drag-and-drop within the grid. The custom order is persisted to localStorage and restored on reload. Touch events are supported for tablet use
- **Map pin mode** — a 📌 button pins the map in a fixed position so it remains visible while scrolling through panels. Pin state is persisted to localStorage
- **Opt-in intelligence alert popups** — the Intelligence Findings badge accumulates signals and alerts silently in the background. A toggle switch in the badge's dropdown header lets users opt in to automatic popup notifications when high-priority findings arrive. The popup preference is stored in localStorage (default: off), so the dashboard never interrupts users who haven't explicitly requested it. The badge continues counting and pulsing regardless of the popup setting — clicking the badge always opens the full findings dropdown

---

## Regression Testing

Map overlay behavior is validated in Playwright using the map harness (`/tests/map-harness.html`).

- Cluster-state cache initialization guard:
  - `updates protest marker click payload after data refresh`
  - `initializes cluster movement cache on first protest cluster render`
- Run by variant:
  - `npm run test:e2e:full -- -g "updates protest marker click payload after data refresh|initializes cluster movement cache on first protest cluster render"`
  - `npm run test:e2e:tech -- -g "updates protest marker click payload after data refresh|initializes cluster movement cache on first protest cluster render"`

---

## How It Works

### Country Brief Pages

Clicking any country on the map opens a full-page intelligence dossier — a single-screen synthesis of all intelligence modules for that country. The brief is organized into a two-column layout:

**Left column**:

- **Instability Index** — animated SVG score ring (0–100) with four component breakdown bars (Unrest, Conflict, Security, Information), severity badge, and trend indicator
- **Intelligence Brief** — AI-generated analysis (Ollama local / Groq / OpenRouter, depending on configured provider) with inline citation anchors `[1]`–`[8]` that scroll to the corresponding news source when clicked
- **Top News** — 8 most relevant headlines for the country, threat-level color-coded, with source and time-ago metadata

**Right column**:

- **Active Signals** — real-time chip indicators for protests, military aircraft, naval vessels, internet outages, earthquakes, displacement flows, climate stress, conflict events, and the country's stock market index (1-week change)
- **7-Day Timeline** — D3.js-rendered event chart with 4 severity-coded lanes (protest, conflict, natural, military), interactive tooltips, and responsive resizing
- **Prediction Markets** — top 3 Polymarket contracts by volume with probability bars and external links
- **Infrastructure Exposure** — pipelines, undersea cables, datacenters, military bases, nuclear facilities, and ports within a 600km radius of the country centroid, ranked by distance

**Headline relevance filtering**: each country has an alias map (e.g., `US → ["united states", "american", "washington", "pentagon", "biden", "trump"]`). Headlines are filtered using a negative-match algorithm — if another country's alias appears earlier in the headline title than the target country's alias, the headline is excluded. This prevents cross-contamination (e.g., a headline about Venezuela mentioning "Washington sanctions" appearing in the US brief).

**Export options**: briefs are exportable as JSON (structured data with all scores, signals, and headlines), CSV (flattened tabular format), or PNG image. A print button triggers the browser's native print dialog for PDF export.

### Local-First Country Detection

Map clicks resolve to countries using a local geometry service rather than relying on network reverse-geocoding (Nominatim). The system loads a GeoJSON file containing polygon boundaries for ~200 countries and builds an indexed spatial lookup:

1. **Bounding box pre-filter** — each country's polygon(s) are wrapped in a bounding box (`[minLon, minLat, maxLon, maxLat]`). Points outside the bbox are rejected without polygon intersection testing.
2. **Ray-casting algorithm** — for points inside the bbox, a ray is cast from the point along the positive x-axis. The number of polygon edge intersections determines inside/outside status (odd = inside). Edge cases are handled: points on segment boundaries return `true`, and polygon holes are subtracted (a point inside an outer ring but also inside a hole is excluded).
3. **MultiPolygon support** — countries with non-contiguous territories (e.g., the US with Alaska and Hawaii, Indonesia with thousands of islands) use MultiPolygon geometries where each polygon is tested independently.

This approach provides sub-millisecond country detection entirely in the browser, with no network latency. The geometry data is preloaded at app startup and cached for the session. For countries not in the GeoJSON (rare), the system falls back to hardcoded rectangular bounding boxes, and finally to network reverse-geocoding as a last resort.

### AI Summarization Chain

The World Brief is generated by a 4-tier provider chain that prioritizes local compute, falls back through cloud APIs, and degrades to browser-side inference as a last resort:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Summarization Request                        │
│  (headlines deduplicated by Jaccard similarity > 0.6)          │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────┐    timeout/error
│  Tier 1: Ollama / LM Studio    │──────────────┐
│  Local endpoint, no cloud       │               │
│  Auto-discovered model          │               │
└─────────────────────────────────┘               │
                                                  ▼
                                   ┌─────────────────────────────┐    timeout/error
                                   │  Tier 2: Groq               │──────────────┐
                                   │  Llama 3.1 8B, temp 0.3     │               │
                                   │  Fast cloud inference        │               │
                                   └─────────────────────────────┘               │
                                                                                 ▼
                                                                  ┌─────────────────────────────┐    timeout/error
                                                                  │  Tier 3: OpenRouter          │──────────────┐
                                                                  │  Multi-model fallback        │               │
                                                                  └─────────────────────────────┘               │
                                                                                                                ▼
                                                                                                 ┌──────────────────────────┐
                                                                                                 │  Tier 4: Browser T5      │
                                                                                                 │  Transformers.js (ONNX)  │
                                                                                                 │  No network required     │
                                                                                                 └──────────────────────────┘
```

All three API tiers (Ollama, Groq, OpenRouter) share a common handler factory (`_summarize-handler.js`) that provides identical behavior:

- **Headline deduplication** — before sending to any LLM, headlines are compared pairwise using word-overlap similarity. Near-duplicates (>60% overlap) are merged, reducing the prompt by 20–40% and preventing the LLM from wasting tokens on repeated stories
- **Variant-aware prompting** — the system prompt adapts to the active dashboard variant. Geopolitical summaries emphasize conflict escalation and diplomatic shifts; tech summaries focus on funding rounds and AI breakthroughs; finance summaries highlight market movements and central bank signals
- **Language-aware output** — when the UI language is non-English, the prompt instructs the LLM to generate the summary in that language
- **Redis deduplication** — summaries are cached with a composite key (`summary:v3:{mode}:{variant}:{lang}:{hash}`) so the same headlines viewed by 1,000 concurrent users trigger exactly one LLM call. Cache TTL is 24 hours
- **Graceful fallback** — if a provider returns `{fallback: true}` (missing API key or endpoint unreachable), the chain silently advances to the next tier. Progress callbacks update the UI to show which provider is being attempted

The Ollama tier communicates via the OpenAI-compatible `/v1/chat/completions` endpoint, making it compatible with any local inference server that implements this standard (Ollama, LM Studio, llama.cpp server, vLLM, etc.).

### AI Deduction & Forecasting

The Deduction Panel is an interactive AI geopolitical analysis tool that produces near-term timeline forecasts grounded in live intelligence data.

**Request pipeline**:

1. The analyst enters a free-text query (e.g., "What will happen in the next 24 hours in the Middle East?") and an optional geographic context field
2. Before submission, `buildNewsContext()` pulls the 15 most recent `NewsItem` titles from the live feed and prepends them as structured context (`"Recent News:\n- Headline (Source)"`) — ensuring the LLM always has current situational awareness
3. The query is sent to the `deductSituation` RPC endpoint, which calls a Groq LLM (or any OpenAI-compatible endpoint via `LLM_API_URL`/`LLM_MODEL` env vars) with a system prompt instructing it to act as a "senior geopolitical intelligence analyst and forecaster"
4. Temperature is 0.3 (low, for analytic consistency), max 1,500 tokens. Chain-of-thought `<think>` tags are stripped as defense-in-depth
5. Results are cached in Redis for 1 hour by `deduct:situation:v1:<hash(query|geoContext)>` — identical queries serve instantly from cache

**Cross-panel integration**: Any panel can dispatch a `wm:deduct-context` custom DOM event with `{ query, geoContext, autoSubmit }`, which pre-fills the Deduction Panel and optionally auto-submits. This enables contextual forecasting from any part of the dashboard — clicking "Analyze" on a theater posture card can automatically trigger a regional deduction. A 5-second cooldown prevents rapid re-submission.

The panel is lazy-loaded (`import()`) to exclude DOMPurify from the main bundle unless the panel is actually accessed, keeping the web bundle lean.

### Client-Side Headline Memory (RAG)

The Headline Memory system provides browser-local Retrieval-Augmented Generation — a persistent semantic index of news headlines that runs entirely on the user's device.

**Ingestion pipeline**:

```
RSS Feed Parse → isHeadlineMemoryEnabled()? → ML Worker (Web Worker)
                                                    │
                                          ┌─────────┴──────────┐
                                          │  ONNX Embeddings   │
                                          │  all-MiniLM-L6-v2  │
                                          │  384-dim float32   │
                                          └─────────┬──────────┘
                                                    │
                                          ┌─────────┴──────────┐
                                          │  IndexedDB Store   │
                                          │  5,000 vector cap  │
                                          │  LRU by ingestAt   │
                                          └────────────────────┘
```

1. After each RSS feed fetch and parse, if Headline Memory is enabled and the embeddings model is loaded, each headline's title, publication date, source, URL, and location tags are sent to the ML Worker
2. The worker sanitizes text (strips control chars, truncates to 200 chars), embeds via the ONNX pipeline (`pooling: 'mean', normalize: true`), and deduplicates by content hash
3. Vectors are written to IndexedDB via a serialized promise queue (preventing concurrent transaction conflicts). When the 5,000-vector cap is exceeded, the oldest entries by `ingestedAt` are evicted

**Search**: Queries are embedded using the same model, then a full cursor scan computes cosine similarity against all stored vectors. Results are ranked by score, capped at `topK` (1–20), and filtered by `minScore` (0–1). Multiple query strings can be searched simultaneously (up to 5), with the max score per record across all queries used for ranking.

**Opt-in mechanism**: The setting defaults to `false` (stored as `wm-headline-memory` in localStorage). Enabling it triggers `mlWorker.init()` → `loadModel('embeddings')`. Disabling it unloads the model and optionally terminates the entire worker if no other ML features are active. The `ai-flow-changed` CustomEvent propagates toggle changes to all interested components.

### Threat Classification Pipeline

Every news item passes through a three-stage classification pipeline:

1. **Keyword classifier** (instant, `source: 'keyword'`) — pattern-matches against ~120 threat keywords organized by severity tier (critical → high → medium → low → info) and 14 event categories (conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general). Keywords use word-boundary regex matching to prevent false positives (e.g., "war" won't match "award"). Each match returns a severity level, category, and confidence score. Variant-specific keyword sets ensure the tech variant doesn't flag "sanctions" in non-geopolitical contexts.

2. **Browser-side ML** (async, `source: 'ml'`) — Transformers.js runs NER, sentiment analysis, and topic classification directly in the browser with no server dependency. Provides a second classification opinion without any API call.

3. **LLM classifier** (batched async, `source: 'llm'`) — headlines are collected into a batch queue and fired as parallel `classifyEvent` RPCs via the sebuf proto client. Each RPC calls the configured LLM provider (Groq Llama 3.1 8B at temperature 0, or Ollama for local inference). Results are cached in Redis (24h TTL) keyed by headline hash. When 500-series errors occur, the LLM classifier automatically pauses its queue to avoid wasting API quota, resuming after an exponential backoff delay. When the LLM result arrives, it overrides the keyword result only if its confidence is higher.

This hybrid approach means the UI is never blocked waiting for AI — users see keyword results instantly, with ML and LLM refinements arriving within seconds and persisting for all subsequent visitors. Each classification carries its `source` tag (`keyword`, `ml`, or `llm`) so downstream consumers can weight confidence accordingly.

### Country Instability Index (CII)

Every country with incoming event data receives a live instability score (0–100). 23 curated tier-1 nations (US, Russia, China, Ukraine, Iran, Israel, Taiwan, North Korea, Saudi Arabia, Turkey, Poland, Germany, France, UK, India, Pakistan, Syria, Yemen, Myanmar, Venezuela, Brazil, UAE, and Japan) have individually tuned baseline risk profiles and keyword lists. All other countries that generate any signal (protests, conflicts, outages, displacement flows, climate anomalies) are scored automatically using a universal default baseline (`DEFAULT_BASELINE_RISK = 15`, `DEFAULT_EVENT_MULTIPLIER = 1.0`). The score is computed from:

| Component                | Weight | Details                                                                                                                                                                                         |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Baseline risk**        | 40%    | Pre-configured per country reflecting structural fragility                                                                                                                                      |
| **Unrest events**        | 20%    | Protests scored logarithmically for democracies (routine protests don't trigger), linearly for authoritarian states (every protest is significant). Boosted for fatalities and internet outages |
| **Security activity**    | 20%    | Military flights (3pts) + vessels (5pts) from own forces + foreign military presence (doubled weight)                                                                                           |
| **Information velocity** | 20%    | News mention frequency weighted by event severity multiplier, log-scaled for high-volume countries                                                                                              |

Additional boosts apply for hotspot proximity, focal point urgency, conflict-zone floors (e.g., Ukraine is pinned at ≥55, Syria at ≥50), GPS/GNSS jamming (up to +35 in Security component), OREF rocket alerts (up to +50 in Conflict component for Israel), and government travel advisories (Do-Not-Travel forces CII ≥ 60 with multi-source consensus bonuses).

### Hotspot Escalation Scoring

Intelligence hotspots receive dynamic escalation scores blending four normalized signals (0–100):

- **News activity** (35%) — article count and severity in the hotspot's area
- **Country instability** (25%) — CII score of the host country
- **Geo-convergence alerts** (25%) — spatial binning detects 3+ event types (protests + military + earthquakes) co-occurring within 1° lat/lon cells
- **Military activity** (15%) — vessel clusters and flight density near the hotspot

The system blends static baseline risk (40%) with detected events (60%) and tracks trends via linear regression on 48-hour history. Signal emissions cool down for 2 hours to prevent alert fatigue.

### Geographic Convergence Detection

Events (protests, military flights, vessels, earthquakes) are binned into 1°×1° geographic cells within a 24-hour window. When 3+ distinct event types converge in one cell, a convergence alert fires. Scoring is based on type diversity (×25pts per unique type) plus event count bonuses (×2pts). Alerts are reverse-geocoded to human-readable names using conflict zones, waterways, and hotspot databases.

### Strategic Theater Posture Assessment

Nine operational theaters are continuously assessed for military posture escalation:

| Theater               | Key Trigger                                 |
| --------------------- | ------------------------------------------- |
| Iran / Persian Gulf   | Carrier groups, tanker activity, AWACS      |
| Taiwan Strait         | PLAAF sorties, USN carrier presence         |
| Baltic / Kaliningrad  | Russian Western Military District flights   |
| Korean Peninsula      | B-52/B-1 deployments, DPRK missile activity |
| Eastern Mediterranean | Multi-national naval exercises              |
| Horn of Africa        | Anti-piracy patrols, drone activity         |
| South China Sea       | Freedom of navigation operations            |
| Arctic                | Long-range aviation patrols                 |
| Black Sea             | ISR flights, naval movements                |

Posture levels escalate from NORMAL → ELEVATED → CRITICAL based on a composite of:

- **Aircraft count** in theater (both resident and transient)
- **Strike capability** — the presence of tankers + AWACS + fighters together indicates strike packaging, not routine training
- **Naval presence** — carrier groups and combatant formations
- **Country instability** — high CII scores for theater-adjacent countries amplify posture

Each theater is linked to 38+ military bases, enabling automatic correlation between observed flights and known operating locations.

### Military Surge & Foreign Presence Detection

The system monitors five operational theaters (Middle East, Eastern Europe, Western Europe, Western Pacific, Horn of Africa) with 38+ associated military bases. It classifies vessel clusters near hotspots by activity type:

- **Deployment** — carrier present with 5+ vessels
- **Exercise** — combatants present in formation
- **Transit** — vessels passing through

Foreign military presence is dual-credited: the operator's country is flagged for force projection, and the host location's country is flagged for foreign military threat. AIS gaps (dark ships) are flagged as potential signal discipline indicators.

### USNI Fleet Intelligence

The dashboard ingests weekly U.S. Naval Institute (USNI) fleet deployment reports and merges them with live AIS vessel tracking data. Each report is parsed for carrier strike groups, amphibious ready groups, and individual combatant deployments — extracting hull numbers, vessel names, operational regions, and mission notes.

The merge algorithm matches USNI entries against live AIS-tracked vessels by hull number and normalized name. Matched vessels receive enrichment: strike group assignment, deployment status (deployed / returning / in-port), and operational theater. Unmatched USNI entries (submarines, vessels running dark) generate synthetic positions based on the last known operational region, with coordinate scattering to prevent marker overlap.

This dual-source approach provides a more complete operational picture than either AIS or USNI alone — AIS reveals real-time positions but misses submarines and vessels with transponders off, while USNI captures the complete order of battle but with weekly lag.

### Aircraft Enrichment

Military flights detected via ADS-B transponder data are enriched through the Wingbits aviation intelligence API, which provides aircraft registration, manufacturer, model, owner, and operator details. Each flight receives a military confidence classification:

| Confidence    | Criteria                                                         |
| ------------- | ---------------------------------------------------------------- |
| **Confirmed** | Operator matches a known military branch or defense contractor  |
| **Likely**    | Aircraft type is exclusively military (tanker, AWACS, fighter)  |
| **Possible**  | Government-registered aircraft in a military operating area      |
| **Civilian**  | No military indicators detected                                 |

Enrichment queries are batched (up to 50 aircraft per request) and cached with a circuit breaker pattern to avoid hammering the upstream API during high-traffic periods. The enriched metadata feeds into the Theater Posture Assessment — a KC-135 tanker paired with F-15s and an E-3 AWACS indicates strike packaging, not routine training.

### Undersea Cable Health Monitoring

Beyond displaying static cable routes on the map, the system actively monitors cable health by cross-referencing two live data sources:

1. **NGA Navigational Warnings** — the U.S. National Geospatial-Intelligence Agency publishes maritime safety broadcasts that frequently mention cable repair operations. The system filters these warnings for cable-related keywords (`CABLE`, `CABLESHIP`, `SUBMARINE CABLE`, `FIBER OPTIC`, etc.) and extracts structured data: vessel names, DMS/decimal coordinates, advisory severity, and repair ETAs. Each warning is matched to the nearest cataloged undersea cable within a 5° geographic radius.

2. **AIS Cable Ship Tracking** — dedicated cable repair vessels (CS Reliance, Île de Bréhat, Cable Innovator, etc.) are identified by name pattern matching against AIS transponder data. Ship status is classified as `enroute` (transiting to repair site) or `on-station` (actively working) based on keyword analysis of the warning text.

Advisories are classified by severity: `fault` (cable break, cut, or damage — potential traffic rerouting) or `degraded` (repair work in progress with partial capacity). Impact descriptions are generated dynamically, linking the advisory to the specific cable and the countries it serves — enabling questions like "which cables serving South Asia are currently under repair?"

**Health scoring algorithm** — Each cable receives a composite health score (0–100) computed from weighted signals with exponential time decay:

```
signal_weight = severity × (e^(-λ × age_hours))     where λ = ln(2) / 168 (7-day half-life)
health_score  = max(0, 100 − Σ(signal_weights) × 100)
```

Signals are classified into two kinds: `operator_fault` (confirmed cable damage — severity 1.0) and `cable_advisory` (repair operations, navigational warnings — severity 0.6). Geographic matching uses cosine-latitude-corrected equirectangular approximation to find the nearest cataloged cable within 50km of each NGA warning's coordinates. Results are cached in Redis (6-hour TTL for complete results, 10 minutes for partial) with an in-memory fallback that serves stale data when Redis is unavailable — ensuring the cable health layer never shows blank data even during cache failures.

### Infrastructure Cascade Modeling

Beyond proximity correlation, the system models how disruptions propagate through interconnected infrastructure. A dependency graph connects undersea cables, pipelines, ports, chokepoints, and countries with weighted edges representing capacity dependencies:

```
Disruption Event → Affected Node → Cascade Propagation (BFS, depth ≤ 3)
                                          │
                    ┌─────────────────────┤
                    ▼                     ▼
            Direct Impact         Indirect Impact
         (e.g., cable cut)    (countries served by cable)
```

**Impact calculation**: `strength = edge_weight × disruption_level × (1 − redundancy)`

Strategic chokepoint modeling captures real-world dependencies:

- **Strait of Hormuz** — 80% of Japan's oil, 70% of South Korea's, 60% of India's, 40% of China's
- **Suez Canal** — EU-Asia trade routes (Germany, Italy, UK, China)
- **Malacca Strait** — 80% of China's oil transit

Ports are weighted by type: oil/LNG terminals (0.9 — critical), container ports (0.7), naval bases (0.4 — geopolitical but less economic). This enables questions like "if the Strait of Hormuz closes, which countries face energy shortages within 30 days?"

### Related Assets & Proximity Correlation

When a news event is geo-located, the system automatically identifies critical infrastructure within a 600km radius — pipelines, undersea cables, data centers, military bases, and nuclear facilities — ranked by distance. This enables instant geopolitical context: a cable cut near a strategic chokepoint, a protest near a nuclear facility, or troop movements near a data center cluster.

### News Geo-Location

A 217-hub strategic location database infers geography from headlines via keyword matching. Hubs span capitals, conflict zones, strategic chokepoints (Strait of Hormuz, Suez Canal, Malacca Strait), and international organizations. Confidence scoring is boosted for critical-tier hubs and active conflict zones, enabling map-driven news placement without requiring explicit location metadata from RSS feeds.

### Entity Index & Cross-Referencing

A structured entity registry catalogs countries, organizations, world leaders, and military entities with multiple lookup indices:

| Index Type        | Purpose               | Example                                         |
| ----------------- | --------------------- | ----------------------------------------------- |
| **ID index**      | Direct entity lookup  | `entity:us` → United States profile             |
| **Alias index**   | Name variant matching | "America", "USA", "United States" → same entity |
| **Keyword index** | Contextual detection  | "Pentagon", "White House" → United States       |
| **Sector index**  | Domain grouping       | "military", "energy", "tech"                    |
| **Type index**    | Category filtering    | "country", "organization", "leader"             |

Entity matching uses word-boundary regex to prevent false positives (e.g., "Iran" matching "Ukraine"). Confidence scores are tiered by match quality: exact name matches score 1.0, aliases 0.85–0.95, and keyword matches 0.7. When the same entity surfaces across multiple independent data sources (news, military tracking, protest feeds, market signals), the system identifies it as a focal point and escalates its prominence in the intelligence picture.

### Temporal Baseline Anomaly Detection

Rather than relying on static thresholds, the system learns what "normal" looks like and flags deviations. Each event type (military flights, naval vessels, protests, news velocity, AIS gaps, satellite fires) is tracked per region with separate baselines for each weekday and month — because military activity patterns differ on Tuesdays vs. weekends, and January vs. July.

The algorithm uses **Welford's online method** for numerically stable streaming computation of mean and variance, stored in Redis with a 90-day rolling window. When a new observation arrives, its z-score is computed against the learned baseline. Thresholds:

| Z-Score | Severity      | Example                            |
| ------- | ------------- | ---------------------------------- |
| ≥ 1.5   | Low           | Slightly elevated protest activity |
| ≥ 2.0   | Medium        | Unusual naval presence             |
| ≥ 3.0   | High/Critical | Military flights 3x above baseline |

A minimum of 10 historical samples is required before anomalies are reported, preventing false positives during the learning phase. Anomalies are ingested back into the signal aggregator, where they compound with other signals for convergence detection.

### Trending Keyword Spike Detection

Every RSS headline is tokenized into individual terms and tracked in per-term frequency maps. A 2-hour rolling window captures current activity while a 7-day baseline (refreshed hourly) establishes what "normal" looks like for each term. A spike fires when all conditions are met:

| Condition            | Threshold                                     |
| -------------------- | --------------------------------------------- |
| **Absolute count**   | > `minSpikeCount` (5 mentions)                |
| **Relative surge**   | > baseline × `spikeMultiplier` (3×)           |
| **Source diversity** | ≥ 2 unique RSS feed sources                   |
| **Cooldown**         | 30 minutes since last spike for the same term |

The tokenizer extracts CVE identifiers (`CVE-2024-xxxxx`), APT/FIN threat actor designators, and 12 compound terms for world leaders (e.g., "Xi Jinping", "Kim Jong Un") that would be lost by naive whitespace splitting. A configurable blocklist suppresses common noise terms.

Detected spikes are auto-summarized via Groq (rate-limited to 5 summaries/hour) and emitted as `keyword_spike` signals into the correlation engine, where they compound with other signal types for convergence detection. The term registry is capped at 10,000 entries with LRU eviction to bound memory usage. All thresholds (spike multiplier, min count, cooldown, blocked terms) are configurable via the Settings panel.

### Breaking News Alert Pipeline

The dashboard monitors five independent alert origins and fuses them into a unified breaking news stream with layered deduplication, cooldowns, and source quality gating:

| Origin               | Trigger                                                        | Example                                      |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| **RSS alert**        | News item with `isAlert: true` and threat level critical/high  | Reuters flash: missile strike confirmed       |
| **Keyword spike**    | Trending keyword exceeds spike threshold                       | "nuclear" surges across 8+ feeds in 2 hours  |
| **Hotspot escalation** | Hotspot escalation score exceeds critical threshold          | Taiwan Strait tension crosses 80/100         |
| **Military surge**   | Theater posture assessment detects strike packaging            | Tanker + AWACS + fighters co-present in MENA |
| **OREF siren**       | Israel Home Front Command issues incoming rocket/missile alert | Rocket barrage detected in northern Israel   |

**Anti-noise safeguards**:

- **Per-event dedup** — each alert is keyed by a content hash; repeated alerts for the same event are suppressed for 30 minutes
- **Global cooldown** — after any alert fires, a 60-second global cooldown prevents rapid-fire notification bursts
- **Recency gate** — items older than 15 minutes at processing time are silently dropped, preventing stale events from generating alerts after a reconnection
- **Source tier gating** — Tier 3+ sources (niche outlets, aggregators) must have LLM-confirmed classification (`threat.source !== 'keyword'`) to fire an alert; Tier 1–2 sources bypass this gate
- **User sensitivity control** — configurable between `critical-only` (only critical severity fires) and `critical-and-high` (both critical and high severities)

When an alert passes all gates, the system dispatches a `wm:breaking-news` CustomEvent on `document`, which the Breaking News Banner consumes to display a persistent top-of-screen notification. Optional browser Notification API popups and an audio chime are available as user settings. Clicking the banner scrolls to the RSS panel that sourced the alert and applies a 1.5-second flash highlight animation.

### Telegram OSINT Intelligence Feed

26 curated Telegram channels provide a raw, low-latency intelligence feed covering conflict zones, OSINT analysis, and breaking news — sources that are often minutes ahead of traditional wire services during fast-moving events.

| Tier       | Channels                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| **Tier 1** | VahidOnline (Iran politics)                                                                                           |
| **Tier 2** | Abu Ali Express, Aurora Intel, BNO News, Clash Report, DeepState, Defender Dome, Iran International, LiveUAMap, OSINTdefender, OSINT Updates, Ukraine Air Force (kpszsu), Povitryani Tryvoha |
| **Tier 3** | Bellingcat, CyberDetective, GeopoliticalCenter, Middle East Spectator, Middle East Now Breaking, NEXTA, OSINT Industries, OsintOps News, OSINT Live, OsintTV, The Spectator Index, War Monitor, WFWitness |

**Architecture**: A GramJS MTProto client running on the Railway relay polls all channels sequentially on a 60-second cycle. Each channel has a 15-second timeout (GramJS `getEntity`/`getMessages` can hang indefinitely on FLOOD_WAIT or MTProto stalls), and the entire cycle has a 3-minute hard timeout. A stuck-poll guard force-clears the mutex after 3.5 minutes, and FLOOD_WAIT errors from Telegram's API stop the cycle early rather than propagating to every remaining channel.

Messages are deduplicated by ID, filtered to exclude media-only posts (images without text), truncated to 800 characters, and stored in a rolling 200-item buffer. The relay connects with a 60-second startup delay to prevent `AUTH_KEY_DUPLICATED` errors during Railway container restarts (the old container must fully disconnect before the new one authenticates). Topic classification (breaking, conflict, alerts, osint, politics, middleeast) and channel-based filtering happen at query time via the `/telegram/feed` relay endpoint.

### OREF Rocket Alert Integration

The dashboard monitors Israel's Home Front Command (Pikud HaOref) alert system for incoming rocket, missile, and drone sirens — a real-time signal that is difficult to obtain programmatically due to Akamai WAF protection.

**Data flow**: The Railway relay polls `oref.org.il` using `curl` (not Node.js fetch, which is JA3-blocked) through a residential proxy with an Israeli exit IP. On startup, the relay bootstraps history via a two-phase strategy: Phase 1 loads from Redis (filtering entries older than 7 days); if Redis is empty, Phase 2 fetches from the upstream OREF API with exponential backoff retry (up to 3 attempts, delays of 3s/6s/12s + jitter). Alert history is persisted to Redis with dirty-flag deduplication to prevent redundant writes. Live alerts are polled every 5 minutes. Wave detection groups individual siren records by timestamp to identify distinct attack waves. Israel-local timestamps are converted to UTC with DST-aware offset calculation. **1,480 Hebrew→English location translations** — an auto-generated dictionary (from the pikud-haoref-api `cities.json` source) enables automatic translation of Hebrew city names in alert data. Unicode bidirectional control characters are stripped via `sanitizeHebrew()` before translation lookups to prevent mismatches.

**CII integration**: Active OREF alerts boost Israel's CII conflict component by up to 50 points (`25 + min(25, alertCount × 5)`). Rolling 24-hour history adds a secondary boost: 3–9 alerts in the window contribute +5, 10+ contribute +10 to the blended score. This means a sustained multi-wave rocket barrage drives Israel's CII significantly higher than a single isolated alert.

### GPS/GNSS Interference Detection

GPS jamming and spoofing — increasingly used as electronic warfare in conflict zones — is detected by analyzing ADS-B transponder data from aircraft that report GPS anomalies. Data is sourced from [gpsjam.org](https://gpsjam.org), which aggregates ADS-B Exchange data into H3 resolution-4 hexagonal grid cells.

**Classification**: Each H3 cell reports the ratio of aircraft with GPS anomalies vs. total aircraft. Cells with fewer than 3 aircraft are excluded as statistically noisy. The remaining cells are classified:

| Interference Level | Bad Aircraft % | Map Color |
| ------------------ | -------------- | --------- |
| **Low**            | 0–2%           | Hidden    |
| **Medium**         | 2–10%          | Amber     |
| **High**           | > 10%          | Red       |

**Region tagging**: Each hex cell is tagged to one of 12 named conflict regions via bounding-box classification (Iran-Iraq, Levant, Ukraine-Russia, Baltic, Mediterranean, Black Sea, Arctic, Caucasus, Central Asia, Horn of Africa, Korean Peninsula, South China Sea) for filtered region views.

**CII integration**: `ingestGpsJammingForCII` maps each H3 hex centroid to a country via the local geometry service, then accumulates per-country interference counts. In the CII security component, GPS jamming contributes up to 35 points: `min(35, highCount × 5 + mediumCount × 2)`.

### Security Advisory Aggregation

Government travel advisories serve as expert risk assessments from national intelligence agencies — when the US State Department issues a "Do Not Travel" advisory, it reflects classified threat intelligence that no open-source algorithm can replicate.

**Sources**: 4 government advisory feeds (US State Dept, Australia DFAT Smartraveller, UK FCDO, New Zealand MFAT), 13 US Embassy country-specific alert feeds (Thailand, UAE, Germany, Ukraine, Mexico, India, Pakistan, Colombia, Poland, Bangladesh, Italy, Dominican Republic, Myanmar), and health agency feeds (CDC Travel Notices, ECDC epidemiological updates, WHO News, WHO Africa Emergencies).

**Advisory levels** (ranked): Do-Not-Travel (4) → Reconsider Travel (3) → Exercise Caution (2) → Normal (1) → Info (0). Both RSS (`<item>`) and Atom (`<entry>`) formats are parsed. Country extraction uses regex parsing of advisory titles with `nameToCountryCode()` lookup.

**CII integration** — advisories feed into instability scores through two mechanisms:

- **Score boost**: Do-Not-Travel → +15 points, Reconsider → +10, Caution → +5. Multi-source agreement adds a consensus bonus: ≥3 governments concur → +5, ≥2 → +3
- **Score floor**: Do-Not-Travel from any government forces a minimum CII score of 60; Reconsider forces minimum 50. This prevents a country with low event data but active DNT warnings from showing an artificially calm score

The Security Advisories panel displays advisories with colored level badges and source country flags, filterable by severity (Critical, All) and issuing government (US, AU, UK, NZ, Health).

### Airport Delay & NOTAM Monitoring

107 airports across 5 regions (Americas, Europe, Asia-Pacific, MENA, Africa) are continuously monitored for delays, ground stops, and closures through three independent data sources:

| Source             | Coverage                  | Method                                                                                                  |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| **FAA ASWS**       | 14 US hub airports        | Real-time XML feed from `nasstatus.faa.gov` — ground delays, ground stops, arrival/departure delays, closures |
| **AviationStack**  | 40 international airports  | Last 100 flights per airport — cancellation rate and average delay duration computed from flight records  |
| **ICAO NOTAM API** | 46 MENA airports           | Real-time NOTAM (Notice to Air Missions) query for active airport/airspace closures                      |

**NOTAM closure detection** targets MENA airports where airspace closures due to military activity or security events carry strategic significance. Detection uses two methods: ICAO Q-code matching (aerodrome/airspace closure codes `FA`, `AH`, `AL`, `AW`, `AC`, `AM` combined with closure qualifiers `LC`, `AS`, `AU`, `XX`, `AW`) and free-text regex scanning for closure keywords (`AD CLSD`, `AIRPORT CLOSED`, `AIRSPACE CLOSED`). When a NOTAM closure is detected, it overrides any existing delay alert for that airport with a `severe/closure` classification.

**Severity thresholds**: Average delay ≥15min or ≥15% delayed flights = minor; ≥30min/30% = moderate; ≥45min/45% = major; ≥60min/60% = severe. Cancellation rate ≥80% with ≥10 flights = closure. All results are cached for 30 minutes in Redis. When no AviationStack API key is configured, the system generates probabilistic simulated delays for demonstration — rush-hour windows and high-traffic airports receive higher delay probability.

### Strategic Risk Score Algorithm

The Strategic Risk panel computes a 0–100 composite geopolitical risk score that synthesizes data from all intelligence modules into a single, continuously updated metric.

**Composite formula**:

```
compositeScore =
    convergenceScore × 0.30     // multi-type events co-located in same H3 cell
  + ciiRiskScore     × 0.50     // CII top-5 country weighted blend
  + infraScore       × 0.20     // infrastructure cascade incidents
  + theaterBoost     (0–25)     // military asset density + strike packaging
  + breakingBoost    (0–15)     // breaking news severity injection
```

**Sub-scores**:

- `convergenceScore` — `min(100, convergenceAlertCount × 25)`. Each geographic cell with 3+ distinct event types contributing 25 points
- `ciiRiskScore` — Top 5 countries by CII score, weighted `[0.40, 0.25, 0.20, 0.10, 0.05]`, with a bonus of `min(20, elevatedCount × 5)` for each country above CII 50
- `infraScore` — `min(100, cascadeAlertCount × 25)`. Each infrastructure cascade incident contributing 25 points
- `theaterBoost` — For each theater posture summary: `min(10, floor((aircraft + vessels) / 5))` + 5 if strike-capable (tanker + AWACS + fighters co-present). Summed across theaters, capped at 25. Halved when posture data is stale
- `breakingBoost` — Critical breaking news alerts add 15 points, high adds 8, capped at 15. Breaking alerts expire after 30 minutes

**Alert fusion**: Alerts from convergence detection, CII spikes (≥10-point change), and infrastructure cascades are merged when they occur within a 2-hour window and are within 200km or in the same country. Merged alerts carry the highest priority and combine summaries. The alert queue caps at 50 entries with 24-hour pruning.

**Trend detection**: Delta ≥3 from previous composite = "escalating", ≤−3 = "de-escalating", otherwise "stable". A 15-minute learning period after panel initialization suppresses CII spike alerts to prevent false positives from initial data loading.

### Proto-First API Contracts

The entire API surface is defined in Protocol Buffer (`.proto`) files using [sebuf](https://github.com/SebastienMelki/sebuf) HTTP annotations. Code generation produces TypeScript clients, server handler stubs, and OpenAPI 3.1.0 documentation from a single source of truth — eliminating request/response schema drift between frontend and backend.

**22 service domains** cover every data vertical:

| Domain           | RPCs                                             |
| ---------------- | ------------------------------------------------ |
| `aviation`       | Airport delays (FAA, AviationStack, ICAO NOTAM)  |
| `climate`        | Climate anomalies                                |
| `conflict`       | ACLED events, UCDP events, humanitarian summaries|
| `cyber`          | Cyber threat IOCs                                |
| `displacement`   | Population displacement, exposure data           |
| `economic`       | Energy prices, FRED series, macro signals, World Bank, BIS policy rates, exchange rates, credit-to-GDP |
| `infrastructure` | Internet outages, service statuses, temporal baselines |
| `intelligence`   | Event classification, country briefs, risk scores|
| `maritime`       | Vessel snapshots, navigational warnings          |
| `market`         | Stock indices, crypto/commodity quotes, ETF flows|
| `military`       | Aircraft details, theater posture, USNI fleet    |
| `news`           | News items, article summarization                |
| `prediction`     | Prediction markets                               |
| `research`       | arXiv papers, HackerNews, tech events            |
| `seismology`     | Earthquakes                                      |
| `supply-chain`   | Chokepoint disruption scores, shipping rates, critical mineral concentration |
| `trade`          | WTO trade restrictions, tariff trends, trade flows, trade barriers |
| `unrest`         | Protest/unrest events                            |
| `wildfire`       | Fire detections                                  |
| `giving`         | Donation platform volumes, crypto giving, ODA    |
| `positive-events`| Positive news classification, conservation data  |

**Code generation pipeline** — a `Makefile` drives `buf generate` with three custom sebuf protoc plugins:

1. `protoc-gen-ts-client` → typed fetch-based client classes (`src/generated/client/`)
2. `protoc-gen-ts-server` → handler interfaces and route descriptors (`src/generated/server/`)
3. `protoc-gen-openapiv3` → OpenAPI 3.1.0 specs in YAML and JSON (`docs/api/`)

Proto definitions include `buf.validate` field constraints (e.g., latitude ∈ [−90, 90]), so request validation is generated automatically — handlers receive pre-validated data. Breaking changes are caught at CI time via `buf breaking` against the main branch.

**Edge gateway** — a single Vercel Edge Function (`api/[domain]/v1/[rpc].ts`) imports all 22 `createServiceRoutes()` functions into a flat `Map<string, handler>` router. Every RPC is a POST endpoint at a static path (e.g., `POST /api/aviation/v1/list-airport-delays`), with CORS enforcement, a top-level error boundary that hides internal details on 5xx responses, and rate-limit support (`retryAfter` on 429). The same router runs locally via a Vite dev-server plugin (`sebufApiPlugin` in `vite.config.ts`) with HMR invalidation on handler changes.

### Cyber Threat Intelligence Layer

Six threat intelligence feeds provide indicators of compromise (IOCs) for active command-and-control servers, malware distribution hosts, phishing campaigns, malicious URLs, and ransomware operations:

| Feed                         | IOC Type      | Coverage                        |
| ---------------------------- | ------------- | ------------------------------- |
| **Feodo Tracker** (abuse.ch) | C2 servers    | Botnet C&C infrastructure       |
| **URLhaus** (abuse.ch)       | Malware hosts | Malware distribution URLs       |
| **C2IntelFeeds**             | C2 servers    | Community-sourced C2 indicators |
| **AlienVault OTX**           | Mixed         | Open threat exchange pulse IOCs |
| **AbuseIPDB**                | Malicious IPs | Crowd-sourced abuse reports     |
| **Ransomware.live**          | Ransomware    | Active ransomware group feeds   |

Each IP-based IOC is geo-enriched using ipinfo.io with freeipapi.com as fallback. Geolocation results are Redis-cached for 24 hours. Enrichment runs concurrently — 16 parallel lookups with a 12-second timeout, processing up to 250 IPs per collection run.

IOCs are classified into four types (`c2_server`, `malware_host`, `phishing`, `malicious_url`) with four severity levels, rendered as color-coded scatter dots on the globe. The layer uses a 10-minute cache, a 14-day rolling window, and caps display at 500 IOCs to maintain rendering performance.

### Natural Disaster Monitoring

Three independent sources are merged into a unified disaster picture, then deduplicated on a 0.1° geographic grid:

| Source         | Coverage                       | Types                                                         | Update Frequency |
| -------------- | ------------------------------ | ------------------------------------------------------------- | ---------------- |
| **USGS**       | Global earthquakes M4.5+       | Earthquakes                                                   | 5 minutes        |
| **GDACS**      | UN-coordinated disaster alerts | Earthquakes, floods, cyclones, volcanoes, wildfires, droughts | Real-time        |
| **NASA EONET** | Earth observation events       | 13 natural event categories (30-day open events)              | Real-time        |

GDACS events carry color-coded alert levels (Red = critical, Orange = high) and are filtered to exclude low-severity Green alerts. EONET wildfires are filtered to events within 48 hours to prevent stale data. Earthquakes from EONET are excluded since USGS provides higher-quality seismological data.

The merged output feeds into the signal aggregator for geographic convergence detection — e.g., an earthquake near a pipeline triggers an infrastructure cascade alert.

### Dual-Source Protest Tracking

Protest data is sourced from two independent providers to reduce single-source bias:

1. **ACLED** (Armed Conflict Location & Event Data) — 30-day window, tokenized API with Redis caching (10-minute TTL). Covers protests, riots, strikes, and demonstrations with actor attribution and fatality counts.
2. **GDELT** (Global Database of Events, Language, and Tone) — 7-day geospatial event feed filtered to protest keywords. Events with mention count ≥5 are included; those above 30 are marked as `validated`.

Events from both sources are **Haversine-deduplicated** on a 0.1° grid (~10km) with same-day matching. ACLED events take priority due to higher editorial confidence. Severity is classified as:

- **High** — fatalities present or riot/clash keywords
- **Medium** — standard protest/demonstration
- **Low** — default

Protest scoring is regime-aware: democratic countries use logarithmic scaling (routine protests don't trigger instability), while authoritarian states use linear scoring (every protest is significant). Fatalities and concurrent internet outages apply severity boosts.

### Climate Anomaly Detection

15 conflict-prone and disaster-prone zones are continuously monitored for temperature and precipitation anomalies using Open-Meteo ERA5 reanalysis data. A 30-day baseline is computed, and current conditions are compared against it to determine severity:

| Severity     | Temperature Deviation | Precipitation Deviation   |
| ------------ | --------------------- | ------------------------- |
| **Extreme**  | > 5°C above baseline  | > 80mm/day above baseline |
| **Moderate** | > 3°C above baseline  | > 40mm/day above baseline |
| **Normal**   | Within expected range | Within expected range     |

Anomalies feed into the signal aggregator, where they amplify CII scores for affected countries (climate stress is a recognized conflict accelerant). The Climate Anomaly panel surfaces these deviations in a severity-sorted list.

### Displacement Tracking

Refugee and displacement data is sourced from the UN OCHA Humanitarian API (HAPI), providing population-level counts for refugees, asylum seekers, and internally displaced persons (IDPs). The Displacement panel offers two perspectives:

- **Origins** — countries people are fleeing from, ranked by outflow volume
- **Hosts** — countries absorbing displaced populations, ranked by intake

Crisis badges flag countries with extreme displacement: > 1 million displaced (red), > 500,000 (orange). Displacement outflow feeds into the CII as a component signal — high displacement is a lagging indicator of instability that persists even when headlines move on.

### Population Exposure Estimation

Active events (conflicts, earthquakes, floods, wildfires) are cross-referenced against WorldPop population density data to estimate the number of civilians within the impact zone. Event-specific radii reflect typical impact footprints:

| Event Type      | Radius | Rationale                                |
| --------------- | ------ | ---------------------------------------- |
| **Conflicts**   | 50 km  | Direct combat zone + displacement buffer |
| **Earthquakes** | 100 km | Shaking intensity propagation            |
| **Floods**      | 100 km | Watershed and drainage basin extent      |
| **Wildfires**   | 30 km  | Smoke and evacuation perimeter           |

API calls to WorldPop are batched concurrently (max 10 parallel requests) to handle multiple simultaneous events without sequential bottlenecks. The Population Exposure panel displays a summary header with total affected population and a per-event breakdown table.

### Strategic Port Infrastructure

83 strategic ports are cataloged across six types, reflecting their role in global trade and military posture:

| Type           | Count | Examples                                             |
| -------------- | ----- | ---------------------------------------------------- |
| **Container**  | 21    | Shanghai (#1, 47M+ TEU), Singapore, Ningbo, Shenzhen |
| **Oil/LNG**    | 8     | Ras Tanura (Saudi), Sabine Pass (US), Fujairah (UAE) |
| **Chokepoint** | 8     | Suez Canal, Panama Canal, Strait of Malacca          |
| **Naval**      | 6     | Zhanjiang, Yulin (China), Vladivostok (Russia)       |
| **Mixed**      | 15+   | Ports serving multiple roles (trade + military)      |
| **Bulk**       | 20+   | Regional commodity ports                             |

Ports are ranked by throughput and weighted by strategic importance in the infrastructure cascade model: oil/LNG terminals carry 0.9 criticality, container ports 0.7, and naval bases 0.4. Port proximity appears in the Country Brief infrastructure exposure section.

### Browser-Side ML Pipeline

The dashboard runs a full ML pipeline in the browser via Transformers.js, with no server dependency for core intelligence. This is automatically disabled on mobile devices to conserve memory.

| Capability                   | Model               | Use                                               |
| ---------------------------- | ------------------- | ------------------------------------------------- |
| **Text embeddings**          | sentence-similarity | Semantic clustering of news headlines             |
| **Sequence classification**  | threat-classifier   | Threat severity and category detection            |
| **Summarization**            | T5-small            | Last-resort fallback when Ollama, Groq, and OpenRouter are all unavailable |
| **Named Entity Recognition** | NER pipeline        | Country, organization, and leader extraction      |

**Hybrid clustering** combines fast Jaccard similarity (n-gram overlap, threshold 0.4) with ML-refined semantic similarity (cosine similarity, threshold 0.78). Jaccard runs instantly on every refresh; semantic refinement runs when the ML worker is loaded and merges clusters that are textually different but semantically identical (e.g., "NATO expands missile shield" and "Alliance deploys new air defense systems").

News velocity is tracked per cluster — when multiple Tier 1–2 sources converge on the same story within a short window, the cluster is flagged as a breaking alert with `sourcesPerHour` as the velocity metric.

### Live Webcam Surveillance Grid

22 YouTube live streams from geopolitical hotspots across 5 regions provide continuous visual situational awareness:

| Region             | Cities                                                           |
| ------------------ | ---------------------------------------------------------------- |
| **Iran / Attacks** | Tehran, Tel Aviv, Jerusalem (Western Wall)                       |
| **Middle East**    | Jerusalem (Western Wall), Tehran, Tel Aviv, Mecca (Grand Mosque) |
| **Europe**         | Kyiv, Odessa, Paris, St. Petersburg, London                      |
| **Americas**       | Washington DC, New York, Los Angeles, Miami                      |
| **Asia-Pacific**   | Taipei, Shanghai, Tokyo, Seoul, Sydney                           |

The webcam panel supports two viewing modes: a 4-feed grid (default strategic selection: Jerusalem, Tehran, Kyiv, Washington DC) and a single-feed expanded view. Region tabs (ALL/IRAN/MIDEAST/EUROPE/AMERICAS/ASIA) filter the available feeds. The Iran/Attacks tab provides a dedicated 2×2 grid for real-time visual monitoring during escalation events between Iran and Israel.

Resource management is aggressive — iframes are lazy-loaded via Intersection Observer (only rendered when the panel scrolls into view), paused after 5 minutes of user inactivity, and destroyed from the DOM entirely when the browser tab is hidden. On Tauri desktop, YouTube embeds route through a cloud proxy to bypass WKWebView autoplay restrictions. Each feed carries a fallback video ID in case the primary stream goes offline.

### Server-Side Feed Aggregation

Rather than each client browser independently fetching dozens of RSS feeds through individual edge function invocations, the `listFeedDigest` RPC endpoint aggregates all feeds server-side into a single categorized response.

**Architecture**:

```
Client (1 RPC call) → listFeedDigest → Redis check (digest:v1:{variant}:{lang})
                                              │
                                    ┌─────────┴─── HIT → return cached digest
                                    │
                                    ▼ MISS
                           ┌─────────────────────────┐
                           │  buildDigest()           │
                           │  20 concurrent fetches   │
                           │  8s per-feed timeout     │
                           │  25s overall deadline    │
                           └────────┬────────────────┘
                                    │
                              ┌─────┴─────┐
                              │ Per-feed   │ ← cached 600s per URL
                              │ Redis      │
                              └─────┬─────┘
                                    │
                                    ▼
                           ┌─────────────────────────┐
                           │  Categorized digest      │
                           │  Cached 900s (15 min)    │
                           │  Per-item keyword class.  │
                           └─────────────────────────┘
```

The digest cache key is `news:digest:v1:{variant}:{lang}` with a 900-second TTL. Individual feed results are separately cached per URL for 600 seconds. Items per feed are capped at 5, categories at 20 items each. XML parsing is edge-runtime-compatible (regex-based, no DOM parser), handling both RSS `<item>` and Atom `<entry>` formats. Each item is keyword-classified at aggregation time. An in-memory fallback cache (capped at 50 entries) provides last-known-good data if Redis fails.

This eliminates per-client feed fan-out — 1,000 concurrent users each polling 25 feed categories would have generated 25,000 edge invocations per poll cycle. With server-side aggregation, they generate exactly 1 (or 0 if the digest is cached).

### Bootstrap Hydration

The dashboard eliminates cold-start latency by pre-fetching 15 commonly needed datasets in a single Redis pipeline call before any panel renders. On page load, the client fires two parallel requests — a **fast tier** and a **slow tier** — to the `/api/bootstrap` edge function, both with an 800ms abort timeout to avoid blocking first paint.

```
Page Load → parallel fetch ─┬─ /api/bootstrap?tier=fast  (s-maxage=600)
                             │    earthquakes, outages, serviceStatuses,
                             │    macroSignals, chokepoints
                             │
                             └─ /api/bootstrap?tier=slow  (s-maxage=3600)
                                  bisPolicy, bisExchange, bisCredit,
                                  minerals, giving, sectors, etfFlows,
                                  shippingRates, wildfires, climateAnomalies
```

The edge function reads all keys in a single Upstash Redis pipeline — one HTTP round-trip for 15 keys. Results are stored in an in-memory `hydrationCache` Map. When panels initialize, they call `getHydratedData(key)` which returns the pre-fetched data and evicts it from the cache (one-time read) to free memory. Panels that find hydrated data skip their initial API call entirely, rendering instantly with pre-loaded content. Panels that mount after the hydration data has been consumed fall back to their normal fetch cycle.

This converts 15 independent API calls (each with its own DNS lookup, TLS handshake, and Redis round-trip) into exactly 2, cutting first-meaningful-paint time by 2–4 seconds on typical connections.

### Desktop Auto-Update

The desktop app checks for new versions by polling `worldmonitor.app/api/version` — once at startup (after a 5-second delay) and then every 6 hours. When a newer version is detected (semver comparison), a non-intrusive update badge appears with a direct link to the GitHub Release page.

Update prompts are dismissable per-version — dismissing v2.5.0 won't suppress v2.6.0 notifications. The updater is variant-aware: a Tech Monitor desktop build links to the Tech Monitor release asset, not the full variant.

The `/api/version` endpoint reads the latest GitHub Release tag and caches the result for 1 hour, so version checks don't hit the GitHub API on every request.

### Theme System

The dashboard supports dark and light themes with a toggle in the header bar. Dark is the default, matching the OSINT/command-center aesthetic.

Theme state is stored in localStorage and applied via a `[data-theme="light"]` attribute on the root element. Critically, the theme is applied before any components mount — an inline script in `index.html` reads the preference and sets the attribute synchronously, preventing a flash of the wrong theme on load.

20+ CSS custom properties are overridden in light mode to maintain contrast ratios: severity colors shift (e.g., `--semantic-high` changes from `#ff8800` to `#ea580c`), backgrounds lighten, and text inverts. Language-specific font stacks switch in `:lang()` selectors — Arabic uses Geeza Pro, Chinese uses PingFang SC.

**Typography** — the dashboard uses a consolidated `--font-mono` CSS custom property that cascades through the entire UI: SF Mono → Monaco → Cascadia Code → Fira Code → DejaVu Sans Mono → Liberation Mono → system monospace. This single variable ensures typographic consistency across macOS (SF Mono/Monaco), Windows (Cascadia Code), and Linux (DejaVu Sans Mono/Liberation Mono). The settings window inherits the same variable, preventing font divergence between the main dashboard and configuration UI.

A `theme-changed` CustomEvent is dispatched on toggle, allowing panels with custom rendering (charts, maps, gauges) to re-render with the new palette.

### Localization Architecture

The dashboard supports 21 languages with a locale system designed to minimize bundle size while maximizing coverage:

**Language bundles** are stored as JSON files (`src/locales/{code}.json`) and lazy-loaded on demand — only the active language is fetched at runtime, keeping the initial JavaScript bundle free of translation strings. The English locale serves as the fallback: if a key is missing from a non-English locale, the English value is displayed automatically. Language detection follows the cascade: `localStorage` preference → `navigator.language` → English.

**Native-language RSS feeds** — 21 locales have dedicated feed sets that match the user's language. When a non-English user loads the dashboard for the first time, a one-time **locale boost** runs: it examines the browser's language, finds feeds tagged with a matching `lang` field, and enables them alongside the default English sources. The boost is non-destructive — it never overwrites manual feed preferences, and it runs exactly once per locale (tracked via `localStorage`). Examples: Korean users get Yonhap and Chosun Ilbo; Greek users get Kathimerini, Naftemporiki, and Proto Thema; Czech users get iDNES and Novinky.

**RTL support** — Arabic and Hebrew locales trigger automatic right-to-left layout via CSS `direction: rtl` on the root element. All panel layouts, text alignment, and scrollbar positions adapt without per-component overrides.

**AI output language** — when the UI language is non-English, the summarization prompt instructs the LLM to generate its output in the user's language. This applies to World Briefs, AI Deductions, and country intelligence briefs.

**Font stacks** — language-specific font families are applied via `:lang()` CSS selectors: Arabic uses Geeza Pro, Chinese uses PingFang SC / Microsoft YaHei, Japanese uses Hiragino Sans, Korean uses Apple SD Gothic Neo / Malgun Gothic. The base monospace font stack (`--font-mono`) provides 6 platform-specific fallbacks for consistent rendering across macOS, Windows, and Linux.

### Privacy & Offline Architecture

World Monitor is designed so that sensitive intelligence work can run entirely on local hardware with no data leaving the user's machine. The privacy architecture operates at three levels:

**Level 1 — Full Cloud (Web App)**
All processing happens server-side on Vercel Edge Functions. API keys are stored in Vercel environment variables. News feeds are proxied through domain-allowlisted endpoints. AI summaries use Groq or OpenRouter. This is the default for `worldmonitor.app` — convenient but cloud-dependent.

**Level 2 — Desktop with Cloud APIs (Tauri + Sidecar)**
The desktop app runs a local Node.js sidecar that mirrors all 60+ cloud API handlers. API keys are stored in the OS keychain (macOS Keychain / Windows Credential Manager), never in plaintext files. Requests are processed locally first; cloud is a transparent fallback for missing handlers. Credential management happens through a native settings window with per-key validation.

**Level 3 — Air-Gapped Local (Ollama + Desktop)**
With Ollama or LM Studio configured, AI summarization runs entirely on local hardware. Combined with the desktop sidecar, the core intelligence pipeline (news aggregation, threat classification, instability scoring, AI briefings) operates with zero cloud dependency. The browser-side ML pipeline (Transformers.js) provides NER, sentiment analysis, and fallback summarization without even a local server.

| Capability | Web | Desktop + Cloud Keys | Desktop + Ollama |
|---|:---:|:---:|:---:|
| News aggregation | Cloud proxy | Local sidecar | Local sidecar |
| AI summarization | Groq/OpenRouter | Groq/OpenRouter | Local LLM |
| Threat classification | Cloud LLM + browser ML | Cloud LLM + browser ML | Browser ML only |
| Credential storage | Server env vars | OS keychain | OS keychain |
| Map & static layers | Browser | Browser | Browser |
| Data leaves machine | Yes | Partially | No |

The desktop readiness framework (`desktop-readiness.ts`) catalogs each feature's locality class — `fully-local` (no API required), `api-key` (degrades gracefully without keys), or `cloud-fallback` (proxy available) — enabling clear communication about what works offline.

### Responsive Layout System

The dashboard adapts to four screen categories without JavaScript layout computation — all breakpoints are CSS-only:

| Screen Width     | Layout             | Details                                                                                                                                                                                 |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **< 768px**      | Mobile warning     | Modal recommends desktop; limited panel display with touch-optimized map popups                                                                                                         |
| **768px–2000px** | Standard grid      | Vertical stack: map on top, panels in `auto-fill` grid (`minmax(280px, 1fr)`). Panels tile in rows that adapt to available width                                                        |
| **2000px+**      | Ultra-wide L-shape | Map floats left at 60% width, 65vh height. Panels wrap to the right of the map and below it using CSS `display: contents` on the grid container with `float: left` on individual panels |

The ultra-wide layout is notable for its technique: `display: contents` dissolves the `.panels-grid` container so that individual panel elements become direct flow children of `.main-content`. Combined with `float: left` on the map, this creates natural L-shaped content wrapping — panels fill the space to the right of the map, and when they overflow past the map's height, they spread to full width. No JavaScript layout engine is involved.

Panel heights are user-adjustable via drag handles (span-1 through span-4 grid rows), with layout state persisted to localStorage. Double-clicking a drag handle resets the panel to its default height.

### Signal Aggregation

All real-time data sources feed into a central signal aggregator that builds a unified geospatial intelligence picture. Signals are clustered by country and region, with each signal carrying a severity (low/medium/high), geographic coordinates, and metadata. The aggregator:

1. **Clusters by country** — groups signals from diverse sources (flights, vessels, protests, fires, outages, `keyword_spike`) into per-country profiles
2. **Detects regional convergence** — identifies when multiple signal types spike in the same geographic corridor (e.g., military flights + protests + satellite fires in Eastern Mediterranean)
3. **Feeds downstream analysis** — the CII, hotspot escalation, focal point detection, and AI insights modules all consume the aggregated signal picture rather than raw data

### Cross-Stream Correlation Engine

Beyond aggregating signals by geography, the system detects meaningful correlations *across* data streams — identifying patterns that no single source would reveal. 14 signal types are continuously evaluated:

| Signal Type               | Detection Logic                                                                 | Why It Matters                                           |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `prediction_leads_news`   | Polymarket probability shifts >5% before matching news headlines appear        | Prediction markets as early-warning indicators           |
| `news_leads_markets`      | News velocity spike precedes equity/crypto price move by 15–60 min             | Informational advantage detection                        |
| `silent_divergence`       | Significant market movement with no corresponding news volume                   | Potential insider activity or unreported events           |
| `velocity_spike`          | News cluster sources-per-hour exceeds 6+ from Tier 1–2 outlets                | Breaking story detection                                 |
| `keyword_spike`           | Trending term exceeds 3× its 7-day baseline                                   | Emerging narrative detection                             |
| `convergence`             | 3+ signal types co-locate in same 1°×1° geographic cell                        | Multi-domain crisis indicator                            |
| `triangulation`           | Same entity appears across news + military tracking + market signals           | High-confidence focal point identification               |
| `flow_drop`               | ETF flow estimates reverse direction while price continues                     | Smart money divergence                                   |
| `flow_price_divergence`   | Commodity prices move opposite to shipping flow indicators                     | Supply chain disruption signal                           |
| `geo_convergence`         | Geographic convergence alert from the spatial binning system                   | Regional crisis acceleration                             |
| `explained_market_move`   | Market price change has a matching news cluster with causal keywords           | Attributable market reaction                             |
| `hotspot_escalation`      | Hotspot escalation score exceeds threshold                                     | Conflict zone intensification                            |
| `sector_cascade`          | Multiple companies in same sector move in same direction simultaneously        | Sector-wide event detection                              |
| `military_surge`          | Theater posture assessment detects unusual force concentration                 | Military escalation warning                              |

Each signal carries a severity (low/medium/high), geographic coordinates, a human-readable summary, and the raw data that triggered it. Signals are deduplicated per-type with configurable cooldown windows (30 minutes to 6 hours) to prevent alert fatigue. The correlation output feeds into the AI Insights panel, where the narrative synthesis engine weaves detected correlations into a structured intelligence brief.

### PizzINT Activity Monitor & GDELT Tension Index

The dashboard integrates two complementary geopolitical pulse indicators:

**PizzINT DEFCON scoring** — monitors foot traffic patterns at key military, intelligence, and government locations worldwide via the PizzINT API. Aggregate activity levels across monitored sites are converted into a 5-level DEFCON-style readout:

| Adjusted Activity | DEFCON Level | Label             |
| ----------------- | ------------ | ----------------- |
| ≥ 85%             | 1            | Maximum Activity  |
| 70% – 84%         | 2            | High Activity     |
| 50% – 69%         | 3            | Elevated Activity |
| 25% – 49%         | 4            | Above Normal      |
| < 25%             | 5            | Normal Activity   |

Activity spikes at individual locations boost the aggregate score (+10 per spike, capped at 100). Data freshness is tracked per-location — the system distinguishes between stale readings (location sensor lag) and genuine low activity. Per-location detail includes current popularity percentage, spike magnitude, and open/closed status.

**GDELT bilateral tension pairs** — six strategic country pairs (USA↔Russia, Russia↔Ukraine, USA↔China, China↔Taiwan, USA↔Iran, USA↔Venezuela) are tracked via GDELT's GPR (Goldstein Political Relations) batch API. Each pair shows a current tension score, a percentage change from the previous data point, and a trend direction (rising/stable/falling, with ±5% thresholds). Rising bilateral tension scores that coincide with military signal spikes in the same region feed into the focal point detection algorithm.

### Data Freshness & Intelligence Gaps

A singleton tracker monitors 28+ data sources (GDELT, RSS, AIS, military flights, earthquakes, weather, outages, ACLED, Polymarket, economic indicators, NASA FIRMS, cyber threat feeds, trending keywords, oil/energy, population exposure, BIS central bank data, WTO trade policy, Telegram OSINT, OREF rocket alerts, GPS/GNSS jamming, government travel advisories, airport delays/NOTAMs, and more) with status categorization: fresh (<15 min), stale (1h), very_stale (6h), no_data, error, disabled. It explicitly reports **intelligence gaps** — what analysts can't see — preventing false confidence when critical data sources are down or degraded.

### Prediction Markets as Leading Indicators

Polymarket geopolitical markets are queried using tag-based filters (Ukraine, Iran, China, Taiwan, etc.) with 5-minute caching. Market probability shifts are correlated with news volume: if a prediction market moves significantly before matching news arrives, this is flagged as a potential early-warning signal.

**Cloudflare JA3 bypass** — Polymarket's API is protected by Cloudflare TLS fingerprinting (JA3) that blocks all server-side requests. The system uses a 3-tier fallback:

| Tier  | Method                     | When It Works                                           |
| ----- | -------------------------- | ------------------------------------------------------- |
| **1** | Browser-direct fetch       | Always (browser TLS passes Cloudflare)                  |
| **2** | Tauri native TLS (reqwest) | Desktop app (Rust TLS fingerprint differs from Node.js) |
| **3** | Vercel edge proxy          | Rarely (edge runtime sometimes passes)                  |

Once browser-direct succeeds, the system caches this state and skips fallback tiers on subsequent requests. Country-specific markets are fetched by mapping countries to Polymarket tags with name-variant matching (e.g., "Russia" matches titles containing "Russian", "Moscow", "Kremlin", "Putin").

Markets are filtered to exclude sports and entertainment (100+ exclusion keywords), require meaningful price divergence from 50% or volume above $50K, and are ranked by trading volume. Each variant gets different tag sets — geopolitical focus queries politics/world/ukraine/middle-east tags, while tech focus queries ai/crypto/business tags.

### Macro Signal Analysis (Market Radar)

The Market Radar panel computes a composite BUY/CASH verdict from 7 independent signals sourced entirely from free APIs (Yahoo Finance, mempool.space, alternative.me):

| Signal              | Computation                           | Bullish When                |
| ------------------- | ------------------------------------- | --------------------------- |
| **Liquidity**       | JPY/USD 30-day rate of change         | ROC > -2% (no yen squeeze)  |
| **Flow Structure**  | BTC 5-day return vs QQQ 5-day return  | Gap < 5% (aligned)          |
| **Macro Regime**    | QQQ 20-day ROC vs XLP 20-day ROC      | QQQ outperforming (risk-on) |
| **Technical Trend** | BTC vs SMA50 + 30-day VWAP            | Above both (bullish)        |
| **Hash Rate**       | Bitcoin mining hashrate 30-day change | Growing > 3%                |
| **Mining Cost**     | BTC price vs hashrate-implied cost    | Price > $60K (profitable)   |
| **Fear & Greed**    | alternative.me sentiment index        | Value > 50                  |

The overall verdict requires ≥57% of known signals to be bullish (BUY), otherwise CASH. Signals with unknown data are excluded from the denominator.

**VWAP Calculation** — Volume-Weighted Average Price is computed from aligned price/volume pairs over a 30-day window. Pairs where either price or volume is null are excluded together to prevent index misalignment:

```
VWAP = Σ(price × volume) / Σ(volume)    for last 30 trading days
```

The **Mayer Multiple** (BTC price / SMA200) provides a long-term valuation context — historically, values above 2.4 indicate overheating, while values below 0.8 suggest deep undervaluation.

### Gulf FDI Investment Database

The Finance variant includes a curated database of 64 major foreign direct investments by Saudi Arabia and the UAE in global critical infrastructure. Investments are tracked across 12 sectors:

| Sector            | Examples                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| **Ports**         | DP World's 11 global container terminals, AD Ports (Khalifa, Al-Sokhna, Karachi), Saudi Mawani ports |
| **Energy**        | ADNOC Ruwais LNG (9.6 mtpa), Aramco's Motiva Port Arthur refinery (630K bpd), ACWA Power renewables  |
| **Manufacturing** | Mubadala's GlobalFoundries (82% stake, 3rd-largest chip foundry), Borealis (75%), SABIC (70%)        |
| **Renewables**    | Masdar wind/solar (UK Hornsea, Zarafshan 500MW, Gulf of Suez), NEOM Green Hydrogen (world's largest) |
| **Megaprojects**  | NEOM THE LINE ($500B), Saudi National Cloud ($6B hyperscale datacenters)                             |
| **Telecoms**      | STC's 9.9% stake in Telefónica, PIF's 20% of Telecom Italia NetCo                                    |

Each investment records the investing entity (DP World, Mubadala, PIF, ADNOC, Masdar, Saudi Aramco, ACWA Power, etc.), target country, geographic coordinates, investment amount (USD), ownership stake, operational status, and year. The Investments Panel provides filterable views by country (SA/UAE), sector, entity, and status — clicking any row navigates the map to the investment location.

On the globe, investments appear as scaled bubbles: ≥$50B projects (NEOM) render at maximum size, while sub-$1B investments use smaller markers. Color encodes status: green for operational, amber for under-construction, blue for announced.

### Stablecoin Peg Monitoring

Five major stablecoins (USDT, USDC, DAI, FDUSD, USDe) are monitored via the CoinGecko API with 2-minute caching. Each coin's deviation from the $1.00 peg determines its health status:

| Deviation   | Status       | Indicator |
| ----------- | ------------ | --------- |
| ≤ 0.5%      | ON PEG       | Green     |
| 0.5% – 1.0% | SLIGHT DEPEG | Yellow    |
| > 1.0%      | DEPEGGED     | Red       |

The panel aggregates total stablecoin market cap, 24h volume, and an overall health status (HEALTHY / CAUTION / WARNING). The `coins` query parameter accepts a comma-separated list of CoinGecko IDs, validated against a `[a-z0-9-]+` regex to prevent injection.

### Oil & Energy Analytics

The Oil & Energy panel tracks four key indicators from the U.S. Energy Information Administration (EIA) API:

| Indicator         | Series                    | Update Cadence |
| ----------------- | ------------------------- | -------------- |
| **WTI Crude**     | Spot price ($/bbl)        | Weekly         |
| **Brent Crude**   | Spot price ($/bbl)        | Weekly         |
| **US Production** | Crude oil output (Mbbl/d) | Weekly         |
| **US Inventory**  | Commercial crude stocks   | Weekly         |

Trend detection flags week-over-week changes exceeding ±0.5% as rising or falling, with flat readings within the threshold shown as stable. Results are cached client-side for 30 minutes. The panel provides energy market context for geopolitical analysis — price spikes often correlate with supply disruptions in monitored conflict zones and chokepoint closures.

### BIS Central Bank Data

The Economic panel integrates data from the Bank for International Settlements (BIS), the central bank of central banks, providing three complementary datasets:

| Dataset | Description | Use Case |
| --- | --- | --- |
| **Policy Rates** | Current central bank policy rates across major economies | Monetary policy stance comparison — tight vs. accommodative |
| **Real Effective Exchange Rates** | Trade-weighted currency indices adjusted for inflation (REER) | Currency competitiveness — rising REER = strengthening, falling = weakening |
| **Credit-to-GDP** | Total credit to the non-financial sector as percentage of GDP | Credit bubble detection — high ratios signal overleveraged economies |

Data is fetched through three dedicated BIS RPCs (`GetBisPolicyRates`, `GetBisExchangeRates`, `GetBisCredit`) in the `economic/v1` proto service. Each dataset uses independent circuit breakers with 30-minute cache TTLs. The panel renders policy rates as a sorted table with spark bars, exchange rates with directional trend indicators, and credit-to-GDP as a ranked list. BIS data freshness is tracked in the intelligence gap system — staleness or failures surface as explicit warnings rather than silent gaps.

### WTO Trade Policy Intelligence

The Trade Policy panel provides real-time visibility into global trade restrictions, tariffs, and barriers — critical for tracking economic warfare, sanctions impact, and supply chain disruption risk. Four data views are available:

| Tab | Data Source | Content |
| --- | --- | --- |
| **Restrictions** | WTO trade monitoring | Active trade restrictions with imposing/affected countries, product categories, and enforcement dates |
| **Tariffs** | WTO tariff database | Tariff rate trends between country pairs (e.g., US↔China) with historical datapoints |
| **Flows** | WTO trade statistics | Bilateral trade flow volumes with year-over-year change indicators |
| **Barriers** | WTO SPS/TBT notifications | Sanitary, phytosanitary, and technical barriers to trade with status tracking |

The `trade/v1` proto service defines four RPCs, each with its own circuit breaker (30-minute cache TTL) and `upstreamUnavailable` signaling for graceful degradation when WTO endpoints are temporarily unreachable. The panel is available on FULL and FINANCE variants. Trade policy data feeds into the data freshness tracker as `wto_trade`, with intelligence gap warnings when the WTO feed goes stale.

### Supply Chain Disruption Intelligence

The Supply Chain panel provides real-time visibility into global logistics risk across three complementary dimensions — strategic chokepoint health, shipping cost trends, and critical mineral concentration — enabling early detection of disruptions that cascade into economic and geopolitical consequences.

**Chokepoints tab** — monitors 6 strategic maritime bottlenecks (Suez Canal, Strait of Malacca, Strait of Hormuz, Bab el-Mandeb, Panama Canal, Taiwan Strait) by cross-referencing live navigational warnings with AIS vessel disruption data. Each chokepoint receives a disruption score (0–100) computed from a three-component formula: baseline threat level (war zone / critical / high / elevated / normal), active warning count (capped contribution), and AIS congestion severity — mapped to color-coded status indicators (green/yellow/red). Chokepoint identification uses text-evidence matching (keyword scoring with primary and area terms) before falling back to geographic proximity, preventing misclassification of events that mention one chokepoint but are geographically closer to another. Data is cached with a 5-minute TTL for near-real-time awareness.

**Shipping Rates tab** — tracks two Federal Reserve Economic Data (FRED) series: the Deep Sea Freight Producer Price Index (`PCU483111483111`) and the Freight Transportation Services Index (`TSIFRGHT`). Statistical spike detection flags abnormal price movements against recent history. Inline SVG sparklines render 24 months of rate history at a glance. Cached for 1 hour to reflect the weekly release cadence of underlying data.

**Critical Minerals tab** — applies the **Herfindahl-Hirschman Index (HHI)** to 2024 global production data for minerals critical to technology and defense manufacturing — lithium, cobalt, rare earths, gallium, germanium, and others. The HHI quantifies supply concentration risk: a market dominated by a single producer scores near 10,000, while a perfectly distributed market scores near 0. Each mineral displays the top 3 producing countries with market share percentages, flagging single-country dependencies that represent strategic vulnerability (e.g., China's dominance in rare earth processing). This tab uses static production data, cached for 24 hours with no external API dependency.

The panel is available on the FULL (World Monitor) variant and integrates with the infrastructure cascade model — when a chokepoint disruption coincides with high mineral concentration risk for affected trade routes, the combined signal feeds into convergence detection.

### BTC ETF Flow Estimation

Ten spot Bitcoin ETFs are tracked via Yahoo Finance's 5-day chart API (IBIT, FBTC, ARKB, BITB, GBTC, HODL, BRRR, EZBC, BTCO, BTCW). Since ETF flow data requires expensive terminal subscriptions, the system estimates flow direction from publicly available signals:

- **Price change** — daily close vs. previous close determines direction
- **Volume ratio** — current volume / trailing average volume measures conviction
- **Flow magnitude** — `volume × price × direction × 0.1` provides a rough dollar estimate

This is an approximation, not a substitute for official flow data, but it captures the direction and relative magnitude correctly. Results are cached for 15 minutes.

---

## Tri-Variant Architecture

A single codebase produces four specialized dashboards, each with distinct feeds, panels, map layers, and branding:

| Aspect                | World Monitor                                        | Tech Monitor                                    | Finance Monitor                                  | Happy Monitor                                         |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| **Domain**            | worldmonitor.app                                     | tech.worldmonitor.app                           | finance.worldmonitor.app                         | happy.worldmonitor.app                                |
| **Focus**             | Geopolitics, military, conflicts                     | AI/ML, startups, cybersecurity                  | Markets, trading, central banks                  | Good news, conservation, human progress               |
| **RSS Feeds**         | 15 categories, 170 feeds (politics, MENA, Africa, think tanks) | 21 categories, 152 feeds (AI, VC blogs, startups, GitHub) | 14 categories, 55 feeds (forex, bonds, commodities, IPOs) | 5 categories, 21 positive-news sources (GNN, Positive.News, Upworthy) |
| **Panels**            | 47 (strategic posture, CII, cascade, trade policy)   | 35 (AI labs, unicorns, accelerators)            | 33 (forex, bonds, derivatives, trade policy)     | 10 (good news, breakthroughs, conservation, renewables, giving) |
| **Unique Map Layers** | Military bases, nuclear facilities, hotspots         | Tech HQs, cloud regions, startup hubs           | Stock exchanges, central banks, Gulf investments | Positive events, kindness, species recovery, renewables |
| **Desktop App**       | World Monitor.app / .exe / .AppImage                 | Tech Monitor.app / .exe / .AppImage             | Finance Monitor.app / .exe / .AppImage           | (web-only)                                            |

**Happy Monitor** is a deliberately uplifting counterpart to the geopolitical dashboard. All conflict, military, and threat overlays are disabled. The variant uses a warm nature-inspired color palette (`happy-theme.css`) and sources content from 10 dedicated positive-news RSS feeds (Good News Network, Positive.News, Reasons to be Cheerful, Optimist Daily, Upworthy, DailyGood, Good Good Good, GOOD Magazine, Sunny Skyz, The Better India). A two-pass positive classifier sorts articles into 6 categories — `science-health`, `nature-wildlife`, `humanity-kindness`, `innovation-tech`, `climate-wins`, `culture-community` — using source-name shortcuts (GNN sub-feeds are pre-classified) followed by priority-ordered keyword matching. Panels include Good News Feed with category filtering, Human Progress metrics, Live Counters, Today's Hero, Breakthroughs, 5 Good Things digest, Conservation Wins (species recovery stories), and Renewable Energy installations.

**Happy Monitor panels in detail**:

- **Good News Feed** — articles from 10 positive-news RSS sources, classified into 6 categories (`science-health`, `nature-wildlife`, `humanity-kindness`, `innovation-tech`, `climate-wins`, `culture-community`) using a two-pass classifier: source-name shortcuts (GNN sub-feeds are pre-classified by URL pattern) followed by priority-ordered keyword matching across 80+ positive terms
- **Live Humanity Counters** — 6 real-time counters computed client-side with zero API dependency. Each counter calculates `(annual_total / seconds_per_year) × seconds_since_UTC_midnight` to show accumulating global progress throughout the day:

| Counter             | Annual Total        | Rate      | Source                      |
| ------------------- | ------------------- | --------- | --------------------------- |
| Babies Born         | 135,600,000         | ~4.3/sec  | UN Population Division      |
| Trees Planted       | 15,300,000,000      | ~485/sec  | Global Forest Watch / FAO   |
| Vaccines Given      | 4,600,000,000       | ~146/sec  | WHO / UNICEF                |
| Students Graduated  | 70,000,000          | ~2.2/sec  | UNESCO                      |
| Books Published     | 2,200,000           | ~0.07/sec | UNESCO                      |
| Renewable MW Added  | 510,000             | ~0.016/sec| IRENA / IEA                 |

- **Conservation Wins** — a curated database of 10 species recovery stories (Bald Eagle, Humpback Whale, Giant Panda, Southern White Rhino, Gray Wolf, Peregrine Falcon, American Alligator, Arabian Oryx, California Condor, Mountain Gorilla) with population time-series data sourced from USFWS, IUCN, NOAA, and WWF. Each entry includes recovery status, population trend, and the conservation actions that drove recovery. The dataset is dynamically imported (code-split) so it only loads when the Happy variant is active
- **Renewable Energy** — regional renewable electricity adoption data from the World Bank (`EG.ELC.RNEW.ZS` indicator, IEA-sourced), covering 8 regions with historical time-series from 1990. Static fallback data (29.6% global average, 2022) ensures the panel renders even when the API is unreachable
- **Global Giving** — aggregates donation volumes across platforms (GoFundMe, GoGetFunding), crypto giving (wallet inflows, tracked transactions), and institutional giving (OECD Official Development Assistance, CAF World Giving Index, Candid grants). Displays an overall activity index with trend direction and daily flow estimates
- **Human Progress**, **Today's Hero**, **Breakthroughs** (scrolling ticker), and **5 Good Things Digest** round out the positive-news experience

**Single-deployment consolidation** — all four variants serve from a single Vercel deployment. The variant is determined at runtime by hostname detection (`tech.worldmonitor.app` → tech, `finance.worldmonitor.app` → finance, `happy.worldmonitor.app` → happy, default → full). This replaced the original multi-deployment approach, providing 4× higher CDN cache hit rates (shared static assets), a single CI pipeline with zero cross-deployment configuration drift, and instant switching without DNS lookups. Social bot OG responses generate variant-specific preview cards based on the requesting hostname.

**Build-time selection** — the `VITE_VARIANT` environment variable controls which configuration is bundled. A Vite HTML plugin transforms meta tags, Open Graph data, PWA manifest, and JSON-LD structured data at build time. Each variant tree-shakes unused data files — the finance build excludes military base coordinates and APT group data, while the geopolitical build excludes stock exchange listings.

**Runtime switching** — a variant selector in the header bar (🌍 WORLD | 💻 TECH | 📈 FINANCE | 😊 HAPPY) navigates between deployed domains on the web, or sets `localStorage['worldmonitor-variant']` in the desktop app to switch without rebuilding.

---

## Architecture Principles

| Principle                           | Implementation                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Speed over perfection**           | Keyword classifier is instant; LLM refines asynchronously. Users never wait.                                                                                                                                                                                                                                                              |
| **Assume failure**                  | Per-feed circuit breakers with 5-minute cooldowns. AI fallback chain: Ollama (local) → Groq → OpenRouter → browser-side T5. Redis cache failures degrade to in-memory fallback with stale-on-error. Negative caching (5-minute backoff after upstream failures) prevents hammering downed APIs. Every edge function returns stale cached data when upstream APIs are down. **Cache stampede prevention** — `cachedFetchJson` uses an in-flight promise map to coalesce concurrent cache misses into a single upstream fetch: the first request creates and registers a Promise, all concurrent requests for the same key await that same Promise rather than independently hitting the upstream. Rate-sensitive APIs (Yahoo Finance) use staggered sequential requests with 150ms inter-request delays to avoid 429 throttling. UCDP conflict data uses automatic version discovery (probing multiple API versions in parallel), discovered-version caching (1-hour TTL), and stale-on-error fallback. |
| **Show what you can't see**         | Intelligence gap tracker explicitly reports data source outages rather than silently hiding them.                                                                                                                                                                                                                                         |
| **Browser-first compute**           | Analysis (clustering, instability scoring, surge detection) runs client-side — no backend compute dependency for core intelligence.                                                                                                                                                                                                       |
| **Local-first geolocation**         | Country detection uses browser-side ray-casting against GeoJSON polygons rather than network reverse-geocoding. Sub-millisecond response, zero API dependency, works offline. Network geocoding is a fallback, not the primary path.                                                                                                      |
| **Multi-signal correlation**        | No single data source is trusted alone. Focal points require convergence across news + military + markets + protests before escalating to critical.                                                                                                                                                                                       |
| **Geopolitical grounding**          | Hard-coded conflict zones, baseline country risk, and strategic chokepoints prevent statistical noise from generating false alerts in low-data regions.                                                                                                                                                                                   |
| **Defense in depth**                | CORS origin allowlist, domain-allowlisted RSS proxy, server-side API key isolation, token-authenticated desktop sidecar, input sanitization with output encoding, IP rate limiting on AI endpoints.                                                                                                                                       |
| **Cache everything, trust nothing** | Three-tier caching (in-memory → Redis → upstream) with versioned cache keys and stale-on-error fallback. Every API response includes `X-Cache` header for debugging. CDN layer (`s-maxage`) absorbs repeated requests before they reach edge functions.                                                                                   |
| **Bandwidth efficiency**            | Gzip compression on all relay responses (80% reduction). Content-hash static assets with 1-year immutable cache. Staggered polling intervals prevent synchronized API storms. Animations and polling pause on hidden tabs.                                                                                                                |
| **Baseline-aware alerting**         | Trending keyword detection uses rolling 2-hour windows against 7-day baselines with per-term spike multipliers, cooldowns, and source diversity requirements — surfacing genuine surges while suppressing noise.                                                                                                                          |
| **Contract-first APIs**             | Every API endpoint starts as a `.proto` definition with field validation, HTTP annotations, and examples. Code generation produces typed TypeScript clients and servers, eliminating schema drift. Breaking changes are caught automatically at CI time.                                                                                 |
| **Run anywhere**                    | Same codebase produces four specialized variants (geopolitical, tech, finance, happy) from a single Vercel deployment and deploys to Vercel (web), Railway (relay), Tauri (desktop), and PWA (installable). Desktop sidecar mirrors all cloud API handlers locally. Service worker caches map tiles for offline use while keeping intelligence data always-fresh (NetworkOnly). |
| **Graceful degradation**            | Every feature degrades gracefully when dependencies are unavailable. Missing API keys skip the associated data source — they don't crash the app. Failed upstream APIs serve stale cached data. Browser-side ML works without any server. The dashboard is useful with zero API keys configured (static layers, map, ML models all work offline). |
| **Multi-source corroboration**      | Critical intelligence signals use multiple independent sources to reduce single-source bias. Protest data merges ACLED + GDELT with Haversine deduplication. Country risk blends news velocity + military activity + unrest events + baseline risk. Disaster data merges USGS + GDACS + NASA EONET on a 0.1° geographic grid.            |
| **No framework overhead**           | Vanilla TypeScript with direct DOM manipulation, event delegation, and custom `Panel`/`VirtualList` classes. No virtual DOM diffing, no framework runtime, no adapter libraries. The entire application shell weighs less than React's runtime. Browser standards (Web Workers, IndexedDB, Intersection Observer, ResizeObserver, CustomEvent) serve as the reactivity and component model. |
| **Type-safe data flow**             | Discriminated union markers (`_kind` field), proto-generated typed clients/servers, and exhaustive `switch` matching ensure compile-time safety across 15+ marker types, 22 service domains, and 45+ map layers. Adding a new data type produces compiler errors at every unhandled site. |

### Intelligence Analysis Tradecraft

The dashboard's design draws from established intelligence analysis methodology, adapted for automated open-source intelligence:

**Structured Analytic Techniques (SATs)** — rather than presenting raw data, the system applies structured frameworks to reduce cognitive bias. The Country Instability Index decomposes "instability" into four weighted components (unrest, conflict, security, information velocity) — forcing analysts to consider each dimension independently rather than anchoring on the most salient headline. The Strategic Risk Score similarly decomposes geopolitical risk into convergence, CII, infrastructure, theater, and breaking news components.

**Analysis of Competing Hypotheses (ACH)** — the multi-source corroboration requirement (news + military + markets + protests before escalating to critical) is an automated form of ACH. No single data stream can drive a critical alert alone — the system requires convergence across independent streams, reducing the impact of single-source reporting errors or propaganda campaigns.

**Intelligence gap awareness** — professional intelligence assessments always note what they *don't* know. The data freshness tracker explicitly reports "what can't be seen" — 28+ sources with status categorization (fresh, stale, very_stale, no_data, error, disabled). When a critical data source goes down, the system displays the gap prominently rather than silently omitting it, preventing false confidence from incomplete data.

**Source credibility weighting** — the 4-tier source hierarchy (wire services → major outlets → specialty → aggregators) mirrors intelligence community source evaluation (A–F reliability, 1–6 confidence). State-affiliated sources are included for completeness but tagged with propaganda risk indicators, enabling analysts to factor in editorial bias. Higher-tier sources carry more weight in focal point detection and alert generation.

**Temporal context** — Welford's online baseline computation provides the temporal context that raw counts lack. "50 military flights" is meaningless without knowing that the average for this day of week and month is 15 — making the observation 3.3σ above normal. The system automatically provides this context for every signal type.

**Kill chain awareness** — the Breaking News Alert Pipeline's 5-origin design mirrors the intelligence kill chain concept. RSS alerts provide initial detection; keyword spikes confirm emerging narratives; hotspot escalation and military surge provide corroborating signals; OREF sirens provide ground truth. Each origin adds confidence to the assessment.

### Algorithmic Design Decisions

Several non-obvious algorithmic choices are worth explaining:

**Logarithmic vs. linear protest scoring** — Democracies experience routine protests that don't indicate instability (France's yellow vest movement, US campus protests). Authoritarian states rarely see public protest, so each event is significant. The CII uses `log(protestCount)` for democracies and linear scaling for authoritarian states, preventing democratic noise from drowning genuine authoritarian unrest signals.

**Welford's online algorithm for baselines** — Traditional mean/variance computation requires storing all historical data points. Welford's method maintains a running mean and M2 (sum of squared deviations) that can be updated with each new observation in O(1) time and O(1) space. This makes it feasible to track baselines for hundreds of event-type × region × weekday × month combinations in Redis without storing raw observations.

**H3 hexagonal grid for GPS jamming** — Hexagonal grids (H3 resolution 4, ~22km edge length) are used instead of rectangular lat/lon cells because hexagons have uniform adjacency (6 neighbors vs. 4/8 for squares), equal area at any latitude, and no meridian convergence distortion. This matters for interference zone detection where spatial uniformity affects clustering accuracy.

**Cosine-latitude-corrected distance** — Cable health matching and several proximity calculations use equirectangular approximation with `cos(lat)` longitude correction instead of full Haversine. At the distances involved (50–600km), the error is <0.5% while being ~10x faster — important when computing distances against 500+ infrastructure assets per event.

**Negative caching** — When an upstream API returns an error, the system caches the failure state for a defined period (5 minutes for UCDP, 30 seconds for Polymarket queue rejections) rather than retrying immediately. This prevents thundering-herd effects where hundreds of concurrent users all hammer a downed API, and it provides clear signal to the intelligence gap tracker that a source is unavailable.

**O(1) inflection suffix matching** — The keyword-matching pipeline checks every word in every ingested headline against a set of English inflection suffixes (`-ing`, `-ed`, `-tion`, `-ment`, etc.) for morphological normalization. The suffix list was converted from an `Array` (O(n) `.some()` scan per word) to a `Set` (O(1) `.has()` lookup), eliminating a linear scan executed on every word of every headline — a meaningful hot-path optimization given the system processes thousands of headlines per refresh cycle.

**Stack-safe array operations** — The `Math.min(...array)` and `Math.max(...array)` spread patterns are limited by V8's argument stack (~65,535 entries). With large news clusters (common during breaking events), the spread silently overflows and returns `Infinity` / `-Infinity`, corrupting `firstSeen` and `lastUpdated` timestamps. These are replaced with `Array.prototype.reduce` loops that operate in O(1) stack space regardless of array size.

### Vanilla TypeScript Architecture

World Monitor is written in vanilla TypeScript — no frontend framework (React, Vue, Svelte, Angular) is used. This is a deliberate architectural decision, not an oversight.

**Why no framework:**

- **Bundle size** — the dashboard loads dozens of data layers, map renderers, ML models, and live video streams. Every kilobyte of framework overhead competes with actual intelligence data. The entire application shell (panel system, routing, state management) compiles to less JavaScript than React's runtime alone
- **DOM control** — the panel system manipulates `innerHTML` directly with debounced content replacement (`setContent()`) and event delegation on stable container elements. Framework virtual DOM diffing would fight this pattern, adding overhead without benefit — the dashboard doesn't have the fine-grained reactive state updates that frameworks optimize for
- **WebView compatibility** — the Tauri desktop app runs in WKWebView (macOS) and WebKitGTK (Linux), which have idiosyncratic behavior around drag-and-drop, clipboard, autoplay, and memory management. Direct DOM manipulation makes it possible to work around these platform quirks without fighting framework abstractions
- **Long-term simplicity** — no framework version upgrades, no breaking API migrations, no adapter libraries. The codebase depends on browser standards (DOM, Web Workers, IndexedDB, Intersection Observer, ResizeObserver) that are stable across engine updates

**What fills the framework gap:**

| Concern | Solution |
| --- | --- |
| Component model | `Panel` base class with lifecycle methods (`render`, `destroy`), debounced content updates, and event delegation |
| State management | `localStorage` for user preferences, `CustomEvent` dispatch for inter-panel communication (`wm:breaking-news`, `wm:deduct-context`, `theme-changed`, `ai-flow-changed`), and a centralized signal aggregator for intelligence state |
| Routing | URL query parameters (`?view=`, `?c=`, `?layers=`) parsed at startup; `history.pushState` for shareable deep links |
| Reactivity | `SmartPollLoop` and `RefreshScheduler` classes with named refresh runners, visibility-aware scheduling, and in-flight deduplication |
| Virtual scrolling | Custom `VirtualList` with DOM element pooling, top/bottom spacer divs, and `requestAnimationFrame`-batched scroll handling |

### Discriminated Union Marker System

All map markers — across both the globe.gl and deck.gl engines — carry a `_kind` discriminant field that identifies their type at runtime. Rather than using class inheritance (which requires `instanceof` checks and prevents marker data from being plain serializable objects), each marker is a plain TypeScript object with a literal `_kind` string:

```typescript
type MapMarker =
  | { _kind: 'conflict'; lat: number; lon: number; severity: string; ... }
  | { _kind: 'flight'; lat: number; lon: number; callsign: string; ... }
  | { _kind: 'vessel'; lat: number; lon: number; mmsi: number; ... }
  | { _kind: 'protest'; lat: number; lon: number; crowd_size: number; ... }
  // ... 15+ additional marker kinds
```

This enables exhaustive `switch` matching in the rendering pipeline — the TypeScript compiler verifies that every marker kind is handled, and adding a new kind produces compile errors at every unhandled site. Marker data can be serialized to/from JSON (for IndexedDB persistence and Web Worker transfer) without custom serialization logic. The same marker objects flow through clustering, tooltip generation, and layer filtering without type casting.

### AIS Relay Backpressure Architecture

The AIS vessel tracking relay maintains a persistent WebSocket connection to AISStream.io that can deliver hundreds of position reports per second during peak maritime traffic. Without flow control, a slow consumer (e.g., a client on a poor network) would cause unbounded memory growth in the relay's message queue.

The relay implements a **three-watermark backpressure system**:

| Watermark | Threshold | Behavior |
| --- | --- | --- |
| **Low** | 1,000 messages | Normal operation — all messages queued |
| **High** | 4,000 messages | Warning state — oldest messages evicted to make room |
| **Hard cap** | 8,000 messages | Overflow — new messages dropped until queue drains below high watermark |

Additionally, the relay caps the total tracked vessel count at 20,000 positions (the most recent position per MMSI). A secondary **density cell** system aggregates positions into 2°×2° geographic grid cells (max 5,000 cells) for overview visualization when the full vessel list exceeds rendering capacity.

Vessel history trails are capped at 30 position points per vessel. When a new position arrives, the oldest trail point is evicted. This creates a "comet tail" visualization showing recent movement direction without unbounded memory growth.

The relay also implements HMAC authentication between the frontend and relay server, preventing unauthorized clients from consuming the expensive AIS data feed.

### ONNX Runtime Capability Detection

The browser-side ML pipeline (embeddings, NER, sentiment, summarization) uses ONNX Runtime Web for inference. Model execution speed varies dramatically across browsers and devices depending on available hardware acceleration.

The system uses a cascading capability detection strategy at initialization:

```
WebGPU (fastest)  →  WebGL (fast)  →  WASM + SIMD (baseline)
```

1. **WebGPU** — checked via `navigator.gpu` presence. Provides GPU-accelerated inference with the lowest latency. Available in Chrome 113+ and Edge 113+
2. **WebGL** — fallback when WebGPU is unavailable. Uses the existing GPU via WebGL compute shaders. Available in all modern browsers
3. **WASM + SIMD** — CPU-only fallback. `SharedArrayBuffer` and WASM SIMD availability are probed. SIMD provides ~2–4x speedup over plain WASM for vector operations

A `deviceMemory` API guard excludes the ML pipeline entirely on low-memory devices (mobile phones with <4GB RAM), preventing out-of-memory crashes from loading 384-dimensional float32 embedding models alongside the map renderer and live video streams.

### Panel Event Delegation Pattern

The `Panel` base class uses a debounced `setContent(html)` method (150ms delay) to batch rapid DOM updates. This creates a subtle but critical problem: any event listeners attached to elements inside the panel's `innerHTML` are destroyed when the debounce fires and replaces the content.

The solution is **event delegation** — all click, change, and input handlers are bound to the stable outer `this.content` container element (which is never replaced, only its `innerHTML` changes), using `event.target.closest('.selector')` to match the intended element:

```typescript
// WRONG — listener destroyed on next setContent()
this.content.querySelector('.btn')?.addEventListener('click', handler);

// CORRECT — survives innerHTML replacement
this.content.addEventListener('click', (e) => {
  if (e.target.closest('.btn')) handler(e);
});
```

This pattern is enforced project-wide across all panel subclasses. In E2E tests, element references also go stale after the debounced render — test code must re-query the DOM after each render cycle rather than holding onto cached element references.

### Single-Deployment Variant Consolidation

All four dashboard variants (World Monitor, Tech Monitor, Finance Monitor, Happy Monitor) serve from a **single Vercel deployment**. The variant is determined at runtime by hostname detection:

| Hostname | Variant |
| --- | --- |
| `tech.worldmonitor.app` | `tech` |
| `finance.worldmonitor.app` | `finance` |
| `happy.worldmonitor.app` | `happy` |
| `worldmonitor.app` (default) | `full` |

On the desktop app, the variant is stored in `localStorage['worldmonitor-variant']` and can be switched without rebuilding. The variant selector in the header bar navigates between deployed domains on the web or toggles the localStorage value on desktop.

This architecture replaced the original multi-deployment approach (separate Vercel projects per variant) and provides several advantages:

- **Instant switching** — users toggle variants in the header bar without a full page navigation or DNS lookup
- **Shared CDN cache** — the static SPA assets are identical across variants; only runtime configuration differs. CDN cache hit rates are 4× higher than with separate deployments
- **Single CI pipeline** — one build, one deployment, one set of edge functions. No cross-deployment configuration drift
- **Social bot routing** — the OG image endpoint generates variant-specific preview cards based on the requesting hostname, so sharing a Tech Monitor link produces tech-branded social previews

### Cold-Start Optimization — Per-Domain Edge Function Split

The original monolithic edge gateway (`api/[domain]/v1/[rpc].ts`) imported all 22 service domain handlers into a single function. When any RPC was called, the edge runtime loaded the entire handler graph — initializing Redis clients, parsing configuration, and importing utility modules for all 22 domains even though only 1 was needed.

This was split into 22 per-domain thin entry points, each importing only its own handler module. The shared gateway (`server/gateway.ts`) provides common routing logic, but each domain's edge function tree-shakes to include only its dependencies.

**Impact**: Cold-start time dropped by ~85% — a market quote request no longer loads the cyber threat intelligence parser, the OREF alert handler, or the climate anomaly detector. On Vercel's edge runtime, this translates to sub-100ms cold starts for most endpoints, compared to 500ms+ with the monolithic handler.

### Geopolitical Boundary Overlays

The map supports typed geopolitical boundary polygons with associated metadata. Each boundary carries a `boundaryType` discriminant (`demilitarized`, `ceasefire`, `disputed`, `armistice`) that controls rendering style and popup content.

**Korean DMZ** — the first boundary implemented is the Korean Demilitarized Zone, defined as a 43-point closed-ring polygon derived from OpenStreetMap Way 369265305 and the Korean Armistice Agreement Article I demarcation line. On the flat map, it renders as a `GeoJsonLayer` with a translucent blue fill and labeled tooltip. On the 3D globe, it renders as `polygonsData` under the conflicts layer. The boundary has a dedicated help entry and layer toggle, and is enabled by default on the `full` variant only.

The boundary system is designed to be extensible — additional geopolitical boundaries (Line of Control in Kashmir, Golan Heights, Northern Cyprus Green Line) can be added to the `GEOPOLITICAL_BOUNDARIES` constant with appropriate typing and will render automatically on both map engines.

### CII Choropleth Heatmap

The Country Instability Index can be projected as a full-coverage choropleth layer on both map engines, painting every country's polygon in a five-stop color gradient based on its live CII score (0–100):

| Score Range | Level     | Color     |
| ----------- | --------- | --------- |
| 0–30        | Low       | Green     |
| 31–50       | Normal    | Yellow    |
| 51–65       | Elevated  | Orange    |
| 66–80       | High      | Red       |
| 81–100      | Critical  | Dark Red  |

On the **flat map** (deck.gl), a `GeoJsonLayer` maps ISO 3166-1 alpha-2 country codes to fixed RGBA values via the `getLevel()` threshold function. Updates are triggered by a monotonic version counter (`ciiScoresVersion`) — the layer compares the counter on each render pass and only recomputes fill colors when it increments, avoiding O(n) data spreads.

On the **3D globe** (globe.gl), CII country polygons merge into the same `polygonsData` array as geopolitical boundaries. A `_kind` discriminant (`'boundary' | 'cii'`) in each polygon object lets a single `.polygonCapColor()` callback dispatch rendering logic for both types. CII polygons render at `polygonAltitude: 0.002` (below the `0.006` altitude used by conflict-zone outlines), preventing visual Z-fighting.

Countries GeoJSON is lazy-loaded from a shared `getCountriesGeoJson()` function, cached after first fetch, and shared between the CII layer and the country-detection ray-casting service.

### Unified Layer Toggle Catalog

All 45+ map layer toggle definitions — icon, localization key, fallback display label, and supported renderer types — are consolidated in a single shared registry (`src/config/map-layer-definitions.ts`). Each entry declares which map renderers support it via a `renderers: MapRenderer[]` field (e.g., `dayNight` is flat-only, `ciiChoropleth` is both flat and globe), preventing the two map components from showing inconsistent layer options.

A `def()` factory function reduces per-entry boilerplate. Variant-specific layer ordering (`VARIANT_LAYER_ORDER`) defines the display sequence for each of the four dashboard variants without duplicating the definitions themselves. Adding a new map layer requires a single registry entry — both the flat map and 3D globe derive their toggle panels from this catalog automatically.

### Sentry Error Noise Filtering

The Sentry SDK initialization includes a `beforeSend` hook and `ignoreErrors` list that suppress known unactionable error sources — Three.js WebGL traversal crashes occurring entirely in minified code with no source-mapped frames, cross-origin Web Worker construction failures from browser extensions, iOS media element crashes, and jQuery `$` injection by extensions. The Three.js filter specifically avoids blanket suppression: it only drops events where *all* stack frames are anonymous or from the minified bundle. If even one frame has a source-mapped `.ts` filename, the event is kept for investigation.

---

## Source Credibility & Feed Tiering

Every RSS feed is assigned a source tier reflecting editorial reliability:

| Tier       | Description                                | Examples                                    |
| ---------- | ------------------------------------------ | ------------------------------------------- |
| **Tier 1** | Wire services, official government sources | Reuters, AP, BBC, DOD                       |
| **Tier 2** | Major established outlets                  | CNN, NYT, The Guardian, Al Jazeera          |
| **Tier 3** | Specialized/niche outlets                  | Defense One, Breaking Defense, The War Zone |
| **Tier 4** | Aggregators and blogs                      | Google News, individual analyst blogs       |

Feeds also carry a **propaganda risk rating** and **state affiliation flag**. State-affiliated sources (RT, Xinhua, IRNA) are included for completeness but visually tagged so analysts can factor in editorial bias. Threat classification confidence is weighted by source tier — a Tier 1 breaking alert carries more weight than a Tier 4 blog post in the focal point detection algorithm.

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

## Edge Function Architecture

World Monitor uses 60+ Vercel Edge Functions as a lightweight API layer, split into two generations. Legacy endpoints in `api/*.js` each handle a single data source concern — proxying, caching, or transforming external APIs. The newer proto-first endpoints use **per-domain thin entry points** — 22 separate edge functions, each importing only its own handler module. This replaced the original monolithic gateway that loaded all 22 domains on every cold start. Each domain's function tree-shakes to include only its dependencies, reducing cold-start time by ~85% (sub-100ms for most endpoints vs. 500ms+ with the monolithic handler). A shared `server/gateway.ts` provides common routing logic. Both generations coexist, with new features built proto-first. This architecture avoids a monolithic backend while keeping API keys server-side:

- **RSS Proxy** — domain-allowlisted proxy for 170+ feeds, preventing CORS issues and hiding origin servers. Feeds from domains that block Vercel IPs are automatically routed through the Railway relay.
- **AI Pipeline** — Groq and OpenRouter edge functions with Redis deduplication, so identical headlines across concurrent users only trigger one LLM call. The classify-event endpoint pauses its queue on 500 errors to avoid wasting API quota.
- **Data Adapters** — GDELT, ACLED, OpenSky, USGS, NASA FIRMS, FRED, Yahoo Finance, CoinGecko, mempool.space, BIS, WTO, and others each have dedicated edge functions that normalize responses into consistent schemas
- **Market Intelligence** — macro signals, ETF flows, and stablecoin monitors compute derived analytics server-side (VWAP, SMA, peg deviation, flow estimates) and cache results in Redis
- **Temporal Baseline** — Welford's algorithm state is persisted in Redis across requests, building statistical baselines without a traditional database
- **Custom Scrapers** — sources without RSS feeds (FwdStart, GitHub Trending, tech events) are scraped and transformed into RSS-compatible formats
- **Finance Geo Data** — stock exchanges (92), financial centers (19), central banks (13), and commodity hubs (10) are served as static typed datasets with market caps, GFCI rankings, trading hours, and commodity specializations
- **BIS Integration** — policy rates, real effective exchange rates, and credit-to-GDP ratios from the Bank for International Settlements, cached with 30-minute TTL
- **WTO Trade Policy** — trade restrictions, tariff trends, bilateral trade flows, and SPS/TBT barriers from the World Trade Organization
- **Supply Chain Intelligence** — maritime chokepoint disruption scores (cross-referencing NGA warnings + AIS data), FRED shipping freight indices with spike detection, and critical mineral supply concentration via Herfindahl-Hirschman Index analysis
- **Company Enrichment** — `/api/enrichment/company` aggregates GitHub organization data, inferred tech stack (derived from repository language distributions weighted by star count), SEC EDGAR public filings (10-K, 10-Q, 8-K), and Hacker News mentions into a single response. `/api/enrichment/signals` surfaces real-time company activity signals — funding events, hiring surges, executive changes, and expansion announcements — sourced from Hacker News and GitHub, each classified by signal type and scored for strength based on engagement, comment volume, and recency

All edge functions include circuit breaker logic and return cached stale data when upstream APIs are unavailable, ensuring the dashboard never shows blank panels.

---

## Multi-Platform Architecture

All four variants run on three platforms that work together:

```
┌─────────────────────────────────────┐
│          Vercel (Edge)              │
│  60+ edge functions · static SPA    │
│  Proto gateway (22 typed services)  │
│  CORS allowlist · Redis cache       │
│  AI pipeline · market analytics     │
│  CDN caching (s-maxage) · PWA host  │
└──────────┬─────────────┬────────────┘
           │             │ fallback
           │             ▼
           │  ┌───────────────────────────────────┐
           │  │     Tauri Desktop (Rust + Node)   │
           │  │  OS keychain · Token-auth sidecar │
           │  │  60+ local API handlers · br/gzip    │
           │  │  Cloud fallback · Traffic logging │
           │  └───────────────────────────────────┘
           │
           │ https:// (server-side)
           │ wss://   (client-side)
           ▼
┌──────────────────────────────────────────┐
│        Railway (Relay Server)            │
│  AIS WebSocket · OpenSky OAuth2          │
│  Telegram MTProto (26 OSINT channels)    │
│  OREF rocket alerts (residential proxy)  │
│  Polymarket proxy (queue backpressure)   │
│  ICAO NOTAM · RSS proxy · gzip all resp │
└──────────────────────────────────────────┘
```

**Why two platforms?** Several upstream APIs (OpenSky Network, CNN RSS, UN News, CISA, IAEA) actively block requests from Vercel's IP ranges, and some require persistent connections or protocols that edge functions cannot support. The Railway relay server acts as an alternate origin, handling:

- **AIS vessel tracking** — maintains a persistent WebSocket connection to AISStream.io and multiplexes it to all connected browser clients, avoiding per-user connection limits
- **OpenSky aircraft data** — authenticates via OAuth2 client credentials flow (Vercel IPs get 403'd by OpenSky without auth tokens)
- **Telegram intelligence** — a GramJS MTProto client polls 26 OSINT channels on a 60-second cycle with per-channel timeouts and FLOOD_WAIT handling
- **OREF rocket alerts** — polls Israel's Home Front Command alert system via `curl` through a residential proxy (Akamai WAF blocks datacenter TLS fingerprints)
- **Polymarket proxy** — fetches from Gamma API with concurrent upstream limiting (max 3 simultaneous, queue backpressure at 20), in-flight deduplication, and 10-minute caching to prevent stampedes from 11 parallel tag queries
- **ICAO NOTAM proxy** — routes NOTAM closure queries through the relay for MENA airports, bypassing Vercel IP restrictions on ICAO's API
- **GDELT positive events** — a 15-minute cron fetches three thematic GDELT GEO API queries (breakthroughs/renewables, conservation/humanitarian, volunteer/charity), deduplicates by event name, validates coordinates, classifies by category, and writes to Redis with a 45-minute TTL. This replaced direct Vercel Edge Function calls that failed on 99.9% of invocations due to GDELT's ~31-second sequential response time exceeding the 25-second edge timeout. Bootstrap hydration is registered so the Happy variant has data on first render
- **RSS feeds** — proxies feeds from domains that block Vercel IPs, with a separate domain allowlist for security. Supports conditional GET (ETag/If-Modified-Since) to reduce bandwidth for unchanged feeds

The Vercel edge functions connect to Railway via `WS_RELAY_URL` (server-side, HTTPS) while browser clients connect via `VITE_WS_RELAY_URL` (client-side, WSS). This separation keeps the relay URL configurable per deployment without leaking server-side configuration to the browser.

All Railway relay responses are gzip-compressed (zlib `gzipSync`) when the client accepts it and the payload exceeds 1KB, reducing egress by ~80% for JSON and XML responses. The desktop local sidecar now prefers Brotli (`br`) and falls back to gzip for payloads larger than 1KB, setting `Content-Encoding` and `Vary: Accept-Encoding` automatically.

---

## Desktop Application Architecture

The Tauri desktop app wraps the dashboard in a native window (macOS, Windows, Linux) with a local Node.js sidecar that runs all API handlers without cloud dependency:

```
┌─────────────────────────────────────────────────┐
│              Tauri (Rust)                       │
│  Window management · Consolidated keychain vault│
│  Token generation · Log management · Menu bar   │
│  Polymarket native TLS bridge                   │
└─────────────────────┬───────────────────────────┘
                      │ spawn + env vars
                      ▼
┌─────────────────────────────────────────────────┐
│      Node.js Sidecar (dynamic port)             │
│  60+ API handlers · Local RSS proxy             │
│  Brotli/Gzip compression · Cloud fallback       │
│  Traffic logging · Verbose debug mode           │
└─────────────────────┬───────────────────────────┘
                      │ fetch (on local failure)
                      ▼
┌─────────────────────────────────────────────────┐
│         Cloud (worldmonitor.app)                │
│  Transparent fallback when local handlers fail  │
└─────────────────────────────────────────────────┘
```

### Secret Management

API keys are stored in the operating system's credential manager (macOS Keychain, Windows Credential Manager) — never in plaintext config files. All secrets are consolidated into a single JSON vault entry in the keychain, so app startup requires exactly one OS authorization prompt regardless of how many keys are configured.

At sidecar launch, the vault is read, parsed, and injected as environment variables. Empty or whitespace-only values are skipped. Secrets can also be updated at runtime without restarting the sidecar: saving a key in the Settings window triggers a `POST /api/local-env-update` call that hot-patches `process.env` so handlers pick up the new value immediately.

**Verification pipeline** — when you enter a credential in Settings, the app validates it against the actual provider API (Groq → `/openai/v1/models`, Ollama → `/api/tags`, FRED → GDP test query, NASA FIRMS → fire data fetch, etc.). Network errors (timeouts, DNS failures, unreachable hosts) are treated as soft passes — the key is saved with a "could not verify" notice rather than blocking. Only explicit 401/403 responses from the provider mark a key as invalid. This prevents transient network issues from locking users out of their own credentials.

**Smart re-verification** — when saving settings, the verification pipeline skips keys that haven't been modified since their last successful verification. This prevents unnecessary round-trips to provider APIs when a user changes one key but has 15 others already configured and validated. Only newly entered or modified keys trigger verification requests.

**Desktop-specific requirements** — some features require fewer credentials on desktop than on the web. For example, AIS vessel tracking on the web requires both a relay URL and an API key, but the desktop sidecar handles relay connections internally, so only the API key is needed. The settings panel adapts its required-fields display based on the detected platform.

### Sidecar Authentication

A unique 32-character hex token is generated per app launch using randomized hash state (`RandomState` from Rust's standard library). The token is:

1. Injected into the sidecar as `LOCAL_API_TOKEN`
2. Retrieved by the frontend via the `get_local_api_token` Tauri command (lazy-loaded on first API request)
3. Attached as `Authorization: Bearer <token>` to every local request

The `/api/service-status` health check endpoint is exempt from token validation to support monitoring tools.

### Dynamic Port Allocation

The sidecar defaults to port 46123 but handles `EADDRINUSE` gracefully — if the port is occupied (another World Monitor instance, or any other process), the sidecar binds to port 0 and lets the OS assign an available ephemeral port. The actual bound port is written to a port file (`sidecar.port` in the logs directory) that the Rust host polls on startup (100ms intervals, 5-second timeout). The frontend discovers the port at runtime via the `get_local_api_port` IPC command, and `getApiBaseUrl()` in `runtime.ts` is the canonical accessor — hardcoding port 46123 in frontend code is prohibited. The CSP `connect-src` directive uses `http://127.0.0.1:*` to accommodate any port.

### Local RSS Proxy

The sidecar includes a built-in RSS proxy handler that fetches news feeds directly from source domains, bypassing the cloud RSS proxy entirely. This means the desktop app can load all 170+ RSS feeds without any cloud dependency — the same domain allowlist used by the Vercel edge proxy is enforced locally. Combined with the local API handlers, this enables the desktop app to operate as a fully self-contained intelligence aggregation platform.

### Sidecar Resilience

The sidecar employs multiple resilience patterns to maintain data availability when upstream APIs degrade:

- **Stale-on-error** — when an upstream API returns a 5xx error or times out, the sidecar serves the last successful response from its in-memory cache rather than propagating the failure. Panels display stale data with a visual "retrying" indicator rather than going blank
- **Negative caching** — after an upstream failure, the sidecar records a 5-minute negative cache entry to prevent immediately re-hitting the same broken endpoint. Subsequent requests during the cooldown receive the stale response instantly
- **Staggered requests** — APIs with strict rate limits (Yahoo Finance) use sequential request batching with 150ms inter-request delays instead of `Promise.all`. This transforms 10 concurrent requests that would trigger HTTP 429 into a staggered sequence that stays under rate limits
- **In-flight deduplication** — concurrent requests for the same resource (e.g., multiple panels polling the same endpoint) are collapsed into a single upstream fetch. The first request creates a Promise stored in an in-flight map; all concurrent requests await that single Promise
- **Panel retry indicator** — when a panel's data fetch fails and retries, the Panel base class displays a non-intrusive "Retrying..." indicator so users understand the dashboard is self-healing rather than broken

### Cloud Fallback

When a local API handler is missing, throws an error, or returns a 5xx status, the sidecar transparently proxies the request to the cloud deployment. Endpoints that fail are marked as `cloudPreferred` — subsequent requests skip the local handler and go directly to the cloud until the sidecar is restarted. Origin and Referer headers are stripped before proxying to maintain server-to-server parity.

### Observability

- **Traffic log** — a ring buffer of the last 200 requests with method, path, status, and duration (ms), accessible via `GET /api/local-traffic-log`
- **Verbose mode** — togglable via `POST /api/local-debug-toggle`, persists across sidecar restarts in `verbose-mode.json`
- **Dual log files** — `desktop.log` captures Rust-side events (startup, secret injection counts, menu actions), while `local-api.log` captures Node.js stdout/stderr
- **IPv4-forced fetch** — the sidecar patches `globalThis.fetch` to force IPv4 for all outbound requests. Government APIs (NASA FIRMS, EIA, FRED) publish AAAA DNS records but their IPv6 endpoints frequently timeout. The patch uses `node:https` with `family: 4` to bypass Happy Eyeballs and avoid cascading ETIMEDOUT failures
- **DevTools** — `Cmd+Alt+I` toggles the embedded web inspector

---

## Bandwidth Optimization

The system minimizes egress costs through layered caching and compression across all three deployment targets:

### Vercel CDN Headers

Every API edge function includes `Cache-Control` headers that enable Vercel's CDN to serve cached responses without hitting the origin:

| Data Type              | `s-maxage`   | `stale-while-revalidate` | Rationale                        |
| ---------------------- | ------------ | ------------------------ | -------------------------------- |
| Classification results | 3600s (1h)   | 600s (10min)             | Headlines don't reclassify often |
| Country intelligence   | 3600s (1h)   | 600s (10min)             | Briefs change slowly             |
| Risk scores            | 300s (5min)  | 60s (1min)               | Near real-time, low latency      |
| Market data            | 3600s (1h)   | 600s (10min)             | Intraday granularity sufficient  |
| Fire detection         | 600s (10min) | 120s (2min)              | VIIRS updates every ~12 hours    |
| Economic indicators    | 3600s (1h)   | 600s (10min)             | Monthly/quarterly releases       |

Static assets use content-hash filenames with 1-year immutable cache headers. The service worker file (`sw.js`) is never cached (`max-age=0, must-revalidate`) to ensure update detection.

### Client-Side Circuit Breakers

Every data-fetching panel uses a circuit breaker that prevents cascading failures from bringing down the entire dashboard. The pattern works at two levels:

**Per-feed circuit breakers** (RSS) — each RSS feed URL has an independent failure counter. After 2 consecutive failures, the feed enters a 5-minute cooldown during which no fetch attempts are made. The feed automatically re-enters the pool after the cooldown expires. This prevents a single misconfigured or downed feed from consuming fetch budget and slowing the entire news refresh cycle.

**Per-panel circuit breakers** (data panels) — panels that fetch from API endpoints use IndexedDB-backed persistent caches (`worldmonitor_persistent_cache` store) with TTL envelopes. When a fetch succeeds, the result is stored with an expiration timestamp. On subsequent loads, the circuit breaker serves the cached result immediately and attempts a background refresh. If the background refresh fails, the stale cached data continues to display — panels never go blank due to transient API failures. Cache entries survive page reloads and browser restarts.

The circuit breaker degrades gracefully across storage tiers: IndexedDB (primary, up to device quota) → localStorage fallback (5MB limit) → in-memory Map (session-only). When device storage quota is exhausted (common on mobile Safari), a global `_storageQuotaExceeded` flag disables all further writes while reads continue normally.

### Brotli Pre-Compression (Build-Time)

`vite build` now emits pre-compressed Brotli artifacts (`*.br`) for static assets larger than 1KB (JS, CSS, HTML, SVG, JSON, XML, TXT, WASM). This reduces transfer size by roughly 20–30% vs gzip-only delivery when the edge can serve Brotli directly.

For the Hetzner Nginx origin, enable static compressed file serving so `dist/*.br` files are returned without runtime recompression:

```nginx
gzip on;
gzip_static on;

brotli on;
brotli_static on;
```

Cloudflare will negotiate Brotli automatically for compatible clients when the origin/edge has Brotli assets available.

### Railway Relay Compression

All relay server responses pass through `gzipSync` when the client accepts gzip and the payload exceeds 1KB. Sidecar API responses prefer Brotli and use gzip fallback with proper `Content-Encoding`/`Vary` headers for the same threshold. This applies to OpenSky aircraft JSON, RSS XML feeds, UCDP event data, AIS snapshots, and health checks — reducing wire size by approximately 50–80%.

### In-Flight Request Deduplication

When multiple connected clients poll simultaneously (common with the relay's multi-tenant WebSocket architecture), identical upstream requests are deduplicated at the relay level. The first request for a given resource key (e.g., an RSS feed URL or OpenSky bounding box) creates a Promise stored in an in-flight Map. All concurrent requests for the same key await that single Promise rather than stampeding the upstream API. Subsequent requests are served from cache with an `X-Cache: DEDUP` header. This prevents scenarios like 53 concurrent RSS cache misses or 5 simultaneous OpenSky requests for the same geographic region — all resolved by a single upstream fetch.

### Adaptive Refresh Scheduling

Rather than polling at fixed intervals, the dashboard uses an adaptive refresh scheduler that responds to network conditions, tab visibility, and data freshness:

- **Exponential backoff on failure** — when a refresh fails or returns no new data, the next poll interval doubles, up to a maximum of 4× the base interval. A successful fetch with new data resets the multiplier to 1×
- **Hidden-tab throttle** — when `document.visibilityState` is `hidden`, all poll intervals are multiplied by 10×. A tab polling every 60 seconds in the foreground slows to every 10 minutes in the background, dramatically reducing wasted requests from inactive tabs
- **Jitter** — each computed interval is randomized by ±10% to prevent synchronized API storms when multiple tabs or users share the same server. Without jitter, two tabs opened at the same time would poll in lockstep indefinitely
- **Stale flush on visibility restore** — when a hidden tab becomes visible, the scheduler identifies all refresh tasks whose data is older than their base interval and re-runs them immediately, staggered 150ms apart to avoid a request burst. This ensures users returning to a background tab see fresh data within seconds
- **In-flight deduplication** — concurrent calls to the same named refresh are collapsed; only one is allowed in-flight at a time
- **Conditional registration** — refresh tasks can include a `condition` function that is evaluated before each poll; tasks whose conditions are no longer met (e.g., a panel that has been collapsed) skip their fetch cycle entirely

### Frontend Polling Intervals

Panels refresh at staggered intervals to avoid synchronized API storms:

| Panel                              | Interval    | Rationale                      |
| ---------------------------------- | ----------- | ------------------------------ |
| AIS maritime snapshot              | 10s         | Real-time vessel positions     |
| Service status                     | 60s         | Health check cadence           |
| Market signals / ETF / Stablecoins | 180s (3min) | Market hours granularity       |
| Risk scores / Theater posture      | 300s (5min) | Composite scores change slowly |

All animations and polling pause when the tab is hidden or after 2 minutes of inactivity, preventing wasted requests from background tabs.

---

## Caching Architecture

Every external API call passes through a three-tier cache with stale-on-error fallback:

```
Request → [1] In-Memory Cache → [2] Redis (Upstash) → [3] Upstream API
                                                             │
            ◄──── stale data served on error ────────────────┘
```

| Tier                | Scope                      | TTL                | Purpose                                       |
| ------------------- | -------------------------- | ------------------ | --------------------------------------------- |
| **In-memory**       | Per edge function instance | Varies (60s–900s)  | Eliminates Redis round-trips for hot paths    |
| **Redis (Upstash)** | Cross-user, cross-instance | Varies (120s–900s) | Deduplicates API calls across all visitors    |
| **Upstream**        | Source of truth            | N/A                | External API (Yahoo Finance, CoinGecko, etc.) |

Cache keys are versioned (`opensky:v2:lamin=...`, `macro-signals:v2:default`) so schema changes don't serve stale formats. Every response includes an `X-Cache` header (`HIT`, `REDIS-HIT`, `MISS`, `REDIS-STALE`, `REDIS-ERROR-FALLBACK`) for debugging.

**Shared caching layer** — all sebuf handler implementations share a unified Upstash Redis caching module (`_upstash-cache.js`) with a consistent API: `getCachedOrFetch(cacheKey, ttlSeconds, fetchFn)`. This eliminates per-handler caching boilerplate and ensures every RPC endpoint benefits from the three-tier strategy. Cache keys include request-varying parameters (e.g., requested symbols, country codes, bounding boxes) to prevent cache contamination across callers with different inputs. On desktop, the same module runs in the sidecar with an in-memory + persistent file backend when Redis is unavailable.

**In-flight promise deduplication** — the `cachedFetchJson` function in `server/_shared/redis.ts` maintains an in-memory `Map<string, Promise>` of active upstream requests. When a cache miss occurs, the first caller's fetch creates and registers a Promise in the map. All concurrent callers for the same cache key await that single Promise rather than independently hitting the upstream API. This eliminates the "thundering herd" problem where multiple edge function instances simultaneously race to refill an expired cache entry — a scenario that previously caused 50+ concurrent upstream requests during the ~15-second refill window for popular endpoints.

**Negative caching** — when an upstream API returns an error, the system caches a sentinel value (`__WM_NEG__`) for 120 seconds rather than leaving the cache empty. This prevents a failure cascade where hundreds of concurrent requests all independently discover the cache is empty and simultaneously hammer the downed API. The negative sentinel is transparent to consumers — `cachedFetchJson` returns `null` for negative-cached keys, and panels fall back to stale data or show an appropriate empty state. Longer negative TTLs are used for specific APIs: UCDP uses 5-minute backoff, Polymarket queue rejections use 30-second backoff.

The AI summarization pipeline adds content-based deduplication: headlines are hashed and checked against Redis before calling Groq, so the same breaking news viewed by 1,000 concurrent users triggers exactly one LLM call.

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
| **Bot-aware social previews**  | The `/api/story` endpoint detects social crawlers (10+ signatures: Twitter, Facebook, LinkedIn, Telegram, Discord, Reddit, WhatsApp, Google) and serves OG-tagged HTML with dynamic preview images. Regular browsers receive a 302 redirect to the SPA. |
| **Bot protection middleware**  | Edge Middleware blocks crawlers and scrapers from all `/api/*` routes — bot user-agents and requests with short or missing `User-Agent` headers receive 403. Social preview bots are selectively allowed on `/api/story` and `/api/og-story` for Open Graph image generation. Reinforced by `robots.txt` Disallow rules on API paths. |
| **No debug endpoints**         | The `api/debug-env.js` endpoint returns 404 in production — it exists only as a disabled placeholder.                                                                                                                                              |
| **SSRF protection**            | The desktop sidecar's RSS proxy runs two-phase URL validation: protocol allowlist (HTTP/HTTPS only), private IP rejection (all RFC-1918 ranges, link-local, multicast, IPv6-mapped v4), DNS resolution to detect rebinding attacks, and **TOCTOU-safe pinning** — the first resolved IPv4 address is locked for the actual TCP connection, preventing DNS rebinding between check and connect. |
| **IPC window hardening**       | All sensitive Tauri IPC commands (keychain access, token retrieval, cache operations, Polymarket bridge) gate on `require_trusted_window()`. Only windows with labels in the `TRUSTED_WINDOWS` allowlist (`main`, `settings`, `live-channels`) can invoke these commands — injected iframes or rogue webviews receive an explicit rejection. |
| **DevTools gating**            | The developer tools menu item and its `Cmd+Alt+I` keybinding only compile into the binary when the `devtools` Cargo feature is enabled. Production builds omit the feature entirely, so DevTools cannot be opened in shipped binaries regardless of UI manipulation. |

---

## Error Tracking & Production Hardening

Sentry captures unhandled exceptions and promise rejections in production, with environment-aware routing (production on `worldmonitor.app`, preview on `*.vercel.app`, disabled on localhost and Tauri desktop).

The configuration includes 30+ `ignoreErrors` patterns that suppress noise from:

- **Third-party WebView injections** — Twitter, Facebook, and Instagram in-app browsers inject scripts that reference undefined variables (`CONFIG`, `currentInset`)
- **Browser extensions** — Chrome/Firefox extensions that fail `importScripts` or violate CSP policies
- **WebGL context loss** — transient GPU crashes in MapLibre/deck.gl that self-recover
- **iOS Safari quirks** — IndexedDB connection drops on background tab kills, `NotAllowedError` from autoplay policies
- **Network transients** — `TypeError: Failed to fetch`, `TypeError: Load failed`, `TypeError: cancelled`
- **MapLibre internal crashes** — null-access in style layers, light, and placement that originate from the map chunk

A custom `beforeSend` hook provides second-stage filtering: it suppresses single-character error messages (minification artifacts), `Importing a module script failed` errors from browser extensions (identified by `chrome-extension:` or `moz-extension:` in the stack trace), and MapLibre internal null-access crashes when the stack trace originates from map chunk files.

**Chunk reload guard** — after deployments, users with stale browser tabs may encounter `vite:preloadError` events when dynamically imported chunks have new content-hash filenames. The guard listens for this event and performs a one-shot page reload, using `sessionStorage` to prevent infinite reload loops. If the reload succeeds (app initializes fully), the guard flag is cleared. This recovers gracefully from stale-asset 404s without requiring users to manually refresh.

**Storage quota management** — when a device's localStorage or IndexedDB quota is exhausted (common on mobile Safari with its 5MB limit), a global `_storageQuotaExceeded` flag disables all further write attempts across both the persistent cache (IndexedDB + localStorage fallback) and the utility `saveToStorage()` function. The flag is set on the first `DOMException` with `name === 'QuotaExceededError'` or `code === 22`, and prevents cascading errors from repeated failed writes. Read operations continue normally — cached data remains accessible, only new writes are suppressed.

Transactions are sampled at 10% to balance observability with cost. Release tracking (`worldmonitor@{version}`) enables regression detection across deployments.

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
| **Docker**             | Planned                 | See [Roadmap](#roadmap)                                                                                                        |

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
| **Data**              | 170+ RSS feeds (full variant), 398 across all variants, ADS-B transponders, AIS maritime data, VIIRS satellite imagery, 30+ live video channels (8+ default YouTube + 18+ HLS native), 26 Telegram OSINT channels |

---

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines, including the Sebuf RPC framework workflow, how to add data sources and RSS feeds, and our AI-assisted development policy. The project also maintains a [Code of Conduct](./CODE_OF_CONDUCT.md) and [Security Policy](./SECURITY.md) for responsible vulnerability disclosure.

```bash
# Development
npm run dev          # Full variant (worldmonitor.app)
npm run dev:tech     # Tech variant (tech.worldmonitor.app)
npm run dev:finance  # Finance variant (finance.worldmonitor.app)
npm run dev:happy    # Happy variant (happy.worldmonitor.app)

# Production builds
npm run build:full      # Build full variant
npm run build:tech      # Build tech variant
npm run build:finance   # Build finance variant
npm run build:happy     # Build happy variant

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

- [x] 60+ API edge functions for programmatic access
- [x] Tri-variant system (geopolitical + tech + finance)
- [x] Market intelligence (macro signals, ETF flows, stablecoin peg monitoring)
- [x] Railway relay for WebSocket and blocked-domain proxying
- [x] CORS origin allowlist and security hardening
- [x] Native desktop application (Tauri) with OS keychain + authenticated sidecar
- [x] Progressive Web App with offline map support and installability
- [x] Bandwidth optimization (CDN caching, gzip relay, staggered polling)
- [x] Dual map engine — globe.gl 3D globe (Three.js) + deck.gl flat map (MapLibre), runtime-switchable
- [x] Natural disaster monitoring (USGS + GDACS + NASA EONET)
- [x] Historical playback via IndexedDB snapshots
- [x] Live YouTube stream detection with desktop embed bridge
- [x] Country brief pages with AI-generated intelligence dossiers
- [x] Local-first country detection (browser-side ray-casting, no network dependency)
- [x] Climate anomaly monitoring (15 conflict-prone zones)
- [x] Displacement tracking (UNHCR/HAPI origins & hosts)
- [x] Country brief export (JSON, CSV, PNG, PDF)
- [x] Cyber threat intelligence layer (Feodo Tracker, URLhaus, OTX, AbuseIPDB, C2IntelFeeds)
- [x] Trending keyword spike detection with baseline anomaly alerting
- [x] Oil & energy analytics (EIA: WTI, Brent, production, inventory)
- [x] Population exposure estimation (WorldPop density data)
- [x] Country search in Cmd+K with direct brief navigation
- [x] Entity index with cross-source correlation and confidence scoring
- [x] Finance variant with 92 stock exchanges, 19 financial centers, 13 central banks, and commodity hubs
- [x] Gulf FDI investment database (64 Saudi/UAE infrastructure investments mapped globally)
- [x] AIS maritime chokepoint detection and vessel density grid
- [x] Runtime feature toggles for 14 data sources
- [x] Panel height resizing with persistent layout state
- [x] Live webcam surveillance grid (22 geopolitical hotspot streams across 5 regions with Iran/Attacks dedicated tab)
- [x] Ultra-wide monitor layout (L-shaped panel wrapping on 2000px+ screens)
- [x] Linux desktop app (.AppImage)
- [x] Dark/light theme toggle with persistent preference
- [x] Desktop auto-update checker with variant-aware release linking
- [x] Panel drag-and-drop reordering with persistent layout
- [x] Map pin mode for fixed map positioning
- [x] Virtual scrolling for news panels (DOM recycling, pooled elements)
- [x] Local LLM support (Ollama / LM Studio) with automatic model discovery and 4-tier fallback chain
- [x] Settings window with dedicated LLMs, API Keys, and Debug tabs
- [x] Consolidated keychain vault (single OS prompt on startup)
- [x] Cross-window secret synchronization (main ↔ settings)
- [x] API key verification pipeline with soft-pass on network errors
- [x] Proto-first API contracts (92 proto files, 22 service domains, auto-generated TypeScript + OpenAPI docs)
- [x] USNI Fleet Intelligence (weekly deployment reports merged with live AIS tracking)
- [x] Aircraft enrichment via Wingbits (military confidence classification)
- [x] Undersea cable health monitoring (NGA navigational warnings + AIS cable ship tracking)
- [x] Dynamic Open Graph images for social sharing (SVG card generation with CII scores)
- [x] Storage quota management (graceful degradation on exhausted localStorage/IndexedDB)
- [x] Chunk reload guard (one-shot recovery from stale-asset 404s after deployments)
- [x] PizzINT activity monitor with DEFCON-style scoring and GDELT bilateral tension tracking
- [x] Bot protection middleware (edge-level crawler blocking with social preview exceptions)
- [x] In-flight request deduplication on relay (prevents upstream API stampede from concurrent clients)
- [x] Instant flat-render news panels (ML clustering runs async, items appear immediately)
- [x] Cable health scoring algorithm (time-decay weighted signals from NGA warnings with cos-lat distance matching)
- [x] Thai and Vietnamese localization (1,361 keys per locale)
- [x] Native-language RSS feeds for Turkish, Polish, Russian, Thai, and Vietnamese locales
- [x] Desktop sidecar RSS proxy (local feed fetching without cloud fallback)
- [x] Negative caching and version discovery for UCDP upstream API resilience
- [x] XRP (Ripple) added to crypto market tracking
- [x] Shared Upstash Redis caching layer across all 37 RPC handlers with parameterized cache keys
- [x] PostHog product analytics with typed event schemas, API key stripping, and ad-blocker bypass
- [x] Opt-in intelligence alert popups (default off, toggle in dropdown header)
- [x] Linux WebKitGTK DMA-BUF rendering with SHM fallback and cross-distro font stack
- [x] Consolidated `--font-mono` CSS variable for cross-platform typographic consistency
- [x] Dedup coordinate precision increased to 0.1° (~10km) for finer-grained event matching
- [x] Community guidelines (CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md)
- [x] Yahoo Finance staggered request batching to prevent 429 rate limiting
- [x] Panel base class retry indicator (`showRetrying`) for visual feedback during data refresh
- [x] Happy Monitor variant (positive news dashboard with conservation wins, renewables, and human progress metrics)
- [x] Supply Chain Disruption Intelligence (chokepoint monitoring, shipping rates, critical mineral HHI analysis)
- [x] Cache stampede prevention via `cachedFetchJson` in-flight promise deduplication across all server handlers
- [x] Dynamic sidecar port allocation with EADDRINUSE fallback and port file discovery
- [x] Universal CII scoring for all countries with event data (expanded from 23 curated to all nations)
- [x] Cmd+K command palette with ~250 country commands, layer presets, and fuzzy search scoring
- [x] SSRF protection with DNS resolution, private IP rejection, and TOCTOU-safe address pinning
- [x] IPC window hardening with trusted-window allowlist for all sensitive Tauri commands
- [x] DevTools gating via Cargo feature flag (disabled in production builds)
- [x] TypeScript CI check (GitHub Actions `tsc --noEmit` on every PR)
- [x] Trade route visualization (13 global lanes as animated deck.gl arcs with chokepoint markers)
- [x] OpenSky API optimization (4→2 merged query regions covering all military hotspots)
- [x] Global streaming video quality control (auto/360p/480p/720p with live propagation)
- [x] Ransomware.live feed added to cyber threat intelligence sources
- [x] Browser Local Model toggle properly gated (ML worker only initializes when enabled)
- [x] Linux AppImage crash fixes (WebKitGTK DMA-BUF rendering, console noise suppression)
- [x] Yahoo Finance rate-limit UX (user-facing messages instead of silent failures across all market panels)
- [x] Sidecar auth resilience (401-retry with token refresh, settings window `diagFetch` auth)
- [x] Verbose toggle persistence to writable data directory (fixes read-only app bundle on macOS)
- [x] Finnhub-to-Yahoo fallback routing when API key is missing
- [x] Telegram OSINT intelligence feed (26 channels via MTProto with dedup, classification, and FLOOD_WAIT handling)
- [x] OREF rocket alert integration (Israel Home Front Command siren data with wave detection and CII boost)
- [x] GPS/GNSS interference mapping (H3 hex grid from ADS-B data, 12 conflict regions, CII security scoring)
- [x] Government travel advisory aggregation (4 governments + 13 embassies + health agencies → CII score floors)
- [x] Airport delay & NOTAM monitoring (107 airports, FAA + AviationStack + ICAO NOTAM closure detection)
- [x] Strategic Risk Score algorithm (composite geopolitical risk from convergence, CII, infrastructure, theater, breaking news)
- [x] HLS native streaming (10 channels bypass YouTube iframes — Sky News, Euronews, DW, France24, RT, and more)
- [x] Polymarket in-flight request deduplication and queue backpressure (max 20 queued, response slicing)
- [x] AI Deduction & Forecasting panel (LLM-powered near-term geopolitical timeline analysis with live headline context)
- [x] Headline Memory (RAG) — opt-in client-side vector store with ONNX embeddings, IndexedDB persistence, and semantic search
- [x] Server-side feed aggregation via `listFeedDigest` RPC — reduces Vercel Edge invocations by ~95%
- [x] Smart default source reduction (~101 from 170+) with one-time locale-aware boost for 21 languages
- [x] Gulf Economies panel (GCC indices, currencies, oil with mini sparklines and 60-second polling)
- [x] Mobile-optimized map (touch pan with inertia, pinch-to-zoom, bottom-sheet popups, timezone-based location detection)
- [x] 18+ HLS native streaming channels (Fox News, ABC News AU, NHK World, TV5Monde, Tagesschau24, and more)
- [x] Live video fullscreen toggle (expand video grid to fill viewport)
- [x] Breaking news click-through (scroll to source panel with flash highlight)
- [x] TV Mode (ambient fullscreen panel cycling with configurable interval, 30s–2min)
- [x] Badge animation toggle (opt-in bump animation on panel count changes)
- [x] Cache purge admin endpoint (targeted Redis key deletion with HMAC auth and dry-run mode)
- [x] OREF Redis persistence with two-phase bootstrap (Redis-first, upstream-fallback with exponential retry)
- [x] 1,478 Hebrew→English OREF location translations with Unicode sanitization
- [x] Oceania region tab for live channels (ABC News Australia)
- [x] PostHog removal (replaced with lightweight Vercel Analytics)
- [x] Conditional GET (ETag/If-Modified-Since) on Railway relay RSS feeds
- [x] Mobile responsiveness improvements (collapsible map, panel sizing, font scaling)
- [x] PWA service worker update fix (stops auto-reload on SW update)
- [x] Lazy-loaded DeductionPanel (excludes DOMPurify from web bundle unless panel is accessed)
- [x] Czech, Greek, Korean, Bulgarian, and Romanian localization (21 total languages with native-language feed sets)
- [x] Bootstrap hydration (15 Redis keys pre-fetched in a single pipeline call, 2-tier parallel loading)
- [x] Breaking news alert pipeline (5 alert origins with per-event dedup, source tier gating, and sensitivity control)
- [x] Cross-stream correlation engine (14 signal types detecting patterns across news, markets, military, and prediction streams)
- [x] Adaptive refresh scheduling (exponential backoff, 10× hidden-tab throttle, jitter, stale-flush on visibility restore)
- [x] Client-side circuit breakers with IndexedDB persistence and graceful storage quota degradation
- [x] Programmatic API access via `api.worldmonitor.app` (22 service domains, REST + query param support)
- [x] Happy Monitor deep features (6 real-time humanity counters, 10 species conservation stories, renewable energy tracking, global giving aggregation)
- [x] Negative caching with sentinel values (prevents thundering herd on downed upstream APIs)
- [x] globe.gl 3D globe with Three.js (earth textures, atmosphere shader, auto-rotation, starfield, HTML marker layer)
- [x] Korean DMZ geopolitical boundary overlay (43-point polygon on both 3D globe and flat map)
- [x] World Clock panel (30 financial centers, auto-detect home city, market status, drag-to-reorder)
- [x] Bulgarian localization (20th language, native-language RSS feed set) + Romanian (21st language, community-contributed)
- [x] Single-deployment variant consolidation (4 variants from one Vercel deployment, hostname-based detection)
- [x] Per-domain edge function split (22 thin entry points, ~85% cold-start reduction)
- [x] O(1) suffix lookup via Set conversion + stack-safe min/max for large cluster arrays
- [x] Cmd+K Map:/Panel:/Brief: prefix disambiguation with localized tips rotator
- [x] Mobile settings gear icon (replaces GitHub link on screens ≤768px)
- [x] OREF gzip compression + 3-tier local file bootstrap (Railway volume → Redis → upstream)
- [x] Tech Readiness bootstrap hydration (World Bank indicators seeded via Railway)
- [x] Vanilla TypeScript architecture (no React/Vue/Svelte — direct DOM + event delegation + custom panel system)
- [x] Discriminated union marker system (`_kind` field, exhaustive switch matching, 15+ marker types)
- [x] AIS relay backpressure (3-watermark queue: low=1K, high=4K, hard-cap=8K messages)
- [x] ONNX capability detection cascade (WebGPU → WebGL → WASM+SIMD with deviceMemory guard)
- [x] Romanian localization (21st language, community-contributed)
- [x] CII choropleth heatmap overlay (5-stop gradient on both flat map and 3D globe)
- [x] Country instability navigation (click CII entries to open country briefs)
- [x] Company enrichment edge functions (GitHub org data, SEC filings, HN mentions, signal discovery)
- [x] Globe render quality setting (Auto/Eco/Sharp/4K/Insane pixel ratio presets)
- [x] Desktop globe performance (high-perf GPU, disable depth buffer, pause when hidden)
- [x] Mobile full-viewport map with GPS geolocation centering
- [x] Swipeable toolbars for Live News and Webcam region tabs on mobile (CSS scroll-snap)
- [x] Live stream keep-alive toggle (disable idle auto-pause for always-on monitoring)
- [x] Webcam single-view lock on mobile (disable grid mode, save battery)
- [x] Unified layer toggle catalog (single-file layer registry for both map renderers)
- [x] GDELT positive events moved to Railway seed (bypass 25s edge timeout, 15-min cron)
- [x] Supply chain scoring fixes (text-evidence chokepoint ID, threat baseline preservation)
- [x] Sentry noise filtering (Three.js WebGL crashes, cross-origin workers, iOS media — 33 issues suppressed)
- [ ] Mobile-optimized views
- [ ] Push notifications for critical alerts
- [ ] Self-hosted Docker image

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

GNU Affero General Public License v3.0 (AGPL-3.0) — see [LICENSE](LICENSE) for details.

---

## Author

**Elie Habib** — [GitHub](https://github.com/koala73)

---

## Contributors

Thanks to everyone who has contributed to World Monitor:

[@SebastienMelki](https://github.com/SebastienMelki),
[@Lib-LOCALE](https://github.com/Lib-LOCALE),
[@lawyered0](https://github.com/lawyered0),
[@elzalem](https://github.com/elzalem),
[@Rau1CS](https://github.com/Rau1CS),
[@Sethispr](https://github.com/Sethispr),
[@InlitX](https://github.com/InlitX),
[@Ahmadhamdan47](https://github.com/Ahmadhamdan47),
[@K35P](https://github.com/K35P),
[@Niboshi-Wasabi](https://github.com/Niboshi-Wasabi),
[@pedroddomingues](https://github.com/pedroddomingues),
[@haosenwang1018](https://github.com/haosenwang1018),
[@aa5064](https://github.com/aa5064),
[@cwnicoletti](https://github.com/cwnicoletti),
[@facusturla](https://github.com/facusturla),
[@toasterbook88](https://github.com/toasterbook88)
[@FayezBast](https://github.com/FayezBast)

---

## Security Acknowledgments

We thank the following researchers for responsibly disclosing security issues:

- **Cody Richard** — Disclosed three security findings covering IPC command exposure via DevTools in production builds, renderer-to-sidecar trust boundary analysis, and the global fetch patch credential injection architecture (2025)

If you discover a vulnerability, please see our [Security Policy](./SECURITY.md) for responsible disclosure guidelines.

---

<p align="center">
  <a href="https://worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://tech.worldmonitor.app">tech.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a>
</p>

## Star History

<a href="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date" />
 </picture>
</a>
