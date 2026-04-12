# WorldMonitor — Complete Codebase Documentation

> Auto-generated documentation. Committed incrementally every 5 minutes.
> Last section: **Part 1 — Architecture Overview & App Core**

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [App Core — `src/app/`](#2-app-core--srcapp)
3. [Frontend Services — `src/services/`](#3-frontend-services--srcservices)
4. [API Middleware — `api/_*.js`](#4-api-middleware--api_js)
5. [API Endpoints — `api/`](#5-api-endpoints--api)
6. [Server RPC Services — `server/worldmonitor/`](#6-server-rpc-services--serverworldmonitor)
7. [Convex Backend — `convex/`](#7-convex-backend--convex)
8. [Scripts & Build Tools — `scripts/`](#8-scripts--build-tools--scripts)
9. [Tauri Desktop Sidecar — `src-tauri/sidecar/`](#9-tauri-desktop-sidecar--src-taurisidecar)
10. [Docker & Deployment — `docker/`](#10-docker--deployment--docker)
11. [Custom Algorithms & Logic](#11-custom-algorithms--logic)
12. [Complete Data Source Map](#12-complete-data-source-map)

---

## 1. Architecture Overview

WorldMonitor is a **real-time global intelligence dashboard** built in TypeScript. It aggregates 100+ external data sources into interactive map/panel views.

### System Layers

```
┌──────────────────────────────────────────────────┐
│  Browser (Vite + TypeScript + Globe.gl/Deck.gl)  │
│  src/  — components, services, app modules       │
└────────────────────┬─────────────────────────────┘
                     │ RPC over HTTP (protobuf/JSON)
┌────────────────────▼─────────────────────────────┐
│  API Layer  (Vercel Edge Functions)               │
│  api/  — 60+ edge endpoints                      │
│  server/worldmonitor/  — 31 RPC domain handlers  │
└────────────────────┬─────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
┌─────────▼──────┐   ┌──────────▼──────────────┐
│  Upstash Redis  │   │  External APIs (100+)    │
│  (edge cache)   │   │  FRED, UCDP, NASA, etc.  │
└─────────────────┘   └──────────────────────────┘
          │
┌─────────▼──────────────────────────────────────┐
│  Convex  (serverless DB + auth + webhooks)      │
│  User prefs, alert rules, billing, entitlements │
└─────────────────────────────────────────────────┘
```

### Site Variants

Configured via `VITE_VARIANT` env var. Each variant shows a different panel set:

| Variant | Focus |
|---------|-------|
| `full` | All panels (default) |
| `finance` | Markets, economic, trade |
| `tech` | Research, cyber, infrastructure |
| `commodity` | Supply chain, energy, minerals |
| `happy` | Positive events, conservation, giving |

### Data Flow (end-to-end)

1. **Browser boots** → `src/main.ts` mounts `App.ts`
2. **Bootstrap** → single `GET /api/bootstrap` fetches ~90 Redis-cached keys in one pipeline call
3. **Panels load** → each panel calls its RPC endpoint via generated client stub (`src/generated/client/`)
4. **RPC handler** (`server/worldmonitor/{domain}/v1/`) fetches external API, caches in Redis
5. **Refresh scheduler** (`src/app/refresh-scheduler.ts`) re-fetches stale data on configurable intervals
6. **Correlation engine** (`src/services/correlation-engine/`) runs every cycle, cross-correlates signals

---

## 2. App Core — `src/app/`

### `app-context.ts`
**What it does:** Central shared state object (`AppContext`) passed to every app module.

**Holds:**
- `map` — MapContainer instance (Globe.gl / Deck.gl)
- `panels` — all active Panel component instances
- `allNews`, `newsByCategory` — aggregated news feed
- `latestMarkets` — market quote cache
- `intelligenceCache` — typed cache for flights, outages, protests, military, earthquakes, etc.
- `cyberThreatsCache` — latest threat indicators
- `inFlight` — Set of in-progress fetch names (prevents duplicate concurrent calls)
- `monitors` — active Monitor definitions
- Auth/modal/overlay component refs
- `correlationEngine` — CorrelationEngine instance

**Key pattern:** Every module receives `ctx: AppContext` so state is shared without a global store.

---

### `data-loader.ts`
**What it does:** Orchestrates all data fetching. Called on startup and by the refresh scheduler.

**Imports 60+ fetch functions** from `src/services/` and dispatches them based on active panels and config.

**Key fetch groups:**
- News: `fetchCategoryFeeds()` — RSS feeds grouped by category
- Markets: `fetchMultipleStocks()`, `fetchCommodityQuotes()`, `fetchSectors()`, `fetchCrypto()`
- Geo/Conflict: `fetchProtestEvents()`, `fetchGdeltTensions()`, `fetchNaturalEvents()`
- Military: `fetchMilitaryFlights()`, `fetchMilitaryVessels()`, `fetchPizzIntStatus()`
- Infrastructure: `fetchInternetOutages()`, `fetchTrafficAnomalies()`, `fetchDdosAttacks()`
- Economic: `fetchFredData()`, `fetchBisData()`, `fetchBlsData()`
- Supply Chain: `fetchShippingRates()`, `fetchChokepointStatus()`, `fetchCriticalMinerals()`
- Sanctions: `fetchSanctionsPressure()`
- Cyber: `fetchCyberThreats()`

**Panel-gated logic:** Checks `ctx.panelSettings` before fetching — disabled panels skip their data calls entirely.

---

### `refresh-scheduler.ts`
**What it does:** Manages periodic smart polling for all data sources.

**Class: `RefreshScheduler`**

```
scheduleRefresh(name, fn, intervalMs, condition?)
  └─ startSmartPollLoop() — pauses when tab is hidden
  └─ Skips if ctx.inFlight.has(name) — no duplicate calls
  └─ maxBackoffMultiplier: 4 — backs off on repeated errors

flushStaleRefreshes()
  └─ Called when tab becomes visible again
  └─ Collects all tasks stale by ≥ intervalMs
  └─ Staggered flush: first 4 tasks every 100ms, rest every 300ms
  └─ Sorted by interval ascending (highest-frequency first)

registerAll(registrations[])
  └─ Bulk registration at app init
```

**Key behaviour:** `pauseWhenHidden: true` — stops polling when the browser tab is not visible, saving API calls and battery.

---

### `panel-layout.ts`
**What it does:** Manages the draggable/resizable panel grid.

- Persists layout to `localStorage` and syncs to Convex (cloud)
- Handles panel show/hide, resize, reorder
- Reads `src/config/variants/` to determine default panel visibility per site variant

---

### `search-manager.ts`
**What it does:** Powers the global search modal.

- Searches across entities (companies, countries, orgs, militants) defined in `src/config/entities.ts`
- Cross-references news, market symbols, geo locations
- Uses `tokenizeForMatch()` + `matchKeyword()` from `src/utils/keyword-match.ts`

---

### `country-intel.ts`
**What it does:** On-demand loader for country-specific intelligence pages.

Fetches per-country data: GDELT event graph, UCDP conflict timeline, sanctions exposure, economic indicators, news, military presence.

---

### `pending-panel-data.ts`
**What it does:** Queue for panel data requests that arrive before the panel is mounted.

Uses `enqueuePanelCall()` — stores the RPC call in a queue; panel drains it on mount.

---

## 3. Frontend Services — `src/services/`

### Core Infrastructure

#### `bootstrap.ts`
- Calls `GET /api/bootstrap`
- Returns a dictionary of ~90 pre-cached data keys from Redis
- All panels receive their initial data from this single response — zero individual panel requests on first load

#### `rpc-client.ts`
- Base HTTP client for all RPC calls
- Adds auth headers (Clerk JWT), API key for desktop builds
- Routes to `LOCAL_API_SERVER` (Tauri sidecar) or Vercel edge depending on context

#### `auth-state.ts`
- Manages Clerk authentication state
- Subscribes to Convex for real-time user/session updates
- Exposes `isAuthenticated`, `userId`, `userEmail`

#### `billing.ts` + `entitlements.ts`
- Reads entitlement record from Convex (`tier`, `maxDashboards`, `apiAccess`, `exportFormats`)
- `hasPremiumAccess()` — used to gate Pro-only panels

#### `panel-gating.ts`
- Central feature-flag system
- Checks user entitlement tier against panel requirements
- Returns `{ allowed: boolean, reason: string }` per panel

---

### Domain Service Modules

#### `aviation/index.ts`
- Fetches flight delays: `GET /api/aviation/delays`
- Aircraft tracking via OpenSky Network (relay)
- Manages `PositionSample[]` history for trail rendering on map

#### `conflict/index.ts`
- UCDP events: `GET /api/conflict/ucdp-events`
- ACLED events: `GET /api/conflict/acled-events`
- Iran events: `GET /api/conflict/iran-events`
- Normalizes event schemas to `ClusteredEvent` type

#### `cyber/index.ts`
- Feodo Tracker, URLhaus, C2IntelFeeds, AlienVault OTX, AbuseIPDB
- Hydrates each threat with GeoIP data (lat/lon from IP)
- Returns `CyberThreat[]` with threat scoring

#### `market/index.ts`
- `fetchMultipleStocks()` — batches stock symbols, calls Finnhub/Yahoo
- `fetchCommodityQuotes()` — futures prices via Yahoo Finance
- `fetchCrypto()` — CoinGecko markets API
- `fetchSectors()` — sector ETF performance (Finnhub)
- All results cached in `ctx.latestMarkets`

#### `correlation-engine/`
Detailed in [Section 11](#11-custom-algorithms--logic).

#### `ai-classify-queue.ts`
**Rate-limited LLM classification queue for news events.**

```
AI_CLASSIFY_MAX_PER_WINDOW:
  finance variant: 40/min
  tech variant:    60/min
  full variant:    80/min

AI_CLASSIFY_MAX_PER_FEED: 2–3 items per feed per cycle
AI_CLASSIFY_DEDUP_MS: 30 minutes — same title won't re-queue

canQueueAiClassification(title):
  1. Prune window timestamps older than 60s
  2. Prune dedup map older than 30min
  3. Check rate cap → reject if at limit
  4. Check dedup map → reject if seen recently
  5. Accept → push timestamp, store dedup key
```

#### `analysis-core.ts`
Pure functions (no side effects) used by both main thread and Web Worker:
- `aggregateThreats()` — picks highest threat level from a list, weighted by tier
- Jaccard similarity for news clustering
- Signal ID generation, dedup key generation

#### `summarization.ts`
- Calls Groq API (`GROQ_API_KEY`) or OpenRouter fallback
- Summarizes article text to 2–3 sentences
- Used by News panels and the AI Analyst chat

#### `gdelt-intel.ts`
- Fetches GDELT GKG event graph
- Groups events by country/tone
- Returns top-tension country pairs

#### `military/index.ts`
- `fetchMilitaryFlights()` — Wingbits API for military aircraft
- `fetchMilitaryVessels()` — AIS relay (naval vessels)
- `initMilitaryVesselStream()` — WebSocket subscription to AIS relay
- Clusters flights/vessels by proximity for map display

#### `hotspot-escalation.ts` + `thermal-escalation.ts`
- Monitors for sudden spikes in conflict/fire events
- Returns `EscalationWatch` with affected regions and severity

#### `cached-risk-scores.ts` + `cached-theater-posture.ts`
- Reads pre-computed risk and theater posture from Redis (via bootstrap)
- Risk scores: per-country composite scores (conflict + economic + political)
- Theater posture: regional military readiness assessment

---

## 4. API Middleware — `api/_*.js`

These modules are shared utilities imported by all edge function endpoints.

### `_cors.js`
```js
getCorsHeaders(req, methods)
  Whitelists: *.worldmonitor.app, Vercel preview URLs, localhost:*
  Returns CORS headers object

isDisallowedOrigin(req)
  Returns true if Origin header is present but not whitelisted
```

### `_api-key.js`
```js
validateApiKey(req)
  Desktop (Tauri) origin: requires X-WorldMonitor-Key header
    → checks against WORLDMONITOR_VALID_KEYS env (comma-separated)
  Branded web origin (worldmonitor.app): always valid
  Unknown origin: marks as required=false (public access)
```

### `_rate-limit.js`
```js
getRatelimit()
  Lazy-initializes Upstash Ratelimit
  Algorithm: slidingWindow(600 requests, 60 seconds)
  Prefix: 'rl'

checkRateLimit(request, corsHeaders)
  IP extraction priority:
    1. cf-connecting-ip  (Cloudflare → actual client IP)
    2. x-real-ip
    3. x-forwarded-for (first entry)
  Returns 429 JSON response on limit exceeded with Retry-After header
  Returns null if within limit or Redis unavailable
```

### `_relay.js`
```js
createRelayHandler(cfg)
  Proxies requests through Railway relay server (WS_RELAY_URL)
  Used for APIs that block Vercel edge IPs (e.g. OpenSky, some gov APIs)

getRelayHeaders()
  Injects RELAY_SHARED_SECRET into Authorization and custom header

fetchWithTimeout(url, options, timeoutMs=15000)
  AbortController-based timeout wrapper

buildRelayResponse(response, body, headers)
  Wraps non-JSON upstream errors in JSON envelope
  Prevents Cloudflare HTML 502s from breaking client JSON parsing
```

### `_upstash-json.js`
```js
redisPipeline(keys[])
  Batches multiple Redis GET commands into one HTTP request
  Used by /api/bootstrap to fetch ~90 keys in a single round trip
  Returns Map<key, value> with JSON-parsed values
```

### `_turnstile.js`
```js
verifyTurnstile(token, ip)
  POST to https://challenges.cloudflare.com/turnstile/v0/siteverify
  Env: CLOUDFLARE_API_TOKEN
  Returns { success: boolean }
```

### `_rss-allowed-domains.js`
SSRF protection for the RSS proxy. Contains an allowlist of permitted RSS feed domains. Any URL not matching this list is rejected with 403.

---

---

## 5. API Endpoints — `api/`

### `/api/bootstrap` — `bootstrap.js`
**Route:** `GET /api/bootstrap` or `POST /api/bootstrap`

**What it does:** Aggregates ~90 Redis cache keys into a single response. This is the first request the frontend makes — it hydrates all panels simultaneously.

**Logic:**
```
1. Validate CORS + API key
2. Split keys into FAST_KEYS and SLOW_KEYS
3. redisPipeline(fastKeys) — first batch, returned immediately
4. redisPipeline(slowKeys) — second batch (streamed or parallel)
5. Merge both maps → return as JSON dict
```

**~90 Redis keys served:**
`earthquakes`, `outages`, `serviceStatuses`, `ddosAttacks`, `trafficAnomalies`, `marketQuotes`, `commodityQuotes`, `sectors`, `etfFlows`, `macroSignals`, `bisPolicy`, `bisExchange`, `bisCredit`, `shippingRates`, `chokepoints`, `minerals`, `giving`, `climateAnomalies`, `climateDisasters`, `co2Monitoring`, `oceanIce`, `radiationWatch`, `thermalEscalation`, `crossSourceSignals`, `wildfires`, `cyberThreats`, `predictions`, `cryptoQuotes`, `cryptoSectors`, `defiTokens`, `aiTokens`, `otherTokens`, `unrestEvents`, `iranEvents`, `ucdpEvents`, `weatherAlerts`, `techEvents`, `gdeltIntel`, `correlationCards`, `forecasts`, `securityAdvisories`, `sanctionsPressure`, `consumerPrices*`, `groceryBasket`, `bigmac`, `fuelPrices`, `fearGreedIndex`, `crudeInventories`, `natGasStorage`, `diseaseOutbreaks`, `pizzint`, `theaterPosture`, `riskScores`, and 40+ more.

---

### `/api/aviation/` — Flight & Airport Data

| File | Route | Data Source | Logic |
|------|-------|-------------|-------|
| `[icao].js` | `GET /api/aviation/:icao` | OpenSky Network (relay) | Aircraft in bounding box around airport; falls back to relay if direct fails |
| `[callsign].js` | `GET /api/aviation/:callsign` | FlightRadar24 (relay) | Single aircraft live track |
| `[region].js` | `GET /api/aviation/region/:region` | OpenSky + AviationStack | Regional aircraft density |
| `delays.js` | `GET /api/aviation/delays` | FAA ASWS XML + AviationStack | Parses FAA XML status feed; normalizes delay types (Ground Stop, GDP, etc.) |

---

### `/api/economic/` — Macroeconomic Data

| File | Data Source | Env Var | What It Returns |
|------|-------------|---------|-----------------|
| `fred-series.js` | FRED API | `FRED_API_KEY` | Time series for any FRED series ID (GDP, CPI, Fed Funds Rate, etc.) |
| `bls-series.js` | BLS API | `BLS_API_KEY` | Employment, unemployment, wage series |
| `fao-food-prices.js` | FAO REST | — | FAO Food Price Index (FFPI) monthly |
| `eu-yield-curve.js` | ECB SDMX | — | EU sovereign yield curves by country |
| `eurostat.js` | Eurostat REST | — | European statistics by country/indicator |
| `bis-policy.js` | BIS API | — | Central bank policy rates (60+ countries) |
| `bis-exchange.js` | BIS API | — | Effective exchange rates (nominal/real) |
| `bis-credit.js` | BIS API | — | Credit-to-GDP ratios |
| `crude-inventory.js` | EIA API | `EIA_API_KEY` | US crude oil + petroleum product inventories |
| `nat-gas-storage.js` | EIA API | `EIA_API_KEY` | US natural gas storage (weekly) |
| `ecb-fx.js` | ECB data portal | — | EUR/XXX daily exchange rates |

---

### `/api/market/` — Financial Markets

| File | Data Source | Logic |
|------|-------------|-------|
| `stock-quote.js` | Yahoo Finance → Finnhub fallback | Yahoo primary (free); Finnhub (`FINNHUB_API_KEY`) fallback; 600ms inter-request gate for Yahoo |
| `crypto-quote.js` | CoinGecko → CoinPaprika fallback | CoinGecko `/coins/markets`; falls back if rate-limited |
| `commodity-quote.js` | Yahoo Finance futures | Commodity symbols like `CL=F` (WTI), `GC=F` (Gold) |
| `earnings-calendar.js` | Finnhub | `FINNHUB_API_KEY`; upcoming earnings by date range |
| `fear-greed.js` | CNN Fear & Greed scrape | Scrapes `production.assets.markets.net.cnn.com`; returns `{ score, label }` |

---

### `/api/climate/` — Climate & Environmental

| File | Data Source | Env Var | Logic |
|------|-------------|---------|-------|
| `weather.js` | Open-Meteo alerts API | — | Fetches active weather alerts by bounding box |
| `satellites.js` | NASA FIRMS | `NASA_FIRMS_API_KEY` | Active fire detections from VIIRS/MODIS; last 24h; world extent |
| `co2-monitoring.js` | NOAA GML | — | Mauna Loa CO2 daily average; trends |

---

### `/api/conflict/` — Conflict & Violence

| File | Data Source | Env Var | Logic |
|------|-------------|---------|-------|
| `ucdp-events.js` | UCDP REST API | `UCDP_ACCESS_TOKEN` | Georeferenced events; last 30 days; includes fatalities |
| `acled-events.js` | ACLED API | `ACLED_ACCESS_TOKEN` | Political violence + protests; last 30 days; geo-filtered |
| `iran-events.js` | ACLED filtered | `ACLED_ACCESS_TOKEN` | Iran-specific events including IRGC, proxy activity |

---

### `/api/cyber/` — Cyber Threat Intelligence

| File | Data Source | Env Var | Logic |
|------|-------------|---------|-------|
| `feodo-tracker.js` | abuse.ch JSON | — | Botnet C2 IP list; enriched with GeoIP |
| `urlhaus.js` | URLhaus API | `URLHAUS_AUTH_KEY` | Recent malicious URLs; filtered by online status |
| `otx.js` | AlienVault OTX | `OTX_API_KEY` | Recent threat pulse indicators (IPs, domains, hashes) |
| `abuseipdb.js` | AbuseIPDB API | `ABUSEIPDB_API_KEY` | Top 1000 reported IPs; includes ISP + country |

---

### `/api/military/` — Military & Defense

| File | Data Source | Env Var | Logic |
|------|-------------|---------|-------|
| `wingbits.js` | Wingbits API | `WINGBITS_API_KEY` | Military aircraft positions (ADSB); filtered by military hex codes |
| `bases.js` | MIRTA + OSM + Pizzint composite | — | Pre-built military base list; served from Redis |
| `vessels.js` | AIS relay | `AISSTREAM_API_KEY` | Military vessel AIS positions from relay snapshot |

---

### `/api/intelligence/` — AI-Powered Intelligence

| File | What It Does |
|------|-------------|
| `gdelt.js` | Queries GDELT GKG for top event themes + tone by country |
| `pizzint.js` | Scrapes Pizzint intelligence feed; parses operational military intel |
| `company-enrichment.js` | Company data lookup: SerpAPI → Brave Search → Exa Search fallback chain; `SERPAPI_API_KEYS`, `BRAVE_API_KEYS`, `EXA_API_KEYS` |
| `securities-advisories.js` | CISA KEV + NVD CVE feed; last 30 days; severity-filtered |

---

### `/api/chat-analyst.ts` — AI Analyst (Pro)
**Route:** `POST /api/chat-analyst`  
**Auth:** Premium users only (`isCallerPremium()`)  
**Runtime:** Vercel Edge (`iad1`, `lhr1`, `fra1`, `sfo1`)

**Request body:**
```json
{ "history": [{role, content}], "query": "...", "domainFocus": "geo|market|military|economic", "geoContext": "US" }
```

**Response:** `text/event-stream` SSE:
```
data: {"meta":{"sources":["Brief","Risk"],"degraded":false}}
data: {"action":{"type":"suggest-widget","label":"...","prefill":"..."}}
data: {"delta":"...token..."}
data: {"done":true}
```

**Logic chain:**
```
1. Validate: max 500 char query, 20 history messages, 800 chars/message
2. assembleAnalystContext() — pulls Brief, Risk Scores, Theater Posture from Redis
3. buildAnalystSystemPrompt() — constructs system prompt with context
4. buildActionEvents() — checks if query is a visual/widget query → suggest-widget action
5. callLlmReasoningStream() — streams from Groq (primary) or OpenRouter (fallback)
6. SSE stream: meta → optional action → delta tokens → done
```

---

### `/api/notification-channels.ts` — Alert Routing

**What it does:** Manages per-user notification channel (Telegram, Slack, Discord, Email) CRUD.

- `GET` — list user's channels (from Convex)
- `POST` — register new channel; validates webhook URL format
- `DELETE` — unlink channel

---

### `/api/notify.ts` — Alert Dispatch

Dispatches alert payloads to all configured channels for a user.

**Logic:**
1. Look up user's `alertRules` from Convex
2. Check quiet hours (timezone-aware)
3. Check `digestMode`: if `daily`/`twice_daily`, queue for digest; if `realtime`, dispatch immediately
4. Route to Telegram bot API / Slack webhook / Discord webhook / Email

---

### `/api/mcp-proxy.js` — Model Context Protocol Proxy

Routes MCP tool calls from the frontend to local/remote MCP servers.  
Allows the AI Analyst to use tools (search, data lookup) without CORS issues.

---

### `/api/create-checkout.ts` — Billing

**Route:** `POST /api/create-checkout`  
Creates a Dodo Payments checkout session.  
**Env:** `DODO_API_KEY`, `DODO_BUSINESS_ID`  
Returns `{ checkoutUrl }` for redirect.

---

---

## 6. Server RPC Services — `server/worldmonitor/`

Each domain lives at `server/worldmonitor/{domain}/v1/`. A `handler.ts` composes individual RPC method files. All handlers share `server/_shared/` utilities for caching, rate limiting, relay, and LLM calls.

### Shared Utilities — `server/_shared/`

| File | Purpose |
|------|---------|
| `cache.ts` | Redis read/write helpers; `getOrSet(key, ttl, fn)` pattern |
| `rate-limit.ts` | Upstash sliding window; reads `cf-connecting-ip` for real client IP |
| `relay.ts` | Mirrors `api/_relay.js`; proxies via Railway for blocked IPs |
| `llm.ts` | `callLlmReasoningStream()` — Groq primary, OpenRouter fallback; handles SSE streaming |
| `llm-sanitize.js` | Strips control chars, trims to token budget before LLM calls |
| `premium-check.ts` | `isCallerPremium(req)` — validates Clerk JWT + Convex entitlement |
| `upstash-json.ts` | Redis pipeline batching |

---

### Aviation Service — `aviation/v1/`

**RPC Methods:**
| Method | External API | Logic |
|--------|-------------|-------|
| `listAirportDelays` | FAA ASWS XML | Parses FAA XML; maps delay programs (GDP, GS, AFP) to structured alerts |
| `getAirportOpsSummary` | FAA + AviationStack | Combines delay type, affected routes, avg delay minutes |
| `listAirportFlights` | OpenSky (relay) | Flights within 50nm bounding box; filtered by departure/arrival airport |
| `getCarrierOps` | AviationStack | `AVIATIONSTACK_API`; airline on-time performance by carrier code |
| `getFlightStatus` | AviationStack + FR24 | Real-time flight position + gate info |
| `trackAircraft` | Wingbits + OpenSky | Live hex → position; falls back chain: Wingbits → OpenSky relay → FR24 |
| `searchFlightPrices` | Google Flights scrape | Returns cheapest available fares |
| `listAviationNews` | RSS feeds (Aviation Week, FlightGlobal) | Via relay; parsed + categorized |
| `getYoutubeLiveStreamInfo` | YouTube Data API | Airport webcam live stream URLs |
| `searchGoogleFlights` | Google ITA matrix scrape | Price calendar for date flexibility |
| `searchGoogleDates` | Google Flights | Flexible date search results |

**Cache TTL:** 120s public tier, 60s for callsign/hex queries, 10s negative cache.

---

### Economic Service — `economic/v1/`

**RPC Methods:**
| Method | External API | Env Var | Logic |
|--------|-------------|---------|-------|
| `getFredSeries` | FRED API | `FRED_API_KEY` | Any FRED series by ID; frequency, units, observation range |
| `getFredSeriesBatch` | FRED API | `FRED_API_KEY` | Up to 10 series in parallel |
| `listWorldBankIndicators` | World Bank Open Data | — | Development indicators by country + year |
| `getEnergyPrices` | EIA API | `EIA_API_KEY` | Crude, natural gas, electricity prices |
| `getMacroSignals` | FRED + BLS + ECB | Multiple | Composite macro signal: rate, inflation, employment, yield curve |
| `getBisPolicyRates` | BIS API | — | Central bank policy rates for 60+ countries |
| `getBisExchangeRates` | BIS API | — | Broad/narrow effective exchange rates |
| `getBisCredit` | BIS API | — | Private sector credit-to-GDP; early warning indicator |
| `getEconomicCalendar` | TradingEconomics scrape | — | Upcoming economic releases by country |
| `getCrudeInventories` | EIA API | `EIA_API_KEY` | Weekly petroleum status report |
| `getNatGasStorage` | EIA API | `EIA_API_KEY` | Weekly natural gas in storage |
| `getEcbFxRates` | ECB SDMX | — | Daily EUR cross rates |
| `getEurostatCountryData` | Eurostat REST | — | GDP, unemployment, trade balance by EU country |
| `getEuGasStorage` | AGSI+ API (GIE) | — | European gas storage levels by country |
| `getEuYieldCurve` | ECB SDMX | — | Sovereign yield curves (2Y, 5Y, 10Y, 30Y) |
| `getEuFsi` | ECB Composite Indicator | — | EU Financial Stress Index |
| `getEconomicStress` | FRED composite | `FRED_API_KEY` | Composite stress index (volatility + credit spreads + money market) |
| `getFaoFoodPriceIndex` | FAO REST | — | Monthly FFPI and sub-indices (cereals, oils, dairy, meat, sugar) |
| `listGroceryBasketPrices` | UAE retail scrapers | — | Price of ~50 grocery items across UAE retailers |
| `listBigMacPrices` | Economist Big Mac Index | — | PPP-adjusted burger prices by country |
| `listFuelPrices` | GlobalPetrolPrices | — | Petrol/diesel prices for 170+ countries |
| `getNationalDebt` | IMF WEO | — | Debt-to-GDP by country |
| `getBlsSeries` | BLS Public Data API | `BLS_API_KEY` | Any BLS series (CPI, PPI, Employment Situation) |

---

### Market Service — `market/v1/`

**RPC Methods:**
| Method | External APIs | Logic |
|--------|--------------|-------|
| `listMarketQuotes` | Yahoo Finance → Finnhub | Batch stock quote fetch; 600ms Yahoo gate enforced in sidecar |
| `listCryptoQuotes` | CoinGecko `/coins/markets` | Top N coins by market cap; includes 24h change, volume |
| `listCommodityQuotes` | Yahoo Finance futures | WTI, Brent, Gold, Silver, Copper, Natural Gas, Wheat, Corn futures |
| `getSectorSummary` | Finnhub sector metrics | `FINNHUB_API_KEY`; sector ETF performance + relative strength |
| `listStablecoinMarkets` | CoinGecko | Stablecoin peg deviation monitoring (USDT, USDC, DAI, FRAX) |
| `listEtfFlows` | Yahoo Finance | BTC spot ETF net flows (IBIT, FBTC, GBTC, ARKB) estimated from NAV delta |
| `getCountryStockIndex` | Yahoo Finance | National stock index by ISO country code (^GSPC, ^FTSE, ^N225, etc.) |
| `listGulfQuotes` | Yahoo Finance | GCC indices (Tadawul, DFM, ADX, QSE), AED/USD, oil benchmarks |
| `analyzeStock` | LLM + news search | `GROQ_API_KEY`; fundamental + technical narrative for a ticker |
| `backtestStock` | Yahoo Finance historical | Simple backtest: entry/exit strategy applied to OHLCV history |
| `getFearGreedIndex` | CNN scrape | 0–100 score with label (Extreme Fear → Extreme Greed) |
| `listEarningsCalendar` | Finnhub | `FINNHUB_API_KEY`; earnings dates + EPS estimates for given week |
| `getCotPositioning` | CFTC COT report | Commitment of Traders; net long/short positioning by category |

---

### Climate Service — `climate/v1/`

**RPC Methods:**
| Method | Source | Logic |
|--------|--------|-------|
| `listFireDetections` | NASA FIRMS | `NASA_FIRMS_API_KEY`; VIIRS + MODIS detections; 24h window; global |
| `listWeatherAlerts` | Open-Meteo Alerts API | Active severe weather warnings by lat/lon bounding box |
| `getAirQuality` | WAQI API | `WAQI_API_KEY`; AQI + PM2.5 + PM10 for city/station |
| `getCO2Monitoring` | NOAA GML | Mauna Loa daily CO2 ppm; trend + annual delta |
| `getOceanIce` | NSIDC / NOAA | Arctic + Antarctic sea ice extent vs historical baseline |

---

### Conflict Service — `conflict/v1/`

**RPC Methods:**
| Method | Source | Env Var | Logic |
|--------|--------|---------|-------|
| `listUcdpEvents` | UCDP GED | `UCDP_ACCESS_TOKEN` | Georeferenced conflict events; filtered by date + fatality threshold |
| `listAcledEvents` | ACLED API | `ACLED_ACCESS_TOKEN` | 7 event types (battles, explosions, protests, riots, etc.) |
| `listIranEvents` | ACLED filtered | `ACLED_ACCESS_TOKEN` | Iran actors + proxy groups; theater-specific filtering |
| `getHumanitarianSummary` | OCHA/ReliefWeb | — | Active humanitarian crises by region |

---

### Cyber Service — `cyber/v1/`

**`listCyberThreats`** — aggregates 5 threat intel feeds:

```
1. Feodo Tracker JSON  →  C2 botnet IPs (abuse.ch)
2. URLhaus API         →  Malicious URLs (abuse.ch)   [URLHAUS_AUTH_KEY]
3. C2IntelFeeds CSV    →  GitHub raw; community C2 list
4. AlienVault OTX      →  Threat pulse IOCs            [OTX_API_KEY]
5. AbuseIPDB           →  Top reported IPs             [ABUSEIPDB_API_KEY]

Post-processing:
  - GeoIP lookup for each IP (lat/lon, country, ASN)
  - Threat type classification: C2, malware, phishing, scanner, botnet
  - Score: composite 0–100 based on report count + age + feed weight
  - Deduplicated by IP/URL key
```

---

### Infrastructure Service — `infrastructure/v1/`

**RPC Methods:**
| Method | Source | Logic |
|--------|--------|-------|
| `listInternetOutages` | Cloudflare Radar | `CLOUDFLARE_API_TOKEN`; ASN-level outage detection |
| `listServiceStatuses` | Atom Finance + status pages | Scrapes AWS, GCP, Azure, GitHub, Cloudflare status pages |
| `listDDoSAttacks` | Cloudflare Radar | DDoS event timeline with target country + attack vector |
| `listTrafficAnomalies` | Cloudflare Radar | BGP anomalies, traffic volume deviations |
| `getIpGeo` | MaxMind / ip-api | IP → lat/lon, country, ASN |
| `reverseGeocode` | Nominatim | lat/lon → address components |
| `getCableHealth` | TeleGeography (scrape) | Submarine cable disruption reports |
| `listTemporalAnomalies` | Internal baseline engine | Compares current data vs rolling baseline (see Section 11) |

---

### Military Service — `military/v1/`

**RPC Methods:**
| Method | Source | Env Var | Logic |
|--------|--------|---------|-------|
| `listMilitaryFlights` | Wingbits API | `WINGBITS_API_KEY` | Active military aircraft; filtered by hex code prefix (military registrations) |
| `getAircraftDetailsBatch` | Wingbits + ADS-B Exchange | `WINGBITS_API_KEY` | Registration, type, operator, origin country for up to 20 hex codes |
| `getWingbitsStatus` | Wingbits health | `WINGBITS_API_KEY` | Feed health; coverage stats; last seen timestamps |
| `getWingbitsLiveFlight` | Wingbits | `WINGBITS_API_KEY` | Full track history for a single military flight |

---

### Research Service — `research/v1/`

**RPC Methods:**
| Method | Source | Logic |
|--------|--------|-------|
| `listTechEvents` | Techmeme ICS + dev.events RSS | Parses iCal + RSS; deduplicates; geo-tags conference locations |
| `listHackernewsItems` | HN Algolia API | Top 30 stories; includes points, comment count, domain |
| `listArxivPapers` | arXiv API | Search by category (cs.AI, cs.CR, etc.); recent submissions |
| `listTrendingRepos` | GitHub trending scrape | Language-filtered; stars/forks; description |

---

### Sanctions Service — `sanctions/v1/`

**`lookupEntity`** — searches 3 consolidated lists:
```
1. UN Consolidated List    (XML feed)
2. OFAC SDN List           (CSV)
3. EU Consolidated List    (XML)

Matching: fuzzy name matching (Levenshtein distance ≤ 2)
Returns: entity type, listing date, grounds, aliases, associated countries
```

**`listSanctionsPressure`** — per-country sanctions exposure score:
```
Score = (# active sanctioned entities with country ties) × weight
Weight: UN=3, OFAC=2, EU=1
Normalized 0–100
```

---

### Intelligence Service — `intelligence/v1/`

**`chatAnalystContext`** — assembles LLM context from Redis:
```
Sources pulled:
  - Daily brief (news insights)
  - Risk scores (per country)
  - Theater posture (regional military)
  - GDELT intel
  - Cross-source signals
  - Market implications

Returns structured context string (≤8000 tokens) for the AI Analyst
```

**`getCompanyEnrichment`** — company data via search fallback chain:
```
1. SerpAPI (SERPAPI_API_KEYS) → Google Knowledge Graph
2. Brave Search (BRAVE_API_KEYS) → web results
3. Exa Search (EXA_API_KEYS) → semantic search
Returns: name, description, sector, HQ, executives, recent news
```

---

### Remaining Services (summary)

| Service | Domain | Key Sources | Key Methods |
|---------|--------|-------------|-------------|
| `maritime/v1/` | Ship tracking | IHO NAVAREA, AIS relay | `listNavigationalWarnings`, `listVesselPositions` |
| `natural/v1/` | Natural disasters | NASA EONET, GDACS | `listNaturalEvents` |
| `news/v1/` | News + summaries | RSS relay, Groq | `summarizeArticle`, `listInsights` |
| `positive-events/v1/` | Good news | Curated RSS feeds | `listPositiveEvents` |
| `prediction/v1/` | Prediction markets | Polymarket, Manifold | `listPredictions` |
| `radiation/v1/` | Radiation monitoring | Safecast, RadiationWatch.org | `listRadiationObservations` |
| `resilience/v1/` | Societal resilience | Multi-source composite | `getResilienceScores` |
| `seismology/v1/` | Earthquakes | USGS, EMSC | `listEarthquakes` |
| `supply-chain/v1/` | Supply chain | Xeneta, manual | `getChokepointStatus`, `getShippingRates`, `listMinerals` |
| `thermal/v1/` | Thermal anomalies | NASA FIRMS + custom | `listThermalEvents` |
| `trade/v1/` | Trade flows | UN COMTRADE, customs | `listTradeFlows`, `getCustomsRevenue` |
| `unrest/v1/` | Civil unrest | ACLED | `listUnrestEvents` |
| `webcam/v1/` | Live webcams | Windy.com, Webcams.travel | `listWebcams`, `getWebcamImage` |
| `imagery/v1/` | Satellite imagery | NASA EOSDIS | `searchImagery` |
| `health/v1/` | Disease + health | WHO, CDC, ECDC | `listDiseaseOutbreaks` |
| `giving/v1/` | Charity giving | GiveWell, charity ratings | `listCharities`, `getImpactMetrics` |
| `consumer-prices/v1/` | Consumer prices | UAE retail, FAO | `getConsumerPrices` |
| `displacement/v1/` | Refugees/IDPs | UNHCR, IDMC | `getDisplacementSummary` |
| `forecast/v1/` | Forecasts | Prediction markets, internal | `listForecasts` |
| `wildfire/v1/` | Active fires | NASA FIRMS | `listFireDetections` |

---

---

## 7. Convex Backend — `convex/`

Convex is the serverless database + real-time backend. All tables are defined in `schema.ts`.

### Database Tables

#### `userPreferences`
```
userId      string  — Clerk user ID
variant     string  — site variant ('full', 'finance', etc.)
data        any     — full serialized panel layout + map state
schemaVersion number
updatedAt   number  (ms epoch)
syncVersion number  — optimistic concurrency

Index: by_user_variant [userId, variant]
```

#### `notificationChannels`
Union type — one row per channel per user:
```
Telegram:  { userId, channelType: 'telegram', chatId, verified, linkedAt }
Slack:     { userId, channelType: 'slack', webhookEnvelope, verified, slackChannelName, slackTeamName }
Email:     { userId, channelType: 'email', email, verified }
Discord:   { userId, channelType: 'discord', webhookEnvelope, verified, discordGuildId, discordChannelId }

Index: by_user, by_user_channel
```

#### `alertRules`
```
userId          string
variant         string
enabled         boolean
eventTypes      string[]  — event category filters
sensitivity     'low' | 'medium' | 'high' | 'critical'
channels        channelType[]
quietHoursEnabled  boolean?
quietHoursStart    number?  (0-23 hour)
quietHoursEnd      number?
quietHoursTimezone string?  (IANA timezone)
quietHoursOverride 'none' | 'urgent_only' | 'all'
digestMode         'realtime' | 'daily' | 'twice_daily'?
digestHour         number?  (0-23, for daily digest send time)
digestTimezone     string?

Indexes: by_user, by_user_variant, by_enabled
```

#### `subscriptions`
```
userId              string
dodoSubscriptionId  string  (Dodo Payments ID)
dodoProductId       string
planKey             string  ('pro', 'enterprise', etc.)
status              'active' | 'on_hold' | 'cancelled' | 'expired'
currentPeriodStart  number (ms epoch)
currentPeriodEnd    number (ms epoch)
cancelledAt         number?
rawPayload          any     (full Dodo webhook payload)
updatedAt           number

Indexes: by_userId, by_dodoSubscriptionId
```

#### `entitlements`
```
userId      string
planKey     string
features:
  tier            number   (1=free, 2=pro, 3=enterprise)
  maxDashboards   number
  apiAccess       boolean
  apiRateLimit    number   (req/min)
  prioritySupport boolean
  exportFormats   string[] (['csv','json','pdf'])
validUntil  number (ms epoch)
updatedAt   number

Index: by_userId
```

#### `telegramPairingTokens`
```
userId    string
token     string  — one-time pairing token
expiresAt number  (10 minute TTL)
used      boolean

Indexes: by_token, by_user
```

---

### Convex Functions

#### `userPreferences.ts`
```
savePreferences(userId, variant, data)
  → Upserts by [userId, variant] index
  → Increments syncVersion for conflict detection

loadPreferences(userId, variant)
  → Returns latest data or null
```

#### `alertRules.ts`
```
upsertAlertRule(userId, variant, ruleData)
createAlertRule(userId, variant, rule)
updateAlertRule(ruleId, updates)
deleteAlertRule(ruleId)
listAlertRules(userId)  — returns all rules for user
getAlertRule(ruleId)
```

#### `notificationChannels.ts`
```
linkTelegramChannel(userId, chatId)  — sets verified=false, triggers bot confirmation
linkSlackChannel(userId, webhookUrl)
linkEmailChannel(userId, email)
linkDiscordChannel(userId, webhookUrl)
verifyChannel(channelId)             — marks verified=true after confirmation
unlinkChannel(channelId)
listChannels(userId)
```

#### `payments/webhookHandlers.ts`
Handles Dodo Payments webhook events:
```
subscription_activated  → create/update subscriptions table, set status='active'
subscription_cancelled  → set status='cancelled', record cancelledAt
subscription_expired    → set status='expired'
payment_succeeded       → insert paymentEvents row
payment_failed          → insert paymentEvents row with status='failed'
dispute_opened          → update paymentEvents status='dispute_opened'
dispute_won/lost/closed → update status accordingly
```
All webhook payloads are verified via `DODO_WEBHOOK_SECRET` HMAC signature.

#### `convex/http.ts` — HTTP Actions
```
POST /api/internal-entitlements
  → Internal sync endpoint; updates entitlements table from subscription status

POST /api/webhook/dodo
  → Verifies HMAC signature
  → Dispatches to appropriate webhookHandler based on event type
  → Idempotent: checks webhookEvents table before processing
```

---

## 8. Scripts & Build Tools — `scripts/`

### Data Processing Scripts

#### `ais-relay.cjs` — AIS WebSocket Relay
**Deploy on Railway.** Full WebSocket server that proxies AIS stream data to browsers.

```
Architecture:
  WebSocket → aisstream.io (wss://stream.aisstream.io/v0/stream)
  HTTP snapshot endpoint → /ais/snapshot (JSON)
  HTTP density endpoint  → /ais/density   (H3 hexagon grid)

Key config (env vars):
  AISSTREAM_API_KEY       — required
  PORT                    — default 3004
  AIS_MAX_VESSELS         — default 20,000
  AIS_MAX_VESSEL_HISTORY  — default 20,000
  AIS_UPSTREAM_QUEUE_HIGH_WATER — default 4,000 messages
  RELAY_SHARED_SECRET     — auth between app and relay
  RELAY_RATE_LIMIT_MAX    — default 1,200 req/min per IP

Memory management:
  MEMORY_CLEANUP_THRESHOLD_GB — default 2.0GB; triggers vessel eviction
  Evicts oldest vessels when memory threshold exceeded
  LRU eviction by last_seen timestamp

Message pipeline:
  aisstream.io WS message
  → parse PositionReport / VoyageData / StaticData
  → update vesselMap (MMSI → VesselState)
  → accumulate history (last N positions per MMSI)
  → snapshot endpoint serves JSON snapshot on HTTP GET
```

#### `_ema-threat-engine.mjs` — Threat Velocity Engine
Pure-function EMA algorithm for conflict data:
```
ALPHA = 0.3  (smoothing factor)

updateWindow(region, count, prior):
  window = [...priorWindow, count].slice(-24)  // keep last 24 data points
  ema = ALPHA × count + (1-ALPHA) × prevEma
  {mean, stddev} = computeWindowStats(window)

computeZScore(window, current):
  if window.length < MIN_WINDOW (6): return 0
  z = (current - mean) / stddev
  capped at ±5

computeEmaWindows(priorWindows, acledEvents, ucdpEvents):
  Group events by country, last 24h
  Update EMA window per region
  Returns Map<region, WindowState>
```

#### `_clustering.mjs` — News Event Clustering
```
SIMILARITY_THRESHOLD = 0.5

tokenize(text):
  Lowercase → strip non-alphanumeric → split → remove stopwords

jaccardSimilarity(setA, setB):
  |intersection| / |union|

Keyword categories:
  MILITARY_KEYWORDS: war, airstrike, missile, troops, etc.
  VIOLENCE_KEYWORDS: killed, casualties, execution, etc.
  UNREST_KEYWORDS:   protest, riot, revolt, coup, etc.
  FLASHPOINT_KEYWORDS: iran, russia, china, taiwan, ukraine, etc.
  CRISIS_KEYWORDS:   emergency, sanctions, escalation, etc.
  DEMOTE_KEYWORDS:   CEO, earnings, startup (reduces military score)

scoreMilitaryRelevance(text):
  military_hits × 3 + violence_hits × 2 + flashpoint_hits × 1 - demote_hits × 2
  Returns 0–100 normalized score
```

#### `build-military-bases-final.mjs` — Military Base Builder
Combines 3 data sources into a single Redis key (`military:bases:active`):
```
1. fetch-mirta-bases.mjs   → MIRTA (Military Installation Recognition and Tracking App)
2. fetch-osm-bases.mjs     → OpenStreetMap military=* landuse areas
3. fetch-pizzint-bases.mjs → Pizzint open-source intelligence

Merge logic:
  Deduplicate by proximity (< 1km → merge, keep highest-confidence record)
  Geocode any missing lat/lon via Nominatim
  Classify: air base, naval base, army base, missile site, radar
  Security level: inferred from name + tags

Output schema:
  { id, name, lat, lon, country, type, classification, source, lastVerified }
```

#### `_prediction-scoring.mjs` — Forecast Scoring
```
Brier score: (forecast_probability - outcome)²
  0 = perfect, 1 = worst

Resolution check:
  Resolved markets → compute Brier score
  Unresolved → skip

Calibration curve:
  Group forecasts by probability decile
  Compare predicted vs actual frequency
```

#### `evaluate-forecast-run.mjs`
Evaluates a batch of prediction market forecasts:
```
1. Load forecast run JSON
2. For each resolved forecast: computeBrierScore()
3. Aggregate: mean Brier, median, by-category breakdown
4. Output calibration report
```

#### `generate-oref-locations.mjs`
Generates Israeli Home Front Command (Oref) alert zone locations:
```
Fetches zone list from Oref API
Geocodes each zone name → lat/lon
Outputs: { zoneId, name, lat, lon, district }
Stored in: src/config/oref-locations.json
```

---

## 9. Tauri Desktop Sidecar — `src-tauri/sidecar/`

### `local-api-server.mjs` — Local API Gateway

This Node.js process runs as a Tauri sidecar alongside the desktop app. It handles all API requests locally instead of going to Vercel.

**Port:** configurable via `LOCAL_API_PORT` (default `46123`)

**Key Logic:**

#### 1. IPv4 Force-Patch
```js
// Monkey-patches globalThis.fetch for ALL dynamically loaded handlers
// Reason: Node.js Happy Eyeballs tries IPv6 first → government APIs
//         (EIA, NASA FIRMS, FRED) have broken AAAA records → ETIMEDOUT
globalThis.fetch = async function ipv4Fetch(input, init) {
  // Resolves hostname, forces { family: 4 } on all HTTP/HTTPS requests
  // Normalizes request body (URLSearchParams, ArrayBuffer, etc.)
}
```

#### 2. Concurrent Request Limiter
```js
MAX_CONCURRENT_UPSTREAM = 6
acquireUpstreamSlot()   → queues if 6 already active
releaseUpstreamSlot()   → drains queue FIFO
```

#### 3. Yahoo Finance Rate Gate
```js
// Shared across ALL loaded handler bundles
MIN_INTER_REQUEST_MS = 600ms
sidecarYahooGate()  → sequential queue; ensures 600ms between Yahoo requests
```

#### 4. SSRF Protection
```js
Blocked IPv4 ranges:
  127.0.0.0/8    (loopback)
  10.0.0.0/8     (private)
  172.16.0.0/12  (private)
  192.168.0.0/16 (private)
  169.254.0.0/16 (link-local)
  0.0.0.0/8      (current network)
  224.0.0.0+     (multicast/reserved)

Blocked IPv6: ::1, fe80::, fc00::, fd00::

Additional checks:
  Protocol must be http: or https:
  No embedded credentials in URL (user:pass@host blocked)
```

#### 5. Handler Dynamic Loading
```js
// Loads api/*.js handler modules at runtime
// Each handler exports: default function handler(req: Request): Promise<Response>
// Modules are cached after first load
// Request routing: /api/{path} → api/{path}.js handler
```

#### 6. Brotli/Gzip Compression
Responses are compressed (Brotli preferred, Gzip fallback) before returning to the Tauri WebView.

**Exposed Environment Variables to Handlers:**
`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `EXA_API_KEYS`, `BRAVE_API_KEYS`, `SERPAPI_API_KEYS`, `FRED_API_KEY`, `EIA_API_KEY`, `CLOUDFLARE_API_TOKEN`, `ACLED_ACCESS_TOKEN`, `URLHAUS_AUTH_KEY`, `OTX_API_KEY`, `ABUSEIPDB_API_KEY`, `WINGBITS_API_KEY`, `WS_RELAY_URL`, `OPENSKY_CLIENT_ID/SECRET`, `AISSTREAM_API_KEY`, `FINNHUB_API_KEY`, `NASA_FIRMS_API_KEY`, `OLLAMA_API_URL/MODEL`, `UCDP_ACCESS_TOKEN`, `AVIATIONSTACK_API`, `ICAO_API_KEY`

---

## 10. Docker & Deployment — `docker/`

### `Dockerfile` — Multi-stage Build
```
Stage 1 (builder): node:22-alpine
  ARG VITE_VARIANT=full
  ARG VITE_WS_API_URL=https://api.worldmonitor.app
  RUN npm ci --include=dev
  RUN npm run build  (TypeScript compile + Vite bundle)

Stage 2 (runtime): nginx:alpine + supervisord
  Copies: dist/ → /usr/share/nginx/html
  Copies: src-tauri/sidecar/local-api-server.mjs → /app/
  ENV API_UPSTREAM (substituted into nginx config at startup)
  Runs: supervisord → manages nginx + node api server
  
Startup: docker/entrypoint.sh
  Reads Docker secrets from /run/secrets/ if present
  Exports LOCAL_API_PORT=46123
  Sets LOCAL_API_MODE=docker
  Launches supervisord
```

### `docker-compose.yml` — Full Stack
```
Services:
  worldmonitor:     port ${WM_PORT:-3000}:8080 — main app
  ais-relay:        internal port 3004 — ship tracking relay
  redis:            docker.io/redis:7-alpine (maxmemory 256mb, allkeys-lru)
  redis-rest:       port 127.0.0.1:8079:80 — Upstash REST proxy (srh)

Networking:
  worldmonitor → redis-rest (UPSTASH_REDIS_REST_URL=http://redis-rest:80)
  worldmonitor → ais-relay  (WS_RELAY_URL=http://ais-relay:3004)
```

### `nginx.conf`
- Serves static `dist/` on port 8080
- `/api/*` → proxy to Node.js sidecar on `LOCAL_API_PORT`
- Gzip + Brotli compression
- `Cache-Control: immutable` for hashed assets (`/assets/`)
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`

---

## 11. Custom Algorithms & Logic

### Correlation Engine — `src/services/correlation-engine/`

Detects multi-domain signal convergence (e.g. military + economic + news all pointing at same region).

```
CorrelationEngine.run(ctx: AppContext):

For each DomainAdapter (military, economic, escalation, disaster):
  1. collectSignals(ctx)      → extract typed signals from ctx
  2. clusterSignals(signals)  → group by proximity/topic
  3. scoreClusters(clusters)  → composite score per cluster
  4. filter(score ≥ threshold)
  5. applyTrends(clusters)    → RISING/FALLING/STABLE vs previous cycle
  6. toCard(cluster)          → ConvergenceCard with evidence list

LLM Assessment (async, non-blocking):
  Threshold: score ≥ 60
  Cache TTL: 30 minutes
  Max concurrent: 3
  Calls IntelligenceService.chatAnalystContext() → Groq narrative

Output: dispatches 'wm:correlation-updated' CustomEvent
```

**Domain Adapters:**
- `militaryAdapter` — flight clusters near naval vessels near conflict zones
- `economicAdapter` — market moves correlated with geopolitical events
- `escalationAdapter` — rapid event-count increase + military movement
- `disasterAdapter` — natural events triggering supply chain or conflict impact

---

### Threat Classification — `src/services/analysis-core.ts`

```
aggregateThreats(items[]):
  THREAT_PRIORITY: critical=5, high=4, medium=3, low=2, info=1
  Select highest threat level from items
  Most common category (mode) across items
  Weighted confidence: weight = (6 - min(tier, 5))
  → { level, category, confidence, source: 'keyword' }
```

### News Deduplication — `src/utils/analysis-constants.ts`

```
jaccardSimilarity(tokensA, tokensB):
  intersection.size / union.size

SIMILARITY_THRESHOLD = 0.5
If similarity ≥ 0.5: articles are duplicates → keep highest-tier source
```

### EMA Threat Velocity — `scripts/_ema-threat-engine.mjs`

Applied to ACLED + UCDP conflict events:
```
Per-country rolling 24-point window
α = 0.3 (EMA smoothing)
Z-score: (current - mean) / stddev, min 6 points to be meaningful
Z > 2.0: "Elevated" — notable surge
Z > 3.0: "Critical" — statistically extreme spike
```

### Temporal Anomaly Detection — `infrastructure/v1/`

```
recordBaselineSnapshot():
  Every 6 hours: store current metric values as baseline

calculateDeviation(current, baseline):
  Per-metric % deviation from rolling average
  Flag as anomaly if |deviation| > threshold

listTemporalAnomalies():
  Returns metrics currently deviating > threshold from baseline
  Includes: direction (up/down), magnitude, affected region/ASN
```

### AI Classification Queue — `src/services/ai-classify-queue.ts`

```
Rate limits by variant:
  full: 80 classifications/minute
  tech: 60/minute
  finance: 40/minute

Dedup: same normalized title → skip for 30 minutes
Per-feed cap: 2–3 items max per feed per cycle

canQueueAiClassification(title):
  1. Prune expired window entries
  2. Prune expired dedup entries
  3. Check rate cap
  4. Check dedup
  → true = classify, false = skip
```

---

## 12. Complete Data Source Map

### Required API Keys

| Env Var | Service | Free Tier | Used By |
|---------|---------|-----------|---------|
| `GROQ_API_KEY` | Groq LLM | 14,400 req/day | AI Analyst, article summarization, event classification |
| `OPENROUTER_API_KEY` | OpenRouter | 50 req/day | LLM fallback |
| `FINNHUB_API_KEY` | Finnhub | 60 req/min | Stock quotes, earnings, sector ETFs |
| `FRED_API_KEY` | FRED (Fed Reserve) | Generous | 80+ economic time series |
| `EIA_API_KEY` | U.S. Energy Info Admin | Free | Crude oil, natural gas inventories, energy prices |
| `NASA_FIRMS_API_KEY` | NASA FIRMS | Free | Satellite fire detections (VIIRS/MODIS) |
| `AISSTREAM_API_KEY` | AIS Stream | Free tier | Real-time vessel tracking |
| `UCDP_ACCESS_TOKEN` | Uppsala Conflict | Free | Armed conflict events |
| `ACLED_ACCESS_TOKEN` | ACLED | Free (academic) | Political violence, protests |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Radar | Free | DDoS data, internet outages, traffic anomalies |
| `WINGBITS_API_KEY` | Wingbits | Paid | Military aircraft tracking |
| `WAQI_API_KEY` | World Air Quality | Free | Air quality indices |
| `OTX_API_KEY` | AlienVault OTX | Free | Threat intelligence IOCs |
| `ABUSEIPDB_API_KEY` | AbuseIPDB | Free | IP reputation |
| `URLHAUS_AUTH_KEY` | URLhaus | Free | Malicious URL feed |
| `AVIATIONSTACK_API` | AviationStack | Free tier | Flight data |
| `BLS_API_KEY` | Bureau of Labor Stats | Free | US employment data |
| `BRAVE_API_KEYS` | Brave Search | Paid | Web search for company enrichment |
| `EXA_API_KEYS` | Exa Search | Paid | Semantic search |
| `SERPAPI_API_KEYS` | SerpAPI | Paid | Google search scraping |
| `DODO_API_KEY` | Dodo Payments | N/A | Billing/subscriptions |
| `UPSTASH_REDIS_REST_URL` + `TOKEN` | Upstash Redis | Free tier | Cross-user cache, rate limiting |

### No-Key (Free/Public) Sources

| Source | Data | Endpoint |
|--------|------|----------|
| Yahoo Finance | Stock, ETF, commodity prices | Public (rate-gated) |
| CoinGecko | Crypto market data | Public API |
| Open-Meteo | Weather data, alerts | Public API |
| NOAA GML | CO2 monitoring | Public API |
| USGS | Earthquake data | public API |
| GDELT | Global event database | Public GCS |
| FAO | Food price indices | Public REST |
| World Bank | Development indicators | Public API |
| ECB | Forex, yield curves | SDMX REST |
| BIS | Policy rates, credit | Public API |
| Eurostat | EU statistics | Public REST |
| NASA EONET | Natural events | Public API |
| GDACS | Disaster alerts | Public XML |
| ReliefWeb | Humanitarian data | Public API |
| Feodo Tracker | C2 botnet IPs | Public JSON |
| C2IntelFeeds | Community C2 list | GitHub raw |
| IHO NAVAREA | Maritime warnings | Public XML |
| Hacker News | Tech news | Algolia API |
| arXiv | Research papers | Public API |
| Polymarket | Prediction markets | Public API |
| Manifold Markets | Prediction markets | Public API |
| Safecast | Radiation data | Public API |
| CISA KEV | Vulnerability catalog | Public JSON |
| NVD | CVE database | Public API |
| GiveWell | Charity effectiveness | Public API |

---

*Documentation generated from full codebase analysis. Branch: `document`. Repository: `chad3456/worldmonitor`.*
