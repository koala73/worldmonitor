# World Monitor — Deep Research Report

> Generated: 2026-03-12
> Codebase version: 2.6.1 (AGPL-3.0)
> Lines of code: ~120K TypeScript + proto definitions

---

## 1. What Is This?

**World Monitor** is a real-time global intelligence dashboard. It aggregates dozens of live data sources — financial markets, military activity, aviation, maritime tracking, cybersecurity threats, conflict events, economic indicators, climate anomalies, and more — into a single, unified situational-awareness interface.

It runs as:
- A **web app** deployed on Vercel (multiple public variants)
- A **desktop app** built with Tauri (macOS, Windows, Linux)
- A **PWA** for offline access on mobile

The product ships in multiple "variants" from a single codebase: `full`, `tech`, `finance`, `happy`, `commodity` — each with different panels, feeds, map layers, and branding.

---

## 2. Repository Structure

```
worldmonitor/
├── src/                  # Preact SPA frontend (~115K lines TypeScript)
├── server/               # Typed RPC handlers (Vercel Edge backend)
├── api/                  # Vercel Edge Function entry points (~4K lines JS)
├── convex/               # Convex DB (registration + contact forms)
├── proto/                # 144 Protobuf definitions (Sebuf codegen)
├── src-tauri/            # Tauri desktop app (Rust wrapper + config)
├── docs/                 # Mintlify documentation site
├── tests/                # Playwright E2E + unit tests
├── scripts/              # 50+ data seeding + build automation scripts
├── docker/               # Docker image (nginx + Node.js sidecar)
├── data/                 # Static datasets (curated bases, telegram channels)
├── shared/               # Shared JSON (crypto lists, stock symbols, sectors)
├── middleware.ts          # Vercel Edge middleware (bot filtering, OG generation)
├── vercel.json           # Deployment config (cache headers, rewrites, CSP)
├── vite.config.ts        # Vite build config (PWA, Brotli, multi-variant)
├── buf.yaml / buf.gen.yaml  # Protobuf linting + code generation
└── Makefile              # Proto compilation targets
```

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | Preact (React-compatible, smaller bundle) |
| Build tool | Vite with PWA plugin, Brotli pre-compression |
| 2D maps | MapLibre GL (OpenFreeMap / PMTiles tiles) |
| 3D maps | Deck.gl (WebGL), Globe.gl (Three.js) |
| API protocol | Protocol Buffers via **Sebuf** (custom TypeScript codegen) |
| Backend runtime | Vercel Edge Functions (Node.js-compatible) |
| Database | Convex (registrations, contacts), Upstash Redis (shared cache) |
| Desktop | Tauri (Rust shell) + Node.js sidecar API |
| Real-time | Optional Railway WebSocket relay |
| AI/LLM | Groq (primary), OpenRouter (fallback) — LLaMA 3.3 70B |
| Local ML | @xenova/transformers (ONNX Runtime, runs in Web Workers) |
| Monitoring | Sentry (errors), Vercel Analytics (web vitals) |
| Testing | Playwright (E2E), custom unit tests (mjs/mts) |
| Language | TypeScript throughout (strict mode, ES2020 target) |

---

## 4. Multi-Variant Architecture

This is one of the most distinctive aspects of the codebase: **one repo ships five different products**.

```
VITE_VARIANT = full | tech | finance | happy | commodity
```

Variant-specific behavior is scattered across:

- **`src/config/feeds.ts`** — different RSS sources per variant (e.g., tech gets TechCrunch, ArXiv, HN; finance gets Bloomberg, FT feeds)
- **`src/config/panels.ts`** — default panel layout per variant
- **`src/config/map-layer-definitions.ts`** — map layers differ (tech shows AI labs/datacenters; finance shows stock exchanges/ports; happy shows conservation areas)
- **`src/config/variant-meta.ts`** — title, description, OG tags, theme color
- **`vite.config.ts`** — HTML injection of metadata based on `VITE_VARIANT`

The same pipeline handles all five in CI/CD. Vercel routes subdomains (`tech.worldmonitor.app`) to the right variant via middleware host mapping.

