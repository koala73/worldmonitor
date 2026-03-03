# World Monitor — Community Promotion Guide

Thank you for helping spread the word about World Monitor! This guide provides talking points, must-see features, and visual suggestions to help you create compelling content for your audience.

---

## What is World Monitor?

**One-line pitch**: A free, open-source, real-time global intelligence dashboard — like Bloomberg Terminal meets OSINT, for everyone.

**Longer description**: World Monitor aggregates 170+ news feeds, military tracking, financial markets, conflict data, protest monitoring, satellite imagery, and AI-powered analysis into a single unified dashboard with an interactive globe. Available as a web app, desktop app (macOS/Windows/Linux), and installable PWA.

---

## Key URLs

| Link | Description |
|------|-------------|
| [worldmonitor.app](https://worldmonitor.app) | Main dashboard — geopolitics, military, conflicts |
| [tech.worldmonitor.app](https://tech.worldmonitor.app) | Tech variant — startups, AI/ML, cybersecurity |
| [finance.worldmonitor.app](https://finance.worldmonitor.app) | Finance variant — markets, exchanges, central banks |
| [GitHub](https://github.com/koala73/worldmonitor) | Source code (AGPL-3.0) |

---

## Must-See Features (Top 10)

### 1. Interactive Globe with 40+ Data Layers

The centerpiece. A WebGL-accelerated globe (deck.gl) with toggleable layers for conflicts, military bases, nuclear facilities, undersea cables, pipelines, satellite fires, protests, cyber threats, and more. Zoom in and the detail layers progressively reveal.

**Show**: Toggle different layers on/off. Zoom into a conflict region. Show the layer panel.

### 2. AI-Powered World Brief

One-click AI summary of the top global developments. Three-tier LLM provider chain: local Ollama/LM Studio (fully private, offline), Groq (fast cloud), or OpenRouter (fallback). Redis caching for instant responses on repeat queries.

**Show**: The summary card at the top of the news panel.

### 3. Country Intelligence Dossiers

Click any country on the map for a full-page intelligence brief: instability score ring, AI-generated analysis, top headlines, prediction markets, 7-day event timeline, active signal chips, infrastructure exposure, and stock market data.

**Show**: Click a country (e.g., Japan, Ukraine, or Iran) → full dossier page.

### 4. 19 Languages Support

Full UI in 19 languages including Japanese. Regional news feeds auto-adapt — Japanese users see NHK World, Nikkei Asia, and Japan-relevant sources. Language bundles are lazy-loaded for fast performance.

**Show**: Switch language to Japanese in the settings. Note how feeds change.

### 5. Live Military Tracking

Real-time ADS-B military flight tracking and AIS naval vessel monitoring. Strategic Posture panel shows theater-level risk assessment across 9 global regions (Baltic, Black Sea, South China Sea, Eastern Mediterranean, etc.).

**Show**: Enable the Military layer. Show the Strategic Posture panel.

### 6. Three Variant Dashboards

One codebase, three specialized views — switch between World (geopolitics), Tech (startups/AI), and Finance (markets/exchanges) with one click in the header bar.

**Show**: Click the variant switcher (🌍 WORLD | 💻 TECH | 📈 FINANCE).

### 7. Market & Crypto Intelligence

7-signal macro radar with composite BUY/CASH verdict, BTC spot ETF flow tracker, stablecoin peg monitor, Fear & Greed Index, and Bitcoin technical indicators. Sparkline charts and donut gauges for visual trends.

**Show**: Scroll to the crypto/market panels. Point out the sparklines.

### 8. Live Video & Webcam Feeds

8 live news streams (Bloomberg, Al Jazeera, Sky News, etc.) + 19 live webcams from geopolitical hotspots across 4 regions. Idle-aware — auto-pauses after 5 minutes of inactivity.

**Show**: Open the video panel or webcam panel.

### 9. Desktop Application (Free)

Native app for macOS, Windows, and Linux via Tauri. API keys stored in OS keychain (not plaintext). Local Node.js sidecar runs all 60+ API handlers offline-capable. Run local LLMs for fully private, offline AI summaries.

**Show**: The download buttons on the site, or the desktop app running natively.

### 10. Story Sharing & Social Export

Generate intelligence briefs for any country and share to Twitter/X, LinkedIn, WhatsApp, Telegram, Reddit. Includes canvas-rendered PNG images with QR codes linking back to the live dashboard.

**Show**: Generate a story for a country → share dialog with platform options.

### 11. Local LLM Support (Ollama / LM Studio)

Run AI summarization entirely on your own hardware — no API keys, no cloud, no data leaving your machine. The desktop app auto-discovers models from Ollama or LM Studio, with a three-tier fallback chain: local → Groq → OpenRouter. Settings are split into dedicated LLMs and API Keys tabs for easy configuration.

**Show**: Open Settings → LLMs tab → Ollama model dropdown auto-populated → generate a summary with the local model.

---

## Visual Content Suggestions

### Screenshots Worth Taking

1. **Full dashboard overview** — globe in center, panels on sides, news feed visible
2. **Country dossier page** — click Japan or a hotspot country, show the full brief
3. **Layer toggle demo** — before/after with conflicts + military bases enabled
4. **Finance variant** — stock exchanges, financial centers, market panels
5. **Japanese UI** — show the language switcher and Japanese interface
6. **Webcam grid** — 4 live feeds from different regions
7. **Strategic Posture** — theater risk levels panel
8. **Settings LLMs tab** — Ollama model dropdown with local models discovered

### Video/GIF Ideas

1. **30-second tour**: Open site → rotate globe → toggle layers → click country → show brief
2. **Language switch**: English → Japanese, show how feeds adapt
3. **Layer stacking**: Start empty → add conflicts → military → cyber → fires → wow
4. **Variant switching**: World → Tech → Finance in quick succession

---

## Talking Points for Posts

### For General Audience

- "An open-source Bloomberg Terminal for everyone — free, no login required"
- "170+ news sources, military tracking, AI analysis — all in one dashboard"
- "Run AI summaries locally with Ollama — your data never leaves your machine"
- "Available in Japanese with NHK and Nikkei feeds built in"
- "Native desktop app for macOS/Windows/Linux, completely free"

### For Tech Audience

- "Built with TypeScript, Vite, deck.gl, MapLibre GL, Tauri"
- "40+ WebGL data layers running at 60fps"
- "ONNX Runtime Web for browser-based ML inference (sentiment, NER, summarization)"
- "Local LLM support — plug in Ollama or LM Studio, zero cloud dependency"
- "Open source under AGPL-3.0 — contribute on GitHub"

### For Finance/OSINT Audience

- "7-signal crypto macro radar with BUY/CASH composite verdict"
- "92 global stock exchanges mapped with market caps and trading hours"
- "Country Instability Index tracking 22 nations in real-time"
- "Prediction market integration for geopolitical forecasting"
- "Air-gapped AI analysis — run Ollama locally for sensitive intelligence work"

### For Japanese Audience Specifically

- 日本語完全対応 — UI、ニュースフィード、AI要約すべて日本語で利用可能
- NHK World、日経アジアなど日本向けニュースソース内蔵
- 無料・オープンソース — アカウント登録不要
- macOS/Windows/Linux対応のデスクトップアプリあり

---

## Recent Major Features (Changelog Highlights)

| Version | Feature |
|---------|---------|
| v2.5.1 | Batch FRED fetching, parallel UCDP, partial cache TTL, bot middleware |
| v2.5.0 | Ollama/LM Studio local LLM support, settings split into LLMs + API Keys tabs, keychain vault consolidation |
| v2.4.1 | Ultra-wide layout (panels wrap around map on 2000px+ screens) |
| v2.4.0 | Live webcams from 19 geopolitical hotspots, 4 regions |
| v2.3.9 | Full i18n: 19 languages including Japanese, Arabic (RTL), Chinese |
| v2.3.8 | Finance variant with 92 exchanges, Gulf FDI investments |
| v2.3.7 | Light/dark theme system, UCDP/UNHCR/Climate panels |
| v2.3.6 | Desktop app with Tauri, OS keychain, auto-updates |
| v2.3.0 | Country Intelligence dossiers, story sharing |

---

## Branding Notes

- **Name**: "World Monitor" (two words, capitalized)
- **Tagline**: "Real-time global intelligence dashboard"
- **License**: AGPL-3.0 (free and open source)
- **Creator**: Credit "World Monitor by Elie Habib" or link to the GitHub repo
- **Variants**: You can mention all three (World/Tech/Finance) or focus on the main one
- **No login required**: Anyone can use the web app immediately — no signup, no paywall

---

## Thank You

We genuinely appreciate community members helping grow World Monitor's reach. Feel free to interpret these guidelines creatively — there's no strict template. The most compelling content comes from showing what YOU find most interesting or useful about the tool.

If you have questions or want specific screenshots/assets, open a Discussion on the GitHub repo or reach out directly.
