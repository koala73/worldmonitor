# World Monitor — API Reference

> Comprehensive reference for all Vercel Edge Function endpoints powering the World Monitor intelligence dashboard.

**Base URL**: All endpoints are relative to `/api/` (e.g., `https://worldmonitor.app/api/earthquakes`).

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Overview](#overview)
- [Shared Middleware](#shared-middleware)
  - [`_cors.js`](#_corsjs)
  - [`_cache-telemetry.js`](#_cache-telemetryjs)
  - [`_ip-rate-limit.js`](#_ip-rate-limitjs)
  - [`_upstash-cache.js`](#_upstash-cachejs)
- [Endpoints by Domain](#endpoints-by-domain)
  - [Geopolitical](#geopolitical)
  - [Markets & Finance](#markets--finance)
  - [Military & Security](#military--security)
  - [Natural Events](#natural-events)
  - [AI / ML](#ai--ml)
  - [Infrastructure](#infrastructure)
  - [Humanitarian](#humanitarian)
  - [Content](#content)
  - [Meta](#meta)
  - [Risk & Baseline](#risk--baseline)
  - [Proxy / Passthrough Subdirectories](#proxy--passthrough-subdirectories)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Caching Architecture](#caching-architecture)

---

## Quick Reference

| Method | Path | Auth | Cache TTL | Rate Limit | Domain |
|--------|------|------|-----------|------------|--------|
| `GET` | `/api/acled` | `ACLED_ACCESS_TOKEN` + `ACLED_EMAIL` | 600 s | 10 req/min | Geopolitical |
| `GET` | `/api/acled-conflict` | `ACLED_ACCESS_TOKEN` + `ACLED_EMAIL` | 600 s | 10 req/min | Geopolitical |
| `GET` | `/api/ucdp` | None | 86 400 s (24 h) | — | Geopolitical |
| `GET` | `/api/ucdp-events` | None | 21 600 s (6 h) | 15 req/min | Geopolitical |
| `GET` | `/api/gdelt-doc` | None | CDN 300 s | — | Geopolitical |
| `GET` | `/api/gdelt-geo` | None | CDN 300 s | — | Geopolitical |
| `GET` | `/api/nga-warnings` | None | CDN 3 600 s | — | Geopolitical |
| `POST` | `/api/country-intel` | `GROQ_API_KEY` | 7 200 s (2 h) | — | Geopolitical |
| `GET` | `/api/finnhub` | `FINNHUB_API_KEY` | CDN 60 s | — | Markets |
| `GET` | `/api/yahoo-finance` | None | CDN 60 s | — | Markets |
| `GET` | `/api/coingecko` | None | 120 s | — | Markets |
| `GET` | `/api/stablecoin-markets` | None | In-mem 120 s | — | Markets |
| `GET` | `/api/etf-flows` | `FINNHUB_API_KEY` | In-mem 900 s | — | Markets |
| `GET` | `/api/stock-index` | None | 3 600 s (1 h) | — | Markets |
| `GET` | `/api/fred-data` | `FRED_API_KEY` | 3 600 s | — | Markets |
| `GET` | `/api/macro-signals` | `FRED_API_KEY`, `FINNHUB_API_KEY` | In-mem 300 s | — | Markets |
| `GET` | `/api/polymarket` | None | 300 s | — | Markets |
| `GET` | `/api/opensky` | None | CDN 15 s | — | Military |
| `GET` | `/api/ais-snapshot` | `WS_RELAY_URL` | 3-tier 4–8 s | — | Military |
| `GET` | `/api/theater-posture` | None | 3-tier 5 min–7 d | — | Military |
| `GET` | `/api/cyber-threats` | `ABUSEIPDB_API_KEY` (opt.) | 600 s | 20 req/min | Military |
| `GET` | `/api/earthquakes` | None | CDN 300 s | — | Natural Events |
| `GET` | `/api/firms-fires` | `NASA_FIRMS_API_KEY` | 600 s | — | Natural Events |
| `GET` | `/api/climate-anomalies` | None | 21 600 s (6 h) | 15 req/min | Natural Events |
| `POST` | `/api/classify-batch` | `GROQ_API_KEY` | 86 400 s (24 h) | — | AI / ML |
| `GET` | `/api/classify-event` | `GROQ_API_KEY` | 86 400 s (24 h) | — | AI / ML |
| `POST` | `/api/groq-summarize` | `GROQ_API_KEY` | 3 600 s | — | AI / ML |
| `POST` | `/api/openrouter-summarize` | `OPENROUTER_API_KEY` | 3 600 s | — | AI / ML |
| `GET` | `/api/cloudflare-outages` | `CLOUDFLARE_API_TOKEN` | 600 s | — | Infrastructure |
| `GET` | `/api/service-status` | None | In-mem 60 s | — | Infrastructure |
| `GET` | `/api/faa-status` | None | CDN 300 s | — | Infrastructure |
| `GET` | `/api/unhcr-population` | None | 86 400 s (24 h) | 20 req/min | Humanitarian |
| `GET` | `/api/hapi` | `HDX_APP_IDENTIFIER` (opt.) | 21 600 s (6 h) | — | Humanitarian |
| `GET` | `/api/worldpop-exposure` | None | 604 800 s (7 d) | 30 req/min | Humanitarian |
| `GET` | `/api/worldbank` | None | 86 400 s (24 h) | — | Humanitarian |
| `GET` | `/api/rss-proxy` | None | CDN 300 s | — | Content |
| `GET` | `/api/hackernews` | None | CDN 300 s | — | Content |
| `GET` | `/api/github-trending` | `GITHUB_TOKEN` (opt.) | 3 600 s | — | Content |
| `GET` | `/api/tech-events` | None | 21 600 s (6 h) | — | Content |
| `GET` | `/api/arxiv` | None | CDN 3 600 s | — | Content |
| `GET` | `/api/version` | `GITHUB_TOKEN` (opt.) | CDN 600 s | — | Meta |
| `GET` | `/api/cache-telemetry` | None | `no-store` | — | Meta |
| `GET` | `/api/debug-env` | None | — | — | Meta |
| `GET` | `/api/download` | None | — | — | Meta |
| `GET` | `/api/og-story` | None | — | — | Meta |
| `GET` | `/api/story` | None | — | — | Meta |
| `GET` | `/api/risk-scores` | None | 600 s | — | Risk |
| `GET/POST` | `/api/temporal-baseline` | None | 7 776 000 s (90 d) | — | Risk |
| `GET` | `/api/eia/*` | `EIA_API_KEY` | CDN 3 600 s | — | Proxy |
| `GET` | `/api/pizzint/*` | None | CDN 120 s | — | Proxy |
| `GET` | `/api/wingbits/*` | `WINGBITS_API_KEY` | CDN 15–300 s | — | Proxy |
| `GET` | `/api/youtube/*` | None | — | — | Proxy |

---

## Overview

World Monitor exposes **60+ serverless endpoints** deployed as **Vercel Edge Functions** (unless noted otherwise). Every endpoint:

1. Applies **CORS middleware** — only whitelisted origins may call the API.
2. Optionally applies **IP-based rate limiting** via a sliding-window algorithm.
3. Leverages a **multi-tier caching** strategy: CDN edge (`Cache-Control` + `s-maxage`), Upstash Redis, and in-memory Maps.
4. Returns **JSON** with consistent error envelopes (see [Error Handling](#error-handling)).

### Common Response Headers

```
Access-Control-Allow-Origin: <origin>
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Cache-Control: public, s-maxage=<TTL>, stale-while-revalidate=<TTL*2>
Content-Type: application/json; charset=utf-8
```

### Common Patterns

- **OPTIONS pre-flight**: Every endpoint responds to `OPTIONS` with 204 + CORS headers.
- **Graceful degradation**: When credentials are missing, most endpoints return `{ success: true, data: [] }` or `{ unavailable: true }` instead of erroring.
- **Query hashing**: Composite cache keys use `hashString()` from `_upstash-cache.js` to generate deterministic hashes of query parameters.

---

## Shared Middleware

All middleware modules live in the `api/` directory, prefixed with `_` to prevent Vercel from deploying them as standalone routes.

---

### `_cors.js`

Cross-origin request gating applied to every endpoint.

#### Allowed Origin Patterns

Eight regex patterns control access:

| # | Pattern | Matches |
|---|---------|---------|
| 1 | `worldmonitor\.app$` | `https://worldmonitor.app` |
| 2 | `\.worldmonitor\.app$` | `https://*.worldmonitor.app` |
| 3 | `\.vercel\.app$` | Vercel preview deploys |
| 4 | `localhost(:\d+)?$` | `http://localhost:*` |
| 5 | `127\.0\.0\.1(:\d+)?$` | IPv4 loopback |
| 6 | `\[::1\](:\d+)?$` | IPv6 loopback |
| 7 | `tauri://localhost` | Tauri desktop shell |
| 8 | `https://tauri\.localhost` | Tauri (alternative scheme) |

#### Exports

```typescript
/** Returns CORS headers object for the given request and allowed methods. */
function getCorsHeaders(
  req: Request,
  methods?: string   // default "GET, OPTIONS"
): Record<string, string>;

/** Returns true if the request origin is NOT on the allowlist. */
function isDisallowedOrigin(req: Request): boolean;
```

#### Behaviour

- `getCorsHeaders` reflects the request `Origin` back in `Access-Control-Allow-Origin` if it matches any pattern; otherwise the header is omitted.
- `isDisallowedOrigin` returns `true` for origins matching none of the 8 patterns. Endpoints can use this to short-circuit with 403.

---

### `_cache-telemetry.js`

Per-instance, in-memory cache telemetry recorder used to track HIT/MISS/STALE ratios per endpoint.

#### Exports

```typescript
/** Record a cache outcome for a named endpoint. */
function recordCacheTelemetry(
  endpoint: string,
  outcome: "HIT" | "MISS" | "STALE"
): void;

/** Return the current telemetry snapshot. */
function getCacheTelemetrySnapshot(): Record<string, {
  hit: number;
  miss: number;
  stale: number;
  total: number;
  hitRate: number;   // 0–1 float
}>;
```

#### Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_ENDPOINTS` | `128` | Max distinct endpoint keys tracked before oldest is evicted |
| `LOG_EVERY` | `50` | Console-log telemetry summary every N recordings |

---

### `_ip-rate-limit.js`

Sliding-window IP rate limiter with LRU cleanup, used by endpoints that call expensive or quota-limited upstream APIs.

#### Factory

```typescript
function createIpRateLimiter(opts?: {
  limit?: number;              // default 60
  windowMs?: number;           // default 60_000 (1 min)
  maxEntries?: number;         // default 10_000
  cleanupIntervalMs?: number;  // default 300_000 (5 min)
}): {
  check(ip: string): { allowed: boolean; retryAfter?: number };
  size(): number;
};
```

#### Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | `60` | Max requests per window |
| `windowMs` | `60 000` | Sliding window duration (ms) |
| `maxEntries` | `10 000` | Max tracked IPs before LRU eviction |
| `cleanupIntervalMs` | `300 000` | Interval for stale-entry cleanup (ms) |

#### Behaviour

- When `check(ip)` returns `{ allowed: false }`, the endpoint responds with **429 Too Many Requests** and the `Retry-After` header set to the number of seconds until the window resets.
- LRU eviction ensures memory stays bounded on long-lived Edge instances.

---

### `_upstash-cache.js`

Dual-mode distributed cache — Upstash Redis in production, in-memory `Map` with disk persistence in sidecar/local mode.

#### Mode Selection

| Env Var | Mode | Backend |
|---------|------|---------|
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set | **Cloud** | Upstash Redis REST API |
| `SIDECAR=true` | **Sidecar** | In-memory `Map` + disk persist to `./data/upstash-cache.json` |

#### Exports

```typescript
/** Retrieve cached JSON by key. Returns null on miss. */
async function getCachedJson<T = unknown>(key: string): Promise<T | null>;

/** Store JSON with a TTL in seconds. */
async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;

/** Batch-get multiple keys. Returns array in same order (null for misses). */
async function mget<T = unknown>(...keys: string[]): Promise<(T | null)[]>;

/** Deterministic hash for building cache keys. */
function hashString(str: string): string;
```

#### Sidecar Mode Details

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_PERSIST_ENTRIES` | `5 000` | Max entries persisted to disk |
| Persist path | `./data/upstash-cache.json` | Location of disk snapshot |

In sidecar mode, entries are evicted LRU-style when the Map exceeds `MAX_PERSIST_ENTRIES`.  
The disk snapshot is read on cold start and written periodically.

---

## Endpoints by Domain

---

### Geopolitical

Eight endpoints covering armed conflict, protest tracking, news intelligence, and maritime warnings.

---

#### `GET /api/acled`

ACLED protest and political violence events.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `country` | `string` | — | ISO country name filter (optional) |
| `limit` | `number` | `500` | Max events to return |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `ACLED_ACCESS_TOKEN` | Yes | `https://api.acleddata.com/acled/read` |
| `ACLED_EMAIL` | Yes | — |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| CDN | `s-maxage=600` | — |
| Upstash | 600 s | `acled:{query_hash}` |

**Rate Limit**: 10 req/min via `createIpRateLimiter`

**Response**

```typescript
interface AcledResponse {
  success: true;
  data: AcledEvent[];
}

interface AcledEvent {
  event_id_cnty: string;
  event_date: string;        // "YYYY-MM-DD"
  event_type: string;
  sub_event_type: string;
  actor1: string;
  country: string;
  latitude: number;
  longitude: number;
  fatalities: number;
  notes: string;
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `429` | IP rate limit exceeded |
| `500` | Upstream ACLED API failure |
| `503` | Missing credentials — returns `{ success: true, data: [] }` gracefully |

---

#### `GET /api/acled-conflict`

ACLED conflict-specific events: battles, violence against civilians, explosions/remote violence.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `country` | `string` | — | ISO country name filter (optional) |
| `limit` | `number` | `500` | Max events to return |
| `days` | `number` | `30` | Lookback window in days |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `ACLED_ACCESS_TOKEN` | Yes | `https://api.acleddata.com/acled/read` (with `event_type` filter) |
| `ACLED_EMAIL` | Yes | — |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| CDN | `s-maxage=600` | — |
| Upstash | 600 s | `acled-conflict:{query_hash}` |

**Rate Limit**: 10 req/min

**Response**: Same shape as [`/api/acled`](#get-apiacled).

---

#### `GET /api/ucdp`

UCDP conflict catalog (paginated).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | `number` | `1` | Page number |
| `pagesize` | `number` | `100` | Items per page |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://ucdpapi.pcr.uu.se/api/` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 86 400 s (24 h) | `ucdp:{page}:{pagesize}` |

**Response**

```typescript
interface UcdpCatalogResponse {
  Result: UcdpConflict[];
  TotalCount: number;
  NextPageUrl: string | null;
  PreviousPageUrl: string | null;
}
```

---

#### `GET /api/ucdp-events`

UCDP georeferenced events with automatic version discovery.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `pagesize` | `number` | `1000` | Items per page |
| `page` | `number` | `1` | Page number |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://ucdpapi.pcr.uu.se/api/gedevents/` |

The endpoint auto-discovers the current-year version of the UCDP GED dataset.

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 21 600 s (6 h) | `ucdp-events:{version}:{page}:{pagesize}` |

**Rate Limit**: 15 req/min

**Response**

```typescript
interface UcdpEventsResponse {
  Result: UcdpGeoEvent[];
}

interface UcdpGeoEvent {
  id: number;
  type_of_violence: number;   // 1=state, 2=non-state, 3=one-sided
  country: string;
  latitude: number;
  longitude: number;
  date_start: string;
  date_end: string;
  deaths_a: number;
  deaths_b: number;
  deaths_civilians: number;
  best: number;               // best estimate of total fatalities
}
```

---

#### `GET /api/gdelt-doc`

GDELT article search.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | **(required)** | Search query |
| `mode` | `string` | `"ArtList"` | GDELT query mode |
| `maxrecords` | `number` | `75` | Max articles |
| `timespan` | `string` | `"2d"` | Lookback window |
| `format` | `string` | `"json"` | Response format |
| `sourcelang` | `string` | — | Language filter (optional) |
| `domain` | `string` | — | Domain filter (optional) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://api.gdeltproject.org/api/v2/doc/doc` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |
| Upstash | — (not cached) |

**Response**: Passthrough JSON from GDELT API.

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `query` parameter |
| `502` | Upstream GDELT failure |

---

#### `GET /api/gdelt-geo`

GDELT geographic data.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | **(required)** | Search query |
| `format` | `string` | — | `GeoJSON`, `JSON`, or `CSV` |
| `timespan` | `string` | — | Lookback window |
| `mode` | `string` | — | GDELT geo mode |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://api.gdeltproject.org/api/v2/geo/geo` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |

**Validation**: Strict input validation on all parameters; malformed values are rejected.

**Response**: GeoJSON `FeatureCollection` (when `format=GeoJSON`) or raw JSON/CSV passthrough.

---

#### `GET /api/nga-warnings`

NGA maritime warnings.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://msi.gs.mil/api/publications/broadcast-warn` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=3600` |

**Response**: Pure passthrough proxy — whatever the NGA API returns is forwarded as-is.

---

#### `POST /api/country-intel`

AI-generated country intelligence brief via Groq LLM.

**Request Body** (max 50 KB)

```typescript
interface CountryIntelRequest {
  country: string;       // required — country name or ISO code
  context?: object;      // optional additional context for the LLM
}
```

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `GROQ_API_KEY` | Yes | Groq API (llama3 model) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 7 200 s (2 h) | `country-intel:{country_hash}` |

**Response**

```typescript
interface CountryIntelResponse {
  brief: string;   // markdown-formatted intelligence brief
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `country` in request body |
| `413` | Payload exceeds 50 KB |
| `500` | LLM processing failure |

---

### Markets & Finance

Nine endpoints covering equities, crypto, macro signals, and prediction markets.

---

#### `GET /api/finnhub`

Batch stock quotes (max 20 symbols per request).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `symbols` | `string` | **(required)** | Comma-separated ticker symbols (max 20) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `FINNHUB_API_KEY` | Yes | `https://finnhub.io/api/v1/quote` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=60` |

**Response**

```typescript
interface FinnhubResponse {
  [symbol: string]: {
    c: number;    // current price
    d: number;    // change (delta)
    dp: number;   // percent change (delta %)
    h: number;    // high of the day
    l: number;    // low of the day
    o: number;    // open price
    pc: number;   // previous close
    t: number;    // timestamp (unix)
  };
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `symbols` or more than 20 symbols |
| `502` | Upstream Finnhub failure |

---

#### `GET /api/yahoo-finance`

Single-symbol chart data from Yahoo Finance.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `symbol` | `string` | **(required)** | Ticker symbol |
| `range` | `string` | `"1d"` | Time range (1d, 5d, 1mo, 3mo, 6mo, 1y, 5y, max) |
| `interval` | `string` | `"5m"` | Data interval (1m, 5m, 15m, 1d, 1wk, 1mo) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://query1.finance.yahoo.com/v8/finance/chart/` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=60` |

**Response**: Passthrough chart data with OHLCV (open, high, low, close, volume) arrays.

---

#### `GET /api/coingecko`

Cryptocurrency prices and market data from CoinGecko (free tier).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `vs_currency` | `string` | `"usd"` | Fiat currency for prices |
| `ids` | `string` | — | Comma-separated CoinGecko coin IDs (optional) |
| `per_page` | `number` | `50` | Results per page |
| `sparkline` | `boolean` | `true` | Include 7-day sparkline data |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://api.coingecko.com/api/v3/coins/markets` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 120 s | `coingecko:{hash}` |

**Response**

```typescript
type CoinGeckoResponse = CoinGeckoMarket[];

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
  // ...additional CoinGecko fields
}
```

---

#### `GET /api/stablecoin-markets`

Stablecoin health monitoring and depeg detection.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | CoinGecko (specific stablecoin IDs: `tether`, `usd-coin`, `dai`, `frax`, `trueusd`, etc.) |

**Caching**

| Layer | TTL |
|-------|-----|
| In-memory | 120 s |

**Response**

```typescript
interface StablecoinMarketsResponse {
  coins: StablecoinData[];
  timestamp: number;
  unavailable?: boolean;     // true when upstream is unreachable
}

interface StablecoinData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  peg_deviation: number;     // deviation from $1.00
  price_change_24h: number;
  high_24h: number;
  low_24h: number;
  market_cap: number;
}
```

---

#### `GET /api/etf-flows`

Bitcoin spot ETF flow estimation across 10 major ETFs.

**Tracked ETFs**: `IBIT`, `FBTC`, `GBTC`, `ARKB`, `BITB`, `HODL`, `BRRR`, `EZBC`, `BTCW`, `BTCO`

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `FINNHUB_API_KEY` | Yes | Finnhub (volume-based flow estimation) |

**Caching**

| Layer | TTL |
|-------|-----|
| In-memory | 900 s (15 min) |

**Response**

```typescript
interface ETFFlowsResponse {
  etfs: ETFFlow[];
  totalNetFlow: number;
  timestamp: number;
  unavailable?: boolean;
}

interface ETFFlow {
  symbol: string;
  name: string;
  volume: number;
  estimatedFlow: number;
  price: number;
}
```

---

#### `GET /api/stock-index`

Country-level stock indices for 42 countries.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `symbols` | `string` | All 42 | Comma-separated index symbols (optional) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | Yahoo Finance (batch) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 3 600 s (1 h) | `stock-index:{hash}` |

**Response**

```typescript
interface StockIndexResponse {
  indices: StockIndex[];
  timestamp: number;
}

interface StockIndex {
  symbol: string;
  name: string;
  country: string;
  price: number;
  change: number;
  changePercent: number;
}
```

---

#### `GET /api/fred-data`

FRED (Federal Reserve Economic Data) series observations.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `series_id` | `string` | **(required)** | FRED series ID (e.g., `DGS10`, `UNRATE`) |
| `limit` | `number` | `10` | Max observations |
| `sort_order` | `string` | `"desc"` | Sort order (`asc` or `desc`) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `FRED_API_KEY` | Yes | `https://api.stlouisfed.org/fred/series/observations` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 3 600 s (1 h) | `fred:{series_id}:{limit}` |

**Response**

```typescript
interface FredDataResponse {
  observations: FredObservation[];
}

interface FredObservation {
  date: string;     // "YYYY-MM-DD"
  value: string;    // numeric string
}
```

---

#### `GET /api/macro-signals`

Six-source macro signal aggregation producing a BUY/CASH investment verdict.

**Auth & External API**

| Env Var | Required | Upstream URLs |
|---------|----------|---------------|
| `FRED_API_KEY` | Yes | FRED API |
| `FINNHUB_API_KEY` | Yes (partial) | Finnhub |
| — | — | CoinGecko, alternative.me (Fear & Greed), blockchain.info |

**Caching**

| Layer | TTL |
|-------|-----|
| In-memory | 300 s (5 min) |

**Response**

```typescript
interface MacroSignalsResponse {
  verdict: "BUY" | "CASH";
  confidence: number;          // 0–1
  signals: MacroSignal[];
  timestamp: number;
  unavailable?: boolean;
}

interface MacroSignal {
  name: string;
  // One of: liquidity, flowStructure, macroRegime,
  //         technicalTrend, hashRate, miningCost, fearGreed
  value: number;
  signal: "BUY" | "CASH" | "NEUTRAL";
  weight: number;
  source: string;
}
```

---

#### `GET /api/polymarket`

Prediction markets from Polymarket's Gamma API.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | `number` | `20` | Max markets to return |
| `active` | `boolean` | `true` | Only return active markets |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://gamma-api.polymarket.com/markets` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| CDN | `s-maxage=300` | — |
| Upstash | 300 s | Polymarket cache key |

**Response**

```typescript
type PolymarketResponse = PredictionMarket[];

interface PredictionMarket {
  id: string;
  question: string;
  outcomePrices: string[];    // array of price strings
  volume: number;
  endDate: string;
  active: boolean;
}
```

---

### Military & Security

Four endpoints covering aviation tracking, vessel tracking, theater readiness, and cyber threat intelligence.

---

#### `GET /api/opensky`

Real-time aircraft flight states within a geographic bounding box.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lamin` | `number` | **(required)** | Latitude min (south) |
| `lomin` | `number` | **(required)** | Longitude min (west) |
| `lamax` | `number` | **(required)** | Latitude max (north) |
| `lomax` | `number` | **(required)** | Longitude max (east) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://opensky-network.org/api/states/all` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=15` |

**Response**

```typescript
interface OpenSkyResponse {
  time: number;
  states: FlightState[][];
}

// FlightState tuple indices:
// [0]  icao24          string   – ICAO 24-bit address
// [1]  callsign        string   – callsign (trimmed)
// [2]  origin_country  string
// [3]  time_position   number   – unix timestamp
// [4]  last_contact    number   – unix timestamp
// [5]  longitude       number
// [6]  latitude        number
// [7]  baro_altitude   number   – barometric altitude (m)
// [8]  on_ground       boolean
// [9]  velocity        number   – m/s
// [10] true_track       number   – heading (degrees)
// [11] vertical_rate   number   – m/s
// [12] sensors         number[]
// [13] geo_altitude    number   – geometric altitude (m)
// [14] squawk          string
// [15] spi             boolean  – special purpose indicator
// [16] position_source number   – 0=ADS-B, 1=ASTERIX, 2=MLAT
```

---

#### `GET /api/ais-snapshot`

AIS vessel data from custom WebSocket relay.

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `WS_RELAY_URL` | Yes | Custom WebSocket relay (configurable) |

**Caching** — 3-tier

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=8` |
| Upstash | 8 s |
| In-memory | 4 s |

**Response**

```typescript
interface AISSnapshotResponse {
  vessels: AISVessel[];
  timestamp: number;
  count: number;
}

interface AISVessel {
  mmsi: number;
  name?: string;
  lat: number;
  lon: number;
  cog: number;       // course over ground
  sog: number;       // speed over ground (knots)
  heading?: number;
  shipType?: number;
  destination?: string;
  timestamp: number;
}
```

---

#### `GET /api/theater-posture`

Nine-theater military posture analysis combining aviation and Wingbits data.

**Auth & External API**

| Env Var | Required | Upstream URLs |
|---------|----------|---------------|
| — | — | OpenSky Network, Wingbits API |

**Caching** — 3-tier Upstash with graduated TTLs

| Key | TTL | Purpose |
|-----|-----|---------|
| `theater-posture:fresh` | 300 s (5 min) | Hot data |
| `theater-posture:warm` | 86 400 s (24 h) | Warm fallback |
| `theater-posture:cold` | 604 800 s (7 d) | Cold fallback |

No per-request rate limit — the endpoint is aggressively cached.

**Response**

```typescript
interface TheaterPostureResponse {
  theaters: TheaterPosture[];
  globalReadiness: number;     // 0–1 composite score
  timestamp: number;
}

interface TheaterPosture {
  region: string;              // e.g., "EUCOM", "INDOPACOM"
  alertLevel: string;          // "LOW" | "ELEVATED" | "HIGH" | "CRITICAL"
  flightActivity: number;
  assessment: string;          // human-readable assessment
}
```

---

#### `GET /api/cyber-threats`

Five-source cyber threat intelligence aggregation with geolocation hydration.

**Auth & External API**

| Env Var | Required | Upstream URLs |
|---------|----------|---------------|
| `ABUSEIPDB_API_KEY` | Optional | AbuseIPDB |
| — | — | Feodo Tracker, URLhaus, C2IntelFeeds, AlienVault OTX |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 600 s (10 min) | `cyber-threats:v2` |

**Rate Limit**: 20 req/min

**Response**

```typescript
interface CyberThreatsResponse {
  threats: CyberThreat[];
  sources: string[];
  timestamp: number;
}

interface CyberThreat {
  ip: string;
  type: string;           // "botnet" | "c2" | "malware" | "scanner" | ...
  source: string;         // originating feed
  country: string;
  latitude: number;
  longitude: number;
  confidence: number;     // 0–100
  tags: string[];
}
```

---

### Natural Events

Three endpoints for seismology, active fires, and climate anomaly data.

---

#### `GET /api/earthquakes`

USGS earthquakes M4.5+ for the past week (GeoJSON).

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |

**Response**: Standard USGS GeoJSON `FeatureCollection`.

```typescript
interface EarthquakeFeature {
  type: "Feature";
  properties: {
    mag: number;
    place: string;
    time: number;          // unix ms
    url: string;
    tsunami: number;       // 0 or 1
    type: string;
  };
  geometry: {
    type: "Point";
    coordinates: [number, number, number];  // [lon, lat, depth_km]
  };
}
```

---

#### `GET /api/firms-fires`

NASA FIRMS satellite fire detections across 9 global regions.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `region` | `string` | All 9 regions | Specific region filter (optional) |
| `days` | `number` | `1` | Lookback in days |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `NASA_FIRMS_API_KEY` | Yes | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 600 s | Per-region key |

**Response**

```typescript
interface FIRMSResponse {
  fires: FIRMSFire[];
  count: number;
  regions: string[];
}

interface FIRMSFire {
  latitude: number;
  longitude: number;
  brightness: number;
  frp: number;              // fire radiative power (MW)
  confidence: string;       // "low" | "nominal" | "high"
  acq_date: string;         // "YYYY-MM-DD"
  acq_time: string;         // "HHMM" UTC
  satellite: string;        // "MODIS" | "VIIRS" | ...
}
```

---

#### `GET /api/climate-anomalies`

Temperature and precipitation anomalies for 15 global climate zones.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | NOAA Climate Monitoring |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 21 600 s (6 h) | `climate-anomalies:v1` |

**Rate Limit**: 15 req/min

**Response**

```typescript
interface ClimateAnomaliesResponse {
  zones: ClimateZone[];
  globalAnomaly: number;
  timestamp: number;
}

interface ClimateZone {
  name: string;
  tempAnomaly: number;       // °C above/below baseline
  precipAnomaly: number;     // mm above/below baseline
  severity: string;          // "normal" | "moderate" | "severe" | "extreme"
}
```

---

### AI / ML

Four endpoints for LLM-powered classification and summarization.

---

#### `POST /api/classify-batch`

Batch threat/event classification (max 20 items per request).

**Request Body**

```typescript
interface ClassifyBatchRequest {
  items: ClassifyItem[];     // max 20
}

interface ClassifyItem {
  title: string;
  description?: string;
}
```

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `GROQ_API_KEY` | Yes | Groq (llama3) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 86 400 s (24 h) | Per-item hash |

**Response**

```typescript
interface ClassifyBatchResponse {
  results: Classification[];
}

interface Classification {
  category: string;
  severity: string;         // "low" | "medium" | "high" | "critical"
  confidence: number;       // 0–1
  tags: string[];
}
```

---

#### `GET /api/classify-event`

Single event classification.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | `string` | **(required)** | Event title |
| `description` | `string` | — | Event description (optional) |

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `GROQ_API_KEY` | Yes | Groq (llama3) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 86 400 s (24 h) | `classify:{hash}` |

**Response**

```typescript
interface ClassifyEventResponse {
  category: string;
  severity: string;
  confidence: number;
  tags: string[];
}
```

---

#### `POST /api/groq-summarize`

News article summarization via Groq LLM (primary).

**Request Body** (max 50 KB)

```typescript
interface SummarizeRequest {
  text: string;          // article text to summarize
  type?: string;         // content type hint
  panelId?: string;      // originating panel identifier
}
```

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `GROQ_API_KEY` | Yes | Groq API |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 3 600 s (1 h) | `summary:{hash}` (shared with `openrouter-summarize`) |

> **Note**: The cache key is shared with `/api/openrouter-summarize` — a summary cached by one endpoint is served by the other.

**Response**

```typescript
interface SummarizeResponse {
  summary: string;
}
```

---

#### `POST /api/openrouter-summarize`

Fallback summarization via free-tier OpenRouter models.

**Request Body**: Same as [`/api/groq-summarize`](#post-apigroq-summarize) (max 50 KB).

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter (free-tier models) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 3 600 s (1 h) | `summary:{hash}` (shared with `groq-summarize`) |

**Response**: Same as [`/api/groq-summarize`](#post-apigroq-summarize).

---

### Infrastructure

Three endpoints for monitoring internet outages, service health, and airspace status.

---

#### `GET /api/cloudflare-outages`

Cloudflare Radar internet outage annotations.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `CLOUDFLARE_API_TOKEN` | Yes | `https://api.cloudflare.com/client/v4/radar/annotations/outages` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=600` |
| Upstash | 600 s |

**Response**

```typescript
interface CloudflareOutagesResponse {
  outages: CloudflareOutage[];
  count: number;
}

interface CloudflareOutage {
  id: string;
  name: string;
  scope: string;
  asns: number[];
  locations: string[];
  startDate: string;
  endDate?: string;
  eventType: string;
}
```

---

#### `GET /api/service-status`

Aggregated operational status of 33 major internet services.

**Auth & External API**

| Env Var | Required | Upstream URLs |
|---------|----------|---------------|
| — | — | 33 public status pages (`*.statuspage.io`, `status.*`) |

**Monitored Services** (selection): GitHub, Cloudflare, AWS, Stripe, Vercel, Datadog, PagerDuty, Twilio, Heroku, Atlassian, npm, PyPI, and more.

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=60` |
| In-memory | 60 s |

**Response**

```typescript
interface ServiceStatusResponse {
  services: ServiceStatus[];
}

interface ServiceStatus {
  name: string;
  status: "operational" | "degraded" | "major" | "critical";
  url: string;
  indicator: string;
}
```

---

#### `GET /api/faa-status`

FAA National Airspace System status.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://soa.smext.faa.gov/asws/api/airport/status` (XML) |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |

**Response**: XML-to-JSON passthrough of FAA airport status data.

---

### Humanitarian

Four endpoints covering refugee displacement, conflict events, population exposure, and development indicators.

---

#### `GET /api/unhcr-population`

UNHCR displacement data (paginated).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `year` | `number` | — | Filter by year (optional) |
| `limit` | `number` | `100` | Results per page |
| `page` | `number` | `1` | Page number |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://api.unhcr.org/population/v1/` |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 86 400 s (24 h) | `unhcr:{hash}` |

**Rate Limit**: 20 req/min

**Response**

```typescript
interface UNHCRResponse {
  items: DisplacementRecord[];
  pagination: {
    page: number;
    pages: number;
    total: number;
  };
}

interface DisplacementRecord {
  year: number;
  country_of_origin: string;
  country_of_asylum: string;
  refugees: number;
  asylum_seekers: number;
  internally_displaced: number;
  stateless: number;
}
```

---

#### `GET /api/hapi`

HDX HAPI (Humanitarian API) conflict events.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | `number` | `1000` | Max events to return |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `HDX_APP_IDENTIFIER` | Optional | `https://hapi.humdata.org/api/v2/coordination/conflict-event` |

**Caching**

| Layer | TTL |
|-------|-----|
| Upstash | 21 600 s (6 h) |

**Response**

```typescript
interface HapiResponse {
  data: HapiConflictEvent[];
}

interface HapiConflictEvent {
  event_type: string;
  admin1: string;
  admin2: string;
  location_name: string;
  country: string;
  date: string;
  fatalities: number;
  latitude: number;
  longitude: number;
}
```

---

#### `GET /api/worldpop-exposure`

Population exposure analysis for conflict zones, earthquakes, floods, and fires.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `country` | `string` | **(required)** | ISO 3166-1 alpha-3 code |
| `mode` | `string` | **(required)** | Analysis mode: `conflict`, `earthquake`, `flood`, or `fire` |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | WorldPop (raster data) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 604 800 s (7 d) | `worldpop:{country}:{mode}` |

**Rate Limit**: 30 req/min

**Response**

```typescript
interface PopulationExposure {
  country: string;
  mode: "conflict" | "earthquake" | "flood" | "fire";
  exposedPopulation: number;
  totalPopulation: number;
  percentage: number;         // 0–100
}
```

---

#### `GET /api/worldbank`

World Bank development indicators for 47 countries.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `indicator` | `string` | **(required)** | World Bank indicator code (e.g., `NY.GDP.MKTP.CD`) |
| `country` | `string` | All 47 | ISO country code filter (optional) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://api.worldbank.org/v2/` |

**Caching**

| Layer | TTL |
|-------|-----|
| Upstash | 86 400 s (24 h) |

**Response**

```typescript
interface WorldBankResponse {
  data: WorldBankIndicator[];
}

interface WorldBankIndicator {
  country: { id: string; value: string };
  date: string;
  value: number | null;
  indicator: { id: string; value: string };
}
```

---

### Content

Five endpoints for news feeds, trending repositories, tech events, and research papers.

---

#### `GET /api/rss-proxy`

RSS/Atom feed proxy with a domain allowlist (~150 domains).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | **(required)** | Full RSS/Atom feed URL |

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| — | — | The URL provided (if domain is on allowlist) |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |

**Security**

- ~150 allowed domains hardcoded in the endpoint
- Requests to non-allowed domains are rejected with **403**
- 12-second fetch timeout

**Response**: Raw RSS/Atom XML passthrough with appropriate `Content-Type`.

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400` | Missing `url` parameter |
| `403` | Domain not on allowlist |
| `504` | Upstream fetch timeout (> 12 s) |

---

#### `GET /api/hackernews`

Hacker News stories feed.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `string` | `"top"` | Feed type: `top`, `new`, `best`, `ask`, `show`, `job` |
| `limit` | `number` | `30` | Max stories to return |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://hacker-news.firebaseio.com/v0/` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=300` |

**Response**

```typescript
type HackerNewsResponse = HNStory[];

interface HNStory {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  time: number;            // unix timestamp
  descendants: number;     // comment count
}
```

---

#### `GET /api/github-trending`

GitHub trending repositories.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | `string` | `"daily"` | Time window: `daily`, `weekly`, `monthly` |
| `language` | `string` | — | Programming language filter (optional) |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `GITHUB_TOKEN` | Optional (higher rate limits) | GitHub API v3 (`search/repositories`) + HTML scrape fallback |

**Caching**

| Layer | TTL |
|-------|-----|
| Upstash | 3 600 s (1 h) |

**Response**

```typescript
type GitHubTrendingResponse = TrendingRepo[];

interface TrendingRepo {
  name: string;
  owner: string;
  description: string;
  stars: number;
  forks: number;
  language: string | null;
  todayStars: number;
  url: string;
}
```

---

#### `GET /api/tech-events`

Tech conferences and events with automated geocoding.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `days` | `number` | `90` | Forward-looking window in days |
| `limit` | `number` | `50` | Max events to return |

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| — | — | Scraped from tech event sources |

**Caching**

| Layer | TTL |
|-------|-----|
| Upstash | 21 600 s (6 h) |

**Response**

```typescript
type TechEventsResponse = TechEvent[];

interface TechEvent {
  name: string;
  date: string;
  location: string;
  lat: number;
  lng: number;
  category: string;
  url: string;
}
```

> **Note**: The endpoint includes a 500+ city geocoding lookup table for resolving event locations to coordinates.

---

#### `GET /api/arxiv`

ArXiv research paper search (XML passthrough).

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search_query` | `string` | **(required)** | ArXiv query string |
| `max_results` | `number` | `10` | Max papers to return |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://export.arxiv.org/api/query` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=3600` |

**Response**: XML Atom feed passthrough (Content-Type: `application/xml`).

---

### Meta

Six utility endpoints for version checking, telemetry, downloads, and social sharing.

---

#### `GET /api/version`

Latest GitHub release version info.

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| `GITHUB_TOKEN` | Optional | GitHub Releases API |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=600` |

**Response**

```typescript
interface VersionResponse {
  version: string;           // e.g., "1.4.2"
  url: string;               // release page URL
  published_at: string;      // ISO 8601 date
}
```

---

#### `GET /api/cache-telemetry`

In-memory cache telemetry snapshot (diagnostic).

**Caching**: `Cache-Control: no-store` — never cached.

**Response**: Output of `getCacheTelemetrySnapshot()` — per-endpoint hit/miss/stale counts and hit rates. See [`_cache-telemetry.js`](#_cache-telemetryjs) for the schema.

---

#### `GET /api/debug-env`

Dead endpoint — always returns 404.

**Response**

```json
{ "error": "Not available" }
```

Status: **404**

---

#### `GET /api/download`

Platform-specific desktop installer redirect.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `platform` | `string` | **(required)** | Target platform: `macos-arm64`, `macos-x64`, `windows`, `linux` |

**Response**: **302 redirect** to the corresponding GitHub release asset URL.

---

#### `GET /api/og-story`

SVG social preview card generator.

> **Runtime**: Node.js (NOT Edge Function)

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | `string` | — | Card title |
| `subtitle` | `string` | — | Card subtitle |
| `variant` | `string` | — | Visual variant (optional) |

**Response**: SVG image (`Content-Type: image/svg+xml`).

---

#### `GET /api/story`

OG meta page for social sharing — serves HTML with Open Graph tags to crawlers and redirects real users.

> **Runtime**: Node.js (NOT Edge Function)

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | **(required)** | Story ID |

**Response**:

- **Bot user-agents**: HTML page with `<meta property="og:*">` tags
- **Real browsers**: **302 redirect** to the dashboard with the story pre-selected

---

### Risk & Baseline

Two endpoints for pre-computed risk scores and temporal statistical baselines.

---

#### `GET /api/risk-scores`

Pre-computed Country Instability Index (CII) for 20 Tier-1 countries.

**Auth & External API**

| Env Var | Required | Upstream |
|---------|----------|----------|
| — | — | Pre-computed (no external calls at request time) |

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 600 s (10 min) | `risk-scores:v1` |

**Response**

```typescript
interface RiskScoresResponse {
  scores: RiskScore[];
  timestamp: number;
}

interface RiskScore {
  country: string;
  countryCode: string;
  cii: number;                // Country Instability Index (0–100)
  components: {
    conflict: number;
    economic: number;
    governance: number;
    social: number;
  };
  trend: "improving" | "stable" | "deteriorating";
}
```

---

#### `GET /api/temporal-baseline` / `POST /api/temporal-baseline`

Welford's online algorithm for maintaining streaming temporal baselines.

##### `GET` — Read Baseline

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `key` | `string` | **(required)** | Baseline key |

**Response**

```typescript
interface BaselineReadResponse {
  mean: number;
  variance: number;
  stddev: number;
  count: number;
  lastUpdated: string;      // ISO 8601
}
```

##### `POST` — Update Baseline

**Request Body**

```typescript
interface BaselineUpdateRequest {
  key: string;
  value: number;
}
```

**Response**

```typescript
interface BaselineUpdateResponse {
  updated: true;
  stats: {
    mean: number;
    variance: number;
    stddev: number;
    count: number;
  };
}
```

**Caching**

| Layer | TTL | Key |
|-------|-----|-----|
| Upstash | 7 776 000 s (90 d) | `baseline:{key}` |

---

### Proxy / Passthrough Subdirectories

Four catch-all proxy groups that forward requests to external APIs, injecting credentials where needed.

---

#### `GET /api/eia/*`

EIA (Energy Information Administration) energy data proxy.

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `EIA_API_KEY` | Yes | `https://api.eia.gov/v2/` — path suffix is appended |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=3600` |

**Behaviour**: The API key is injected server-side; the request path after `/api/eia/` is forwarded to the EIA API verbatim.

---

#### `GET /api/pizzint/*`

Proxy to pizzint.watch intelligence APIs.

**Endpoints**

| Path | Purpose |
|------|---------|
| `/api/pizzint/dashboard-data` | Dashboard data |
| `/api/pizzint/gdelt/batch` | GDELT batch queries |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| — | — | `https://pizzint.watch/` |

**Caching**

| Layer | TTL |
|-------|-----|
| CDN | `s-maxage=120` |

---

#### `GET /api/wingbits/*`

Wingbits aircraft tracking data proxy.

**Endpoints**

| Path | Cache TTL | Purpose |
|------|-----------|---------|
| `/api/wingbits/flights` | `s-maxage=15` | Live flight positions |
| `/api/wingbits/details` | `s-maxage=300` | Aircraft details |
| `/api/wingbits/batch` | `s-maxage=15` | Batch flight queries |

**Auth & External API**

| Env Var | Required | Upstream URL |
|---------|----------|--------------|
| `WINGBITS_API_KEY` | Yes | `https://data.wingbits.com/` |

---

#### `GET /api/youtube/*`

YouTube integration endpoints.

**Endpoints**

| Path | Purpose | Response |
|------|---------|----------|
| `/api/youtube/embed` | HTML embed player page | HTML document |
| `/api/youtube/live` | Channel live video scraper | `{ videoId: string }` |

**Auth**: None — uses public YouTube pages.

---

## Error Handling

All endpoints return errors in a consistent JSON envelope:

```typescript
interface ErrorResponse {
  error: string;               // human-readable message
  status?: number;             // HTTP status code (sometimes included)
  details?: string;            // additional context (dev-mode only)
}
```

### Standard HTTP Status Codes

| Status | Meaning | Common Trigger |
|--------|---------|----------------|
| `400` | Bad Request | Missing or invalid required parameters |
| `403` | Forbidden | CORS origin not on allowlist |
| `404` | Not Found | Invalid endpoint path |
| `405` | Method Not Allowed | Wrong HTTP method (e.g., POST to a GET-only endpoint) |
| `413` | Payload Too Large | Request body exceeds size limit (e.g., 50 KB for LLM endpoints) |
| `429` | Too Many Requests | IP rate limit exceeded — includes `Retry-After` header |
| `500` | Internal Server Error | Unhandled exception or upstream processing failure |
| `502` | Bad Gateway | Upstream API returned an error |
| `503` | Service Unavailable | Missing credentials; some endpoints degrade gracefully |
| `504` | Gateway Timeout | Upstream API did not respond within timeout |

### Graceful Degradation

Many endpoints are designed to **never hard-fail** on credential or upstream issues:

- Missing `ACLED_*` credentials → `{ success: true, data: [] }`
- Unreachable upstream → `{ unavailable: true, ... }` with stale cached data when available
- The 3-tier cache (fresh → warm → cold) ensures `theater-posture` almost always returns data

---

## Rate Limiting

### Global Defaults

The default rate limiter configuration (from `_ip-rate-limit.js`):

| Parameter | Value |
|-----------|-------|
| Requests per window | 60 |
| Window duration | 60 seconds |
| Max tracked IPs | 10 000 |
| Cleanup interval | 5 minutes |

### Per-Endpoint Overrides

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/acled` | 10 req | 1 min |
| `/api/acled-conflict` | 10 req | 1 min |
| `/api/ucdp-events` | 15 req | 1 min |
| `/api/climate-anomalies` | 15 req | 1 min |
| `/api/cyber-threats` | 20 req | 1 min |
| `/api/unhcr-population` | 20 req | 1 min |
| `/api/worldpop-exposure` | 30 req | 1 min |

### Rate Limit Response

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{
  "error": "Rate limit exceeded",
  "retryAfter": 42
}
```

---

## Caching Architecture

World Monitor uses a **multi-tier caching strategy** to minimize upstream API calls, reduce latency, and stay within third-party rate limits.

### Tier Overview

```
┌──────────────────────────────────────────────────┐
│                   Client                         │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  Tier 1: Vercel CDN Edge Cache                   │
│  ─────────────────────────────────               │
│  • Cache-Control: s-maxage=<TTL>                 │
│  • stale-while-revalidate=<TTL*2>                │
│  • Fastest — zero origin hit on cache hit        │
│  • TTLs: 15 s (real-time) to 3600 s (static)    │
└──────────────────┬───────────────────────────────┘
                   │ (CDN MISS)
┌──────────────────▼───────────────────────────────┐
│  Tier 2: Upstash Redis                           │
│  ─────────────────────────────────               │
│  • Distributed, shared across all Edge instances │
│  • Key-value with per-key TTL                    │
│  • Used for expensive/quota-limited upstreams    │
│  • TTLs: 120 s (crypto) to 7 776 000 s (90 d)   │
│  • Sidecar mode: in-memory Map + disk persist    │
└──────────────────┬───────────────────────────────┘
                   │ (Upstash MISS)
┌──────────────────▼───────────────────────────────┐
│  Tier 3: In-Memory Map (per-instance)            │
│  ─────────────────────────────────               │
│  • Process-local, fastest read path              │
│  • Used as write-through for hot endpoints       │
│  • Bounded by MAX_PERSIST_ENTRIES (5000)         │
│  • Survives within a single Edge invocation      │
└──────────────────┬───────────────────────────────┘
                   │ (All MISS)
┌──────────────────▼───────────────────────────────┐
│  Origin: External API                            │
│  ─────────────────────────────────               │
│  • Actual upstream fetch                         │
│  • Result written back to all applicable tiers   │
└──────────────────────────────────────────────────┘
```

### Cache Key Conventions

| Pattern | Example | Used By |
|---------|---------|---------|
| `{endpoint}:{hash}` | `acled:a1b2c3d4` | Most endpoints |
| `{endpoint}:{param}:{param}` | `ucdp:1:100` | Simple paginators |
| `{endpoint}:v{N}` | `cyber-threats:v2` | Versioned caches |
| `{endpoint}:{tier}` | `theater-posture:fresh` | Multi-tier graduated |
| `summary:{hash}` | `summary:e5f6g7h8` | Shared across groq + openrouter |
| `baseline:{key}` | `baseline:earthquake-rate` | Temporal baselines |

### Cache Telemetry

The `_cache-telemetry.js` module records HIT/MISS/STALE per endpoint, accessible via `GET /api/cache-telemetry`. This provides per-instance visibility into cache performance:

```json
{
  "acled": { "hit": 142, "miss": 8, "stale": 3, "total": 153, "hitRate": 0.928 },
  "earthquakes": { "hit": 891, "miss": 12, "stale": 0, "total": 903, "hitRate": 0.987 }
}
```

### TTL Reference Table

| TTL | Duration | Endpoints |
|-----|----------|-----------|
| 8–15 s | Real-time | `ais-snapshot`, `opensky`, `wingbits/flights` |
| 60 s | 1 min | `finnhub`, `yahoo-finance`, `service-status` |
| 120 s | 2 min | `coingecko`, `stablecoin-markets`, `pizzint/*` |
| 300 s | 5 min | `gdelt-doc`, `gdelt-geo`, `rss-proxy`, `hackernews`, `polymarket`, `theater-posture:fresh` |
| 600 s | 10 min | `acled`, `acled-conflict`, `firms-fires`, `cyber-threats`, `cloudflare-outages`, `risk-scores`, `version` |
| 900 s | 15 min | `etf-flows` |
| 3 600 s | 1 h | `nga-warnings`, `stock-index`, `fred-data`, `groq-summarize`, `openrouter-summarize`, `github-trending`, `arxiv`, `eia/*` |
| 7 200 s | 2 h | `country-intel` |
| 21 600 s | 6 h | `ucdp-events`, `climate-anomalies`, `hapi`, `tech-events` |
| 86 400 s | 24 h | `ucdp`, `unhcr-population`, `worldbank`, `classify-batch`, `classify-event`, `theater-posture:warm` |
| 604 800 s | 7 d | `worldpop-exposure`, `theater-posture:cold` |
| 7 776 000 s | 90 d | `temporal-baseline` |

---

## Environment Variables Reference

Complete list of environment variables used across all endpoints:

| Variable | Required By | Description |
|----------|-------------|-------------|
| `ACLED_ACCESS_TOKEN` | `acled`, `acled-conflict` | ACLED API access token |
| `ACLED_EMAIL` | `acled`, `acled-conflict` | ACLED registered email |
| `ABUSEIPDB_API_KEY` | `cyber-threats` (optional) | AbuseIPDB API key |
| `CLOUDFLARE_API_TOKEN` | `cloudflare-outages` | Cloudflare Radar API token |
| `EIA_API_KEY` | `eia/*` | EIA energy data API key |
| `FINNHUB_API_KEY` | `finnhub`, `etf-flows`, `macro-signals` | Finnhub stock data API key |
| `FRED_API_KEY` | `fred-data`, `macro-signals` | FRED economic data API key |
| `GITHUB_TOKEN` | `version`, `github-trending` (optional) | GitHub API token for higher rate limits |
| `GROQ_API_KEY` | `classify-batch`, `classify-event`, `groq-summarize`, `country-intel` | Groq LLM API key |
| `HDX_APP_IDENTIFIER` | `hapi` (optional) | HDX HAPI app identifier |
| `NASA_FIRMS_API_KEY` | `firms-fires` | NASA FIRMS fire data API key |
| `OPENROUTER_API_KEY` | `openrouter-summarize` | OpenRouter API key |
| `UPSTASH_REDIS_REST_URL` | `_upstash-cache` (cloud mode) | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | `_upstash-cache` (cloud mode) | Upstash Redis REST token |
| `WINGBITS_API_KEY` | `wingbits/*` | Wingbits aircraft data API key |
| `WS_RELAY_URL` | `ais-snapshot` | AIS WebSocket relay URL |
| `SIDECAR` | `_upstash-cache` (sidecar mode) | Set to `"true"` for local disk-backed cache |