**Desktop variants** are also supported: separate `tauri.tech.conf.json`, `tauri.finance.conf.json` for Tauri-bundled builds.

---

## 5. Protobuf + Sebuf RPC Layer

The entire client↔server contract is defined in **144 `.proto` files** under `/proto/worldmonitor/`.

Rather than using standard gRPC, the project uses [**Sebuf**](https://github.com/SebastienMelki/sebuf) — a custom lightweight TypeScript code generator on top of `buf`. It generates:

- `src/generated/client/` — TypeScript client stubs (called from browser)
- `src/generated/server/` — TypeScript server handler interfaces
- `docs/api/` — OpenAPI v3 specs (auto-derived from protos)

**Proto organization** mirrors the service domain tree:
```
proto/worldmonitor/
├── core/v1/       (common types: country, pagination, i18n, errors)
├── market/v1/     (stock quotes, crypto, commodities, ETF flows)
├── aviation/v1/   (flight tracking, airport delays, carrier ops)
├── maritime/v1/   (AIS vessel snapshots, navigational warnings)
├── military/v1/   (fleet posture, aircraft tracking)
├── cyber/v1/      (threat intelligence)
├── conflict/v1/   (ACLED, UCDP, Iran events)
├── intelligence/v1/ (risk scores, GDELT, country intel)
├── economic/v1/   (FRED, BIS, EIA, government spending)
├── research/v1/   (ArXiv, GitHub, tech events, HackerNews)
├── climate/v1/
├── natural/v1/
├── wildfire/v1/
├── ...27 domains total
```

**Why this matters**: Every API call is typed end-to-end. Adding a new data field requires updating the proto, regenerating code, and TypeScript will fail to compile until both client and server handle it. This is a significant discipline investment but pays off at scale.

---

## 6. Backend: API Gateway + RPC Handlers

### 6.1 Vercel Edge Function Entry Points (`/api/`)

There are 27+ subdirectory services (each with a `/v1` handler) plus root-level thin handlers:

- `bootstrap.js` — serves initial hydration payload from Redis cache
- `health.js` — circuit breaker status across all data sources
- `og-story.js` — generates Open Graph HTML for story share links
- `rss-proxy.js` — RSS proxy with domain allowlist
- `telegram-feed.js` — OSINT relay for Telegram channels
- `opensky.js` — aircraft position stream
- `oref-alerts.js` — Israeli air raid alerts
- `satellites.js` — TLE orbital data
- `ais-snapshot.js` — AIS vessel snapshot
- `polymarket.js` — prediction market proxy
- ...etc.

Shared middleware files (prefixed with `_`):
- `_cors.js` — CORS header management
- `_api-key.js` — API key validation (origin-aware)
- `_rate-limit.js` — Upstash Redis rate limiting
- `_relay.js` — Railway relay handler pattern
- `_rss-allowed-domains.js` — RSS domain whitelist

### 6.2 Gateway Architecture (`server/gateway.ts`)

All requests flow through a typed TypeScript gateway before hitting RPC handlers:

```
Request
  → Origin check (CORS validation)
  → CORS headers
  → OPTIONS preflight (204)
  → API key validation (three-tier: desktop / trusted browser / unknown)
  → Rate limiting (Upstash Redis, per-endpoint then global)
  → Route matching (O(1) Map for statics, pattern match for dynamics)
  → RPC handler
  → Cache headers (fast/medium/slow/daily tiers)
  → Response
```

**Cache tiers by category**:
| Tier | s-maxage | Examples |
|---|---|---|
| `fast` | 300s | Market quotes, earthquakes, service status |
| `medium` | 600s | Crypto, ETF flows, macro signals |
| `slow` | 1800s | ACLED events, cyber threats, military flights |
| `static` | 7200s | Tech events, research papers, bases |
| `daily` | 86400s | Country facts, critical minerals |
| `no-store` | — | Real-time vessels, aircraft |

### 6.3 RPC Handlers (`/server/worldmonitor/`)

Each domain has a `handler.ts` that composes multiple sub-RPCs. For example, `market/v1/handler.ts` wires together:
- `list-market-quotes.ts` (Finnhub + Yahoo Finance)
- `list-crypto-quotes.ts` (CoinGecko)
- `list-commodity-quotes.ts` (Yahoo Finance)
- `get-sector-summary.ts` (Finnhub)
- `list-stablecoin-markets.ts` (CoinGecko)
- `list-etf-flows.ts` (Yahoo Finance BTC ETF flows)
- `list-gulf-quotes.ts` (GCC indices, currencies, oil)
- `analyze-stock.ts` (premium)
- `backtest-stock.ts` (premium)

Shared server utilities live in `server/_shared/`:
- `redis.ts` — Upstash Redis client singleton
- `cache-keys.ts` — All cache key constants
- `rate-limit.ts` — Rate limiting logic
- `llm.ts` — Groq/OpenRouter LLM client
- `acled.ts` — Armed conflict data client
- `sidecar-cache.ts` — Tauri sidecar-specific cache

---

## 7. Frontend Application Architecture

### 7.1 Entry and Initialization

`src/main.ts` → `src/App.ts` (the root ~35K-line orchestrator class)

**Boot sequence**:
1. Initialize Sentry + analytics
2. `initDB()` — create IndexedDB stores (`persistent-cache`, `vector-db`)
3. Fetch `/api/bootstrap` for initial data hydration
4. Parse URL state (map center, active panels, time range)
5. Detect runtime: Tauri (wait for sidecar on port 46123) vs. web
6. Initialize managers: `PanelLayoutManager`, `DataLoaderManager`, `EventHandlerManager`, `SearchManager`, `CountryIntelManager`, `RefreshScheduler`
7. Hydrate visible panels (viewport-prioritized)
8. Subscribe to real-time updates (if `WS_RELAY_URL` configured)

### 7.2 Panel System

All content is delivered through **dynamic, lazy-loaded panels**. There are 50+ panel types:

**Intelligence panels**: NewsPanel, GdeltIntelPanel, TelegramIntelPanel, InsightsPanel, ConflictPanel, MilitaryFlightsPanel, MilitaryVesselsPanel, UsniFleetPanel, CyberPanel, InfrastructurePanel, CableHealthPanel, CountryBriefPanel, CountryIntelPanel...

**Market & economic panels**: MarketPanel, HeatmapPanel, CommoditiesPanel, CryptoPanel, MacroSignalsPanel, EconomicPanel, ETFFlowsPanel, StockAnalysisPanel, GulfEconomiesPanel...

**Geographic & climate panels**: GlobeMap, ClimateAnomalyPanel, WildfirePanel, SatelliteFiresPanel, EarthquakesPanel, NaturalEventsPanel, DisplacementPanel...

**Research panels**: ResearchPanel, TechEventsPanel, HackerNewsPanel, BreakthroughsTickerPanel...

Panels implement a shared interface:
```typescript
Panel {
  id: string
  isNearViewport(marginPx?: number): boolean
  show(): void
  hide(): void
  fetchData(): Promise<void>
}
```

Panels are loaded **only when near the viewport** (400px margin by default), deferring off-screen data fetches.

### 7.3 Services Layer

`src/services/` has 57 modules organized by domain. Key patterns:

**Domain services** (one per API domain — market, aviation, maritime, military, cyber, conflict, intelligence, economic, research, etc.)

**Infrastructure services**:
- `bootstrap.ts` — Initial data hydration from cache/API
- `rpc-client.ts` — Sebuf gRPC client configuration
- `summarization.ts` — AI summaries via Groq/OpenRouter
- `analysis-worker.ts` / `ml.worker.ts` — Web worker communication
- `clustering.ts` — Event deduplication and clustering
- `persistent-cache.ts` — IndexedDB + Tauri cache layer
- `runtime.ts` — Tauri desktop detection
- `circuit-breaker.ts` — Per-service resilience pattern
- `analytics.ts` — Sentry + Vercel Analytics
- `i18n.ts` — Internationalization

**Intelligence/analysis services**:
- `hotspot-escalation.ts` — Dynamic risk scoring per hotspot
- `geo-convergence.ts` — Multi-event type clustering via H3 hexagons
- `country-instability.ts` — Historical learning model per country
- `infrastructure-cascade.ts` — Cascading failure detection
- `cross-module-integration.ts` — Cross-domain signal unification

### 7.4 Map Layers

Three rendering technologies are used together:
- **MapLibre GL** — base 2D map (OpenFreeMap tiles, PMTiles for offline)
- **Deck.gl** — WebGL overlays: heatmaps, animated flows, 3D buildings
- **Globe.gl** — Three.js spherical 3D globe view

50+ layer types are defined in `src/config/map-layer-definitions.ts`, grouped by variant:
- News/intelligence: clustered events, hotspots, threat levels, protests
- Military: flight paths, vessel positions, strategic bases
- Infrastructure: submarine cables, power lines, datacenters, 5G towers
- Traffic: AIS vessel density, OpenSky aircraft positions
- Natural: earthquakes, fires, hurricanes, sea ice extent
- Economic: stock exchanges, ports, airports, trade routes
- Geopolitical: disputed territories, conflict zones, country borders
- Analytics: volatility heatmaps, conflict risk maps, tech activity density

---

## 8. Caching Architecture (Four Tiers)

This is a core design concern throughout the codebase.

```
Tier 1: In-process memory
  → Circuit breaker per-service cache (10-30 min TTL)

Tier 2: Browser persistent cache
  → IndexedDB via persistent-cache.ts (survives page reload, up to 24h)

Tier 3: Vercel CDN
  → s-maxage headers (300s – 86400s per endpoint, shared across all users)

Tier 4: Upstash Redis
  → Shared key-value store, one entry per data source
  → Written by seeding scripts and API handlers
  → Read by /api/bootstrap for initial hydration
```

**Fallback chain when fetching data**:
1. Is data in memory cache and fresh? → Return it
2. Is data stale but not too old? → Return stale, fetch fresh in background (SWR)
3. Network error? → Return default fallback or circuit-break
4. Desktop offline? → Use Tauri filesystem cache

---

## 9. Circuit Breaker Pattern

Defined in `src/utils/circuit-breaker.ts`, used throughout the services layer.

**State machine**:
- `CLOSED` — normal operation
- `OPEN` — after N failures, stop trying for cooldown period (default 5 minutes)
- Automatic recovery after cooldown

**Configuration per breaker**:
- `maxFailures` (default: 2)
- `cooldownMs` (default: 300000ms / 5 min)
- `cacheTtlMs` — how long to cache a successful result
- `persistCache` — whether to also write to IndexedDB
- `name` — for health endpoint reporting

**Stale-While-Revalidate logic**:
```
if (staleCache && cacheTtlMs > 0) {
  // Return stale immediately
  // Trigger background refresh
  fireAndForget(fn().then(recordSuccess))
  return staleCache
}
```

Every major data source has its own named breaker instance, enabling the `/api/health` endpoint to report per-source status.

---

## 10. Authentication & Authorization

### API Key System (`api/_api-key.js`)

Three client classes with different policies:

| Origin class | Examples | Policy |
|---|---|---|
| **Desktop** | `tauri://`, `asset://`, `tauri.localhost` | Always require API key |
| **Trusted browser** | `worldmonitor.app`, Vercel previews, localhost | Optional (unless premium endpoint) |
| **Unknown** | curl, external callers | Always require API key |

Keys are validated against `WORLDMONITOR_VALID_KEYS` (env var, comma-separated), must start with `wm_`.

**Premium-only endpoints** (require key even from trusted origins):
- `/api/market/v1/analyze-stock`
- `/api/market/v1/backtest-stock`
- `/api/market/v1/get-stock-analysis-history`
- `/api/market/v1/list-stored-stock-backtests`

### Bot Filtering (`middleware.ts`)

Vercel Edge middleware blocks bots and scrapers (403) while allowing social preview bots (Twitter, Facebook, LinkedIn, Telegram) on the root path for OG generation.

Blocked patterns: `bot|crawl|spider|slurp|gptbot|claudebot|ccbot|...` (case-insensitive)

---

## 11. Real-Time Data via Railway Relay

The architecture supports an optional Railway-hosted WebSocket relay server for real-time streaming:

```
Browser
  ↓ (subscribe via HTTP)
Vercel Function (/api/*/subscribe)
  ↓ (relay with signed secret)
Railway Sidecar (Node.js)
  ├─ AIS vessel positions (AISStream)
  ├─ Aircraft positions (OpenSky)
  ├─ RSS feed aggregation (stateful polling)
  └─ Telegram OSINT poller (MTProto session)
  ↓ (WebSocket broadcast)
Browser (real-time updates)
```

This is optional — when `WS_RELAY_URL` is not configured, the app falls back to HTTP polling. The relay authentication uses a shared secret (`RELAY_SHARED_SECRET`) signed per-request.

---

## 12. Intelligence Signal Processing

### 12.1 News Event Clustering

Challenge: 100+ RSS feeds produce thousands of daily articles with massive duplication.

Pipeline in `src/services/clustering.ts`:
1. Deduplication hash: SHA256(title + publication date)
2. Keyword extraction: TF-IDF weighted
3. Cosine similarity clustering (threshold: 0.7+)
4. Source tier ranking (Reuters > BBC > AP > bloggers)
5. Velocity calculation (sources per hour)
6. Result: 1000+ raw articles → 50-100 actionable clusters

Output type:
```typescript
ClusteredEvent {
  primaryTitle: string
  sourceCount: number           // e.g., 47 sources covering the story
  topSources: Source[]          // [{Reuters, BBC, AP, ...}]
  velocity: { sourcesPerHour, level: 'normal'|'elevated'|'spike', trend }
  threat: { level: 'low'|'medium'|'high', tags: string[] }
}
```

### 12.2 Geo-Convergence Detection

Uses H3 hexagonal indexing to detect when multiple event types cluster in the same geographic area. The idea:
- Single event type = noise
- Two types in same hex = correlation signal
- Three+ types = actionable intelligence alert

Example: military flights + protests + power outages in the same region → coordinated event.

### 12.3 Hotspot Escalation Scoring

Dynamic risk scoring per geographic hotspot (`src/services/hotspot-escalation.ts`):

```typescript
DynamicEscalationScore {
  staticBaseline: number       // Pre-configured baseline risk (0–5)
  dynamicScore: number         // Real-time computed
  combinedScore: number        // weighted(static, dynamic)
  trend: 'escalating' | 'stable' | 'de-escalating'
  components: {
    newsActivity: number        // velocity × threat weight
    ciiContribution: number     // critical infra within 50km
    geoConvergence: number      // multi-event-type clustering
    militaryActivity: number    // flight/vessel activity delta
  }
  history: Array<{timestamp, score}>
}
```

### 12.4 AI Summarization

Pipeline in `src/services/summarization.ts`:
1. **Primary**: Groq (LLaMA 3.3 70B, ~14,400 req/day free)
2. **Fallback**: OpenRouter (50 req/day free)
3. **Caching**: Upstash Redis with key = hash(URL + prompt), TTL 30 days

Used for: article 1-2 sentence summaries, entity extraction, threat classification, translation.

### 12.5 Local ML (Web Workers)

`src/workers/ml.worker.ts` runs `@xenova/transformers` (ONNX Runtime) off the main thread for:
- Text embeddings (semantic similarity)
- Named entity recognition
- Text classification

`src/workers/analysis.worker.ts` handles computationally heavy tasks (clustering analysis, correlations, statistical aggregations) to avoid UI blocking.

---

## 13. Data Sources (External APIs)

The app integrates ~30+ external data sources. Key ones:

| Domain | Source | Notes |
|---|---|---|
| Stocks | Finnhub, Yahoo Finance | Real-time + historical |
| Crypto | CoinGecko | Quotes + market data |
| Commodities | Yahoo Finance | Oil, metals, agriculture |
| Aviation | AviationStack, ICAO, Wingbits, OpenSky | Delays, tracking, military |
| AIS Vessels | AISStream | WebSocket, real-time |
| Conflict | ACLED, UCDP | Armed conflict event databases |
| Cyber threats | Multiple feeds | Threat intelligence aggregation |
| Economic | FRED (Fed Reserve), BIS, EIA | Macro data, energy, rates |
| Climate | NASA FIRMS | Satellite fire detection |
| Natural disasters | USGS, EONET | Earthquakes, natural events |
| Internet outages | Cloudflare API | ASN-level outage data |
| Submarine cables | TeleGeography | Cable health, activity |
| Geopolitics | GDELT | Document-level event analysis |
| Prediction markets | Polymarket | Binary prediction markets |
| AI summaries | Groq, OpenRouter | LLM inference |
| Displacement | UNHCR | Refugee/displacement data |
| Gulf markets | GCC exchange feeds | Regional Arab market data |
| Tech events | Custom | Conference/event calendar |
| Research | ArXiv, GitHub | Academic papers, trending repos |

---

## 14. Desktop App (Tauri)

The Tauri wrapper ships a full local API server (Node.js sidecar) on port 46123. This enables:
- **Offline operation**: Bundled cache data can be served without network
- **No CORS issues**: Local API is localhost-trusted
- **Custom CSP**: Tauri allows stricter IPC-based communication
- **Auto-update**: Tauri handles app update distribution

Configuration files:
- `src-tauri/tauri.conf.json` (full variant, 1440×900 window)
- `src-tauri/tauri.tech.conf.json` (tech variant)
- `src-tauri/tauri.finance.conf.json` (finance variant)

Build targets: macOS (DMG), Windows (NSIS + MSI), Linux (AppImage).

Build commands: `npm run desktop:package:macos:full:sign` etc.

---

## 15. Backend Database (Convex)

Convex handles two lightweight use cases:

```typescript
registrations {
  email: string
  normalizedEmail: string     // indexed
  registeredAt: number
  source?: string             // e.g., "tech.worldmonitor.app"
  appVersion?: string
  referralCode?: string       // indexed
  referredBy?: string
  referralCount?: number
}

contactMessages {
  name: string
  email: string
  organization?: string
  message?: string
  source: string
  receivedAt: number
}

counters {
  name: string                // indexed
  value: number
}
```

Mutations: `registerInterest`, `submitContactMessage`, `incrementCounter`.

---

## 16. Data Seeding Scripts

`/scripts/` contains 50+ automation scripts. The seeding scripts populate Upstash Redis on a schedule (via Railway cron or manual trigger):

```
seed-market-quotes.mjs         → Redis market cache
seed-crypto-quotes.mjs
seed-commodity-quotes.mjs
seed-etf-flows.mjs
seed-earthquakes.mjs           → USGS data
seed-internet-outages.mjs      → Cloudflare data
seed-cyber-threats.mjs
seed-fire-detections.mjs       → NASA FIRMS
seed-military-flights.mjs
seed-natural-events.mjs        → EONET
seed-climate-anomalies.mjs
seed-displacement-summary.mjs  → UNHCR
seed-prediction-markets.mjs    → Polymarket
seed-airport-delays.mjs        → FAA
seed-gulf-quotes.mjs
seed-insights.mjs              → LLM-generated summaries
seed-bis-data.mjs
seed-military-bases.mjs
```

These seeds ensure the `/api/bootstrap` response is populated even before any user hits the app, reducing cold-start latency.

---

## 17. Vercel Edge Middleware

`middleware.ts` runs on every request before routing:

1. **Bot filtering** — Blocks scrapers/crawlers (403)
2. **Social preview allowlisting** — Twitter, Facebook, LinkedIn, Telegram bots pass through for OG
3. **OG image generation** — Per-variant social cards on root path
4. **Variant host mapping** — `tech.worldmonitor.app` → tech variant metadata injection
5. **User-Agent validation** — Rejects empty or suspiciously short UAs

---

## 18. Security

### Content Security Policy (from `vercel.json`)

```
default-src 'self'
connect-src 'self' https: wss: blob: data:
img-src 'self' data: blob: https:
style-src 'self' 'unsafe-inline'
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.youtube.com
worker-src 'self' blob:
frame-src https://www.youtube.com
frame-ancestors 'self' https://worldmonitor.app (and variants)
```

Notes:
- `unsafe-inline` styles required for dynamic theme colors
- `wasm-unsafe-eval` required for ONNX Runtime WebAssembly
- `unsafe-inline` scripts is a known tradeoff (Vite inlines small chunks)

### Other security measures
- HSTS (max-age 31536000, includeSubDomains, preload)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: blocks camera, microphone, geolocation by default
- DOMPurify for user-generated content
- RSS feed domain allowlist (`_rss-allowed-domains.js`)
- Input sanitization in `src/utils/sanitize.ts`

---

## 19. Build & Deployment Pipeline

### Web (Vercel)

```
git push main
  → Vercel build trigger
  → scripts/vercel-ignore.sh (skip if docs-only change)
  → npm run build (tsc + vite)
  → Deploy Edge Functions
  → Invalidate CDN cache
```

Key Vercel routing:
- `/docs` → Mintlify documentation
- `/pro` → `pro/index.html`
- All others → SPA catch-all

### Desktop (Tauri)

```
npm run desktop:build:full       # Build sidecar + frontend
npm run desktop:package:macos:full:sign  # Sign + notarize DMG
```

### Docker

Two-stage build:
1. `node:20-alpine` — compile frontend
2. `nginx:alpine` — serve static assets, proxy `/api/*` to upstream

Nginx template uses `API_UPSTREAM` env var for upstream API routing.

### Proto codegen

```
make generate   # buf generate → src/generated/{client,server}/ + docs/api/
```

---

## 20. Testing Strategy

### E2E (Playwright)

```
test:e2e:full        # Full variant, 100+ test cases
test:e2e:tech        # Tech variant
test:e2e:finance     # Finance variant
test:e2e:visual      # Golden screenshot regression per map layer
test:e2e:runtime     # Runtime API fetch validation
```

### Unit/Integration tests

- `tests/clustering.test.mjs` — event clustering algorithm
- `tests/deploy-config.test.mjs` — vercel.json correctness
- `tests/panel-config-guardrails.test.mjs` — per-variant panel defaults
- `tests/variant-layer-guardrail.test.mjs` — layer availability per variant
- `tests/stock-analysis.test.mts` — premium stock analysis endpoints
- `tests/gulf-fdi-data.test.mjs` — Gulf FDI dataset validation

---

## 21. Performance Optimizations

| Technique | Where | Effect |
|---|---|---|
| Brotli pre-compression | `vite.config.ts` plugin | -60–80% JS/CSS transfer size |
| Code splitting | Vite, per variant | Smaller per-variant bundles |
| PWA service worker | vite-plugin-pwa | Offline support, cache-first assets |
| Virtual scrolling | `VirtualList` component | O(1) memory for 1000s of news items |
| Viewport-based loading | `DataLoaderManager` | Defer off-screen panel fetches |
| Web workers | ml.worker, analysis.worker | ML inference + computation off main thread |
| Stale-while-revalidate | Circuit breaker | Zero perceived latency on refresh |
| CDN caching | Vercel s-maxage headers | Shared across all users, 5-min to 24h |
| Redis cache seeding | `/scripts/seed-*.mjs` | Pre-warm cache before users arrive |
| IndexedDB persistence | `persistent-cache.ts` | Survive page reloads without re-fetch |

---

## 22. Environment Variables (Key ones)

The `.env.example` lists ~195 variables. Categories:

| Category | Variables |
|---|---|
| AI summarization | `GROQ_API_KEY`, `OPENROUTER_API_KEY` |
| Cache (Redis) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Market data | `FINNHUB_API_KEY` |
| Energy | `EIA_API_KEY` |
| Economic | `FRED_API_KEY` |
| Aviation | `AVIATIONSTACK_API`, `ICAO_API_KEY`, `WINGBITS_API_KEY` |
| Conflict | `ACLED_ACCESS_TOKEN`, `UCDP_ACCESS_TOKEN` |
| Internet outages | `CLOUDFLARE_API_TOKEN` |
| Satellite fires | `NASA_FIRMS_API_KEY` |
| Real-time relay | `AISSTREAM_API_KEY`, `OPENSKY_CLIENT_ID/SECRET`, `TELEGRAM_API_ID/HASH/SESSION` |
| Relay config | `WS_RELAY_URL`, `RELAY_SHARED_SECRET`, `RELAY_AUTH_HEADER` |
| Frontend config | `VITE_VARIANT`, `VITE_WS_API_URL`, `VITE_SENTRY_DSN`, `VITE_PMTILES_URL` |
| Desktop | `WORLDMONITOR_VALID_KEYS` |
| Convex | `CONVEX_URL` |

---

## 23. Monitoring & Observability

**Sentry** (`src/main.ts`):
- Release tracking: `worldmonitor@2.6.1`
- 10% trace sampling
- 100+ filtered error patterns (ResizeObserver loops, WebGL context loss, network errors on mobile, browser extension errors)

**`/api/health` endpoint**:
Returns live circuit breaker state for every data source:
```json
{
  "cacheStatus": {
    "market": { "mode": "live|cached|unavailable", "timestamp": "...", "offline": false },
    "earthquakes": { ... },
    ...
  },
  "externalApis": {
    "finnhub": "ok|degraded|down",
    "groq": "ok",
    ...
  }
}
```

**Vercel Analytics**: Web Vitals (LCP, FID, CLS) + session tracking.

---

## 24. Notable Design Decisions & Tradeoffs

1. **Preact over React** — smaller bundle, near-identical API. Given the number of panels and WebGL canvases, every KB matters.

2. **Sebuf over grpc-web** — custom lightweight codegen avoids HTTP/2 gRPC overhead. Tradeoff: less community support, custom toolchain.

3. **Multi-variant from one repo** — disciplined but complex. All five products share the same deployment pipeline, which reduces ops overhead but makes every PR potentially affect all variants.

4. **AGPL-3.0 license** — means any derivative works must also be open-source. This is a deliberate choice for a public intelligence dashboard.

5. **Circuit breakers per service** — unusual for a frontend app, but logical given 30+ external API dependencies. Any single API failure won't cascade.

6. **Railway relay as optional enhancement** — real-time WebSocket is opt-in. Without it, the app still works via polling. This makes self-hosting easier.

7. **Convex for registration only** — the main data store is Upstash Redis (cache) and external APIs. Convex handles the small amount of user-generated state (registrations, contact forms). A pragmatic split.

8. **Local ML via transformers.js** — NER and embeddings run in the browser via ONNX Runtime. This avoids API costs for ML inference but requires WASM + large model downloads.

9. **Proto-first API design** — 144 `.proto` files before any implementation is written. Strong contracts, auto-generated docs. Overhead is real but enables confident refactoring.

10. **Tauri sidecar (Node.js in desktop)** — unusual pattern: the Rust Tauri shell doesn't implement the API; it spawns a full Node.js process. This lets the desktop app reuse 100% of the Vercel Edge Function code.

---

## 25. Codebase Size Summary

| Directory | Approx lines |
|---|---|
| `src/` | ~115,000 TypeScript |
| `server/` | ~8,000 TypeScript |
| `api/` | ~4,000 JavaScript |
| `proto/` | ~5,000 Protobuf |
| `convex/` | ~300 TypeScript |
| `tests/` | ~2,000 mixed |
| `scripts/` | ~3,000 JavaScript |
| **Total** | **~137,000+** |

---

## Summary

World Monitor is a well-engineered, production-grade global intelligence platform. Its most notable architectural achievements are:

- **Proto-first RPC discipline** across 27 service domains with auto-generated TypeScript + OpenAPI
- **Multi-variant single-codebase** for 5 distinct product flavors
- **Sophisticated four-tier caching** with circuit breakers and stale-while-revalidate at every layer
- **30+ external API integrations** aggregated into a unified real-time dashboard
- **Dual deployment target** (Vercel web + Tauri desktop) sharing the same backend code
- **Browser-local ML inference** via transformers.js for NLP tasks without API costs
- **Geographic signal processing** (H3 hexagons, geo-convergence, escalation scoring) that transforms raw events into actionable intelligence
