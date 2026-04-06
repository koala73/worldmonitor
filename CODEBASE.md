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
