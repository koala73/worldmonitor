# WorldMonitor Architecture & JARVIS Integration Guide

## Executive Summary

WorldMonitor is a sophisticated real-time intelligence dashboard with **86 Panel components**, **120+ domain services**, **60+ RPC endpoints**, and existing AI/chat infrastructure. A JARVIS-like assistant would integrate at multiple levels: Panel UI, service layer, RPC contract system, and LLM reasoning pipeline.

---

## Part 1: System Architecture Overview

### High-Level Topology

```
┌─────────────────────────────────────────────┐
│         Browser / Desktop SPA               │
│  ┌──────────────────────────────────────┐   │
│  │ 86 Panel Components                  │   │
│  │ - ChatAnalystPanel (pro-only SSE)    │   │
│  │ - 85 domain-specific panels          │   │
│  │ - Dual Maps (deck.gl + globe.gl)     │   │
│  └──────────────────────────────────────┘   │
│         ↑                         ↑           │
│         │ RPC fetch /api/*        │ Events   │
│         ↓                         ↓           │
│  ┌──────────────────────────────────────┐   │
│  │ AppContext (central state)           │   │
│  │ - All cached data                    │   │
│  │ - UI references                      │   │
│  │ - In-flight request tracking         │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
          ↑ fetch /api/*
          │
┌─────────────────────────────────────────────────────────┐
│ Vercel Edge Functions (self-contained JS)              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Server Layer (bundled at deploy)                │   │
│  │ - Domain handlers (market, military, climate)   │   │
│  │ - LLM reasoning (chat-analyst)                  │   │
│  │ - Data aggregation & context building           │   │
│  │ - Gateway with CORS, auth, rate-limit           │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
          ↑ cachedFetchJson
          │
  ┌───────▼────────┐
  │ Upstash Redis  │ (4-tier cache hierarchy + stampede protection)
  └───────┬────────┘
          ↑
  ┌───────▼─────────────────────────────────┐
  │ 30+ Data Sources (Finnhub, Yahoo, GDELT,│
  │ ACLED, OpenSky, CoinGecko, etc.)        │
  └─────────────────────────────────────────┘
```

### Key Characteristics

| Aspect | Detail |
|--------|--------|
| **Frontend Framework** | Vite + Preact (TypeScript, class-based components) |
| **State Management** | Pure vanilla JS (central `AppContext` mutable object) |
| **Component Model** | 86 Panel subclasses extending base `Panel` class |
| **API Layer** | Vercel Edge Functions (self-contained, no external imports) |
| **RPC Contract** | Protocol Buffers + sebuf framework (auto-generated clients) |
| **Caching** | 4-tier: bootstrap → in-memory → Redis → upstream |
| **Data Freshness** | Seed scripts (Railway) + Redis metadata + health monitoring |
| **Desktop** | Tauri 2.x shell + Node.js sidecar for local API |
| **LLM Integration** | SSE streaming (chat-analyst.ts), ML worker (ONNX) |

---

## Part 2: Component Architecture

### Panel System (86 Components)

**Base Class** (`src/components/Panel.ts`):
```typescript
export interface PanelOptions {
  id: string;                    // Unique identifier
  title: string;                 // Display name
  showCount?: boolean;           // Show item count in header
  className?: string;            // Custom CSS classes
  trackActivity?: boolean;       // Analytics tracking
  infoTooltip?: string;         // Hover tooltip (i18n key)
  premium?: 'locked' | 'enhanced';  // Gating
  closable?: boolean;            // Can be removed from layout
  collapsible?: boolean;         // Can be collapsed
  defaultRowSpan?: number;       // Grid row height
}

export class Panel {
  protected id: string;
  protected title: string;
  protected content: HTMLElement;  // Stable element for setContent()
  
  setContent(html: string): void  // Debounced 150ms
  setCount(n: number): void
  markStale(): void
  destroy(): void
  // ... event delegation, lifecycle methods
}
```

**Rendering Pattern**:
- Panels use `setContent(html)` with automatic DOM diffing
- Event delegation on stable `this.content` element
- Debounced 150ms to batch DOM updates
- localStorage persists row/col spans

**Examples**:
- `ChatAnalystPanel`: Streaming LLM chat (pro-only)
- `MarketPanel`: Stock quotes, crypto, commodities
- `MilitaryCorrelationPanel`: Cross-domain threat correlation
- `CountryBriefPanel`: Country-focused intelligence summary

### Application Initialization (8 Phases)

`App.ts` runs initialization in this sequence:

```typescript
private async init(): Promise<void> {
  // 1. Storage + i18n: IndexedDB, locale loading
  // 2. ML Worker: ONNX model preparation
  // 3. Sidecar: Wait for desktop sidecar readiness (desktop only)
  // 4. Bootstrap: Concurrent hydration (/api/bootstrap)
  //    - Fast tier (3s timeout): live data
  //    - Slow tier (5s timeout): reference data
  // 5. Layout: PanelLayoutManager renders map + panels
  // 6. UI: SignalModal, BreakingNewsBanner, CorrelationEngine
  // 7. Data: loadAllData() + primeVisiblePanelData()
  // 8. Refresh: Start smart polling loops
}
```

### State Management: AppContext

Central mutable object in `src/app/app-context.ts`:

```typescript
export interface AppContext {
  // UI Components
  map: MapContainer | null;
  panels: Record<string, Panel>;
  signalModal: SignalModal | null;
  searchModal: SearchModal | null;
  
  // Cached Data (fed by services)
  allNews: NewsItem[];
  newsByCategory: Record<string, NewsItem[]>;
  latestMarkets: MarketData[];
  latestPredictions: PredictionMarket[];
  latestClusters: ClusteredEvent[];
  intelligenceCache: IntelligenceCache;
  cyberThreatsCache: CyberThreat[] | null;
  
  // Request Tracking
  inFlight: Set<string>;  // Currently loading data keys
  seenGeoAlerts: Set<string>;
  
  // Configuration
  mapLayers: MapLayers;
  panelSettings: Record<string, PanelConfig>;
  disabledSources: Set<string>;
  currentTimeRange: TimeRange;
  
  // Flags
  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
}
```

**Key Pattern**: No Redux/Zustand — direct property mutations with event-based subscriptions.

---

## Part 3: Existing Chat/AI Infrastructure

### 1. ChatAnalystPanel (Pro-Only Streaming Chat)

**File**: `src/components/ChatAnalystPanel.ts`

```typescript
export class ChatAnalystPanel extends Panel {
  private history: ChatMessage[] = [];
  private domainFocus = 'all';  // all | geo | market | military | economic
  private streamAbort: AbortController | null = null;
  
  // UI: domain filter chips, quick action buttons, textarea input
  // Events: send query, clear history, export, domain filter
  
  private async streamAnalystQuery(query: string): Promise<void> {
    const response = await premiumFetch('/api/chat-analyst', {
      method: 'POST',
      body: JSON.stringify({
        history: this.history,
        query,
        domainFocus: this.domainFocus,
        geoContext: detectUserRegion(),
      }),
    });
    
    // SSE streaming:
    // - meta event: sources, degraded flag
    // - action events: suggest-widget recommendations
    // - delta events: streaming content tokens
    // - done event: completion
    
    for await (const event of streamSseEvents(response)) {
      if (event.type === 'delta') {
        this.appendToMessages(event.delta);
      } else if (event.type === 'action') {
        this.suggestWidget(event.action);
      }
    }
  }
}
```

**Features**:
- Domain filters: all, geo, market, military, economic
- Quick action buttons (Situation, Markets, Conflicts, Forecasts, Risk)
- Markdown rendering with allowlist (no img/a/iframe)
- SSE streaming with abort controller
- Message history management (max 20)

### 2. Chat Analyst API (Edge Function)

**File**: `api/chat-analyst.ts`

```typescript
export default async function handler(req: Request): Promise<Response> {
  // POST /api/chat-analyst
  // Returns: text/event-stream (SSE)
  
  const { history, query, domainFocus, geoContext } = parseBody(req);
  
  // Auth: Clerk JWT (plan==='pro') or X-WorldMonitor-Key
  
  // Context assembly
  const context = await assembleAnalystContext(domainFocus, geoContext);
  const systemPrompt = buildAnalystSystemPrompt(context);
  
  // LLM streaming
  const stream = await callLlmReasoningStream(systemPrompt, history, query);
  
  // Action suggestion
  const actions = await buildActionEvents(query, stream);
  
  // SSE response with prependSseEvents
  return streamResponse(prependSseEvents([meta, ...actions], stream));
}
```

**Flow**:
1. Parse and validate request
2. Check Clerk JWT or API key
3. Assemble context from cached data
4. Build system prompt with sources
5. Call LLM with streaming
6. Generate widget action suggestions
7. Return SSE stream with meta + actions + deltas + done

### 3. Widget Agent API

**File**: `api/widget-agent.ts`

- Proxy to Railway relay service (`https://proxy.worldmonitor.app`)
- GET/POST `/api/widget-agent`
- Auth: Clerk JWT, X-WorldMonitor-Key, or legacy keys
- Streams SSE responses from relay

### 4. Server-Side Chat Handlers

**File**: `server/worldmonitor/intelligence/v1/`

```typescript
// chat-analyst-context.ts
export async function assembleAnalystContext(domainFocus, geoContext) {
  // Gather recent data from:
  // - News clustering (last 100)
  // - Market movements
  // - Military activity
  // - Prediction markets
  // - Risk scores
  // Returns rich context object with sources
}

// chat-analyst-prompt.ts
export function buildAnalystSystemPrompt(context) {
  // Construct system message with:
  // - Role definition
  // - Available data sources
  // - Domain context
  // - Response constraints
}

// chat-analyst-actions.ts
export async function buildActionEvents(query, stream) {
  // Suggest widget creation for visual queries
  // Return action events to inject into SSE stream
}
```

### 5. ML Worker (Browser-Based Models)

**File**: `src/services/ml-worker.ts` + `src/workers/ml.worker.ts`

**ONNX Models via @xenova/transformers**:
- **MiniLM-L6**: Embeddings (384-dim vectors)
- **Sentiment**: Positive/negative/neutral classification
- **Summarization**: Abstractive text summarization
- **NER**: Named Entity Recognition

**Vector Store**:
```typescript
interface VectorSearchResult {
  text: string;
  pubDate: number;
  source: string;
  score: number;  // Cosine similarity
}

// In-worker IndexedDB-backed store for headline memory
await mlWorker.vectorStoreIngest([headlines]);
const similar = await mlWorker.vectorStoreSearch(query, topK: 5);
```

**Usage**: Headline clustering, sentiment-driven filtering, entity extraction.

### 6. AI Flow Settings

**File**: `src/services/ai-flow-settings.ts`

Per-user toggles (localStorage-backed):
```typescript
export interface AiFlowSettings {
  browserModel: boolean;      // Use local ONNX models
  cloudLlm: boolean;          // Use cloud LLM (chat-analyst)
  mapNewsFlash: boolean;      // Show news popups on map
  headlineMemory: boolean;    // Persist headlines in vector DB
  badgeAnimation: boolean;    // UI animation toggle
}

export function setAiFlowSetting(key, value): void
export function subscribeAiFlowChange(callback): () => void  // Unsubscribe
```

---

## Part 4: Service Layer Architecture

### Organization

**120+ service files** organized by domain:

```
src/services/
├── market/                  (Finnhub, Yahoo, CoinGecko RPC clients)
├── aviation/                (OpenSky, delays)
├── military/                (flights, vessels, surge detection)
├── climate/                 (EONET, anomalies)
├── cyber/                   (threats, DDoS, ransomware)
├── conflict/                (ACLED, GDELT, UCDP)
├── intelligence/            (CII, risk scores, geo-convergence)
├── ml-worker.ts             (ONNX inference manager)
├── analysis-worker.ts       (clustering, correlation detection)
├── rpc-client.ts            (base fetch helper)
├── bootstrap.ts             (cache hydration)
├── correlation-engine/      (cross-domain signal correlation)
└── ... (60+ more services)
```

### Service Pattern: Market Service Example

**File**: `src/services/market/index.ts`

```typescript
// Generated RPC client
const client = new MarketServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)
});

// Circuit breaker for each RPC
const stockBreaker = createCircuitBreaker<ListMarketQuotesResponse>({
  name: 'Market Quotes',
  cacheTtlMs: 5 * 60 * 1000,
  persistCache: true
});

// Main fetch function
export async function fetchMultipleStocks(
  symbols: Array<{ symbol: string; name: string; display: string }>,
  options: { onBatch?: (results: MarketData[]) => void } = {}
): Promise<MarketFetchResult> {
  try {
    const response = await stockBreaker.execute(async () => 
      client.listMarketQuotes({ symbols: symbols.map(s => s.symbol) })
    );
    
    const data = response.quotes.map(quote => toMarketData(quote, meta));
    
    options.onBatch?.(data);
    return { data, skipped: response.finnhubSkipped, rateLimited: response.rateLimited };
  } catch (error) {
    // Fallback to circuit breaker cache
    return stockBreaker.getFallback() ?? { data: [] };
  }
}

// Proto → Legacy adapter
function toMarketData(proto: ProtoMarketQuote, meta?): MarketData {
  return {
    symbol: proto.symbol,
    price: proto.price ?? null,
    change: proto.change ?? null,
    sparkline: proto.sparkline.length > 0 ? proto.sparkline : undefined,
  };
}
```

### Circuit Breaker Pattern

**File**: `src/utils/circuit-breaker.ts`

```typescript
interface CircuitBreakerOptions<T> {
  name: string;
  cacheTtlMs?: number;
  persistCache?: boolean;  // Use localStorage as fallback
}

export function createCircuitBreaker<T>(opts: CircuitBreakerOptions<T>) {
  return {
    async execute<R>(fn: () => Promise<R>): Promise<R> {
      // Try to execute
      // On failure: consult cache
      // If cache stale/missing: return fallback
      // Maintains service availability during outages
    },
    getFallback(): T | null
  }
}
```

**Prevents cascade failures** when upstream APIs are slow or down.

---

## Part 5: Proto/RPC Contract System

### The sebuf Framework

**Flow**:
```
proto/ definitions (.proto files)
  ↓ buf generate (Buf CLI + sebuf plugins)
src/generated/client/   (TypeScript RPC client stubs)
src/generated/server/   (TypeScript message types)
docs/api/               (OpenAPI v3 specs)
```

**Example Proto Definition** (`proto/worldmonitor/market/v1/service.proto`):

```protobuf
service MarketService {
  rpc ListMarketQuotes(ListMarketQuotesRequest) returns (ListMarketQuotesResponse) {
    option (sebuf.http.config) = {
      get: "/market/v1/quotes"
    };
  }
}

message ListMarketQuotesRequest {
  repeated string symbols = 1 [(sebuf.http.query) = true];
  optional int32 limit = 2 [(sebuf.http.query) = true];
}

message ListMarketQuotesResponse {
  repeated MarketQuote quotes = 1;
  bool finnhub_skipped = 2;
  string skip_reason = 3;
  bool rate_limited = 4;
}

message MarketQuote {
  string symbol = 1;
  string name = 2;
  double price = 3;
  double change = 4;
  repeated double sparkline = 5;
}
```

**Generated TypeScript Client** (`src/generated/client/worldmonitor/market/v1/service_client.ts`):

```typescript
export class MarketServiceClient {
  constructor(baseUrl: string, options?: ClientOptions) {}
  
  async listMarketQuotes(request: ListMarketQuotesRequest): Promise<ListMarketQuotesResponse> {
    // Constructs GET request with query params
    // Handles serialization/deserialization
    // Returns typed response
  }
}

export interface ListMarketQuotesRequest {
  symbols: string[];
  limit?: number;
}

export interface ListMarketQuotesResponse {
  quotes: MarketQuote[];
  finnhubSkipped: boolean;
  skipReason: string;
  rateLimited: boolean;
}
```

### RPC Annotations

| Annotation | Purpose |
|-----------|---------|
| `(sebuf.http.config) = { get: "..." }` | Maps to HTTP GET |
| `(sebuf.http.query) = true` | Makes field a query parameter |
| `(sebuf.http.body) = true` | Makes field request body |
| `(sebuf.http.path_param) = "id"` | Makes field URL path parameter |

**Key Rules**:
- GET fields MUST have `(sebuf.http.query)` annotation
- `repeated string` fields need `parseStringArray()` in handler
- `int64` maps to `string` in TypeScript
- CI enforces proto freshness: `.github/workflows/proto-check.yml`

---

## Part 6: API Layer Architecture

### Vercel Edge Functions (Self-Contained)

**Constraint**: Each file in `api/*.js` is a Vercel Edge Function:
- **CANNOT import**: `../src/`, `../server/` (different runtime)
- **CAN import**: same-directory `_*.js` helpers, npm packages
- **Enforced by**: `tests/edge-functions.test.mjs` + pre-push esbuild check

**Example** (`api/health.js`):
```javascript
export default async function handler(req) {
  const keys = await redis.keys('seed-meta:*');
  
  for (const key of keys) {
    const meta = await redis.get(key);
    const staleMs = Date.now() - meta.fetchedAt;
    
    if (staleMs > maxStaleMin * 60 * 1000) {
      // Alert on staleness
    }
  }
  
  return json(healthStatus);
}
```

### Gateway Factory

**File**: `server/gateway.ts`

Creates per-domain handler bundles:

```typescript
export function createDomainGateway(routes: Record<string, HandlerFn>) {
  return async (req: Request, ctx: ExecutionContext): Promise<Response> => {
    // 1. Origin check (403 if disallowed)
    // 2. CORS headers
    // 3. OPTIONS preflight
    // 4. API key validation
    // 5. Rate limiting
    // 6. Route matching (GET /market/v1/quotes?symbols=AAPL,MSFT)
    // 7. POST-to-GET compatibility
    // 8. Handler execution with error boundary
    // 9. ETag generation + 304 Not Modified
    // 10. Cache header application
  };
}
```

### Cache Tiers

| Tier | s-maxage | Use Case |
|------|----------|----------|
| **fast** | 300s | Live events, flight status |
| **medium** | 600s | Market quotes, stock analysis |
| **slow** | 1800s | ACLED events, cyber threats |
| **static** | 7200s | Summaries, ETF flows |
| **daily** | 86400s | Critical minerals, reference data |
| **no-store** | 0 | Real-time snapshots |

### Handler Pattern

**File**: `server/worldmonitor/market/v1/handler.ts`

```typescript
export const handlers = {
  async listMarketQuotes(req: Request, ctx: ExecutionContext): Promise<Response> {
    // 1. Parse query params
    const symbols = parseStringArray(req.url.searchParams.get('symbols') ?? '');
    
    // 2. Build cache key (MUST include request-varying params!)
    const cacheKey = `market-quotes:${symbols.sort().join(',')}`;
    
    // 3. Use cachedFetchJson for stampede protection
    const result = await cachedFetchJson(
      cacheKey,
      async () => {
        // Fetch from Finnhub, Yahoo, etc.
        const quotes = await finnhubClient.getQuotes(symbols);
        return { quotes, finnhubSkipped: false };
      },
      { ttlSec: 300, namespace: 'market' }
    );
    
    // 4. Return typed response
    return json(result);
  }
};
```

---

## Part 7: Data Loading & Real-Time Refresh

### Data Loader Manager

**File**: `src/app/data-loader.ts`

Orchestrates all parallel data fetching:

```typescript
export class DataLoaderManager implements AppModule {
  async loadAllData(): Promise<void> {
    // Parallel fetching of all required data sources:
    // - Market quotes (stocks, commodities, crypto, sectors)
    // - News feeds (news, predictions, clusters)
    // - Military activity (flights, vessels, surge detection)
    // - Climate events (earthquakes, weather, thermal escalation)
    // - Cyber threats
    // - Risk scores (CII)
    // - Conflict events (ACLED, GDELT, UCDP)
    // - Supply chain
    // - And 20+ more domains
    
    const promises = [
      this.loadMarkets(),
      this.loadNews(),
      this.loadMilitary(),
      this.loadClimate(),
      // ...
    ];
    
    await Promise.all(promises);
  }
  
  async primeVisiblePanelData(): Promise<void> {
    // After main load, fetch data for panels near viewport
    // Reduces initial load time by prioritizing visible content
  }
}
```

### Refresh Scheduler

**File**: `src/app/refresh-scheduler.ts`

Manages continuous data polling:

```typescript
export class RefreshScheduler implements AppModule {
  scheduleRefresh(
    name: string,
    fn: () => Promise<boolean | void>,
    intervalMs: number,
    condition?: () => boolean
  ): void {
    // Uses startSmartPollLoop:
    // - Exponential backoff (max 4x)
    // - Viewport-conditional (only if panel near viewport)
    // - Tab pause (suspend when hidden)
    // - Staggered flush on tab visibility (150ms delays)
  }
}

// Example usage (from App.ts)
this.refreshScheduler.scheduleRefresh(
  'market-quotes',
  () => this.loadMarketData(),
  60_000,  // 60s interval
  () => this.isPanelNearViewport('market-panel')  // Condition
);
```

### Bootstrap Hydration

**File**: `api/bootstrap.js`

Pre-computed context cache:

```javascript
export default async function handler(req) {
  // Returns pre-computed caches for fast initial load:
  
  const caches = await Promise.all([
    redis.get('bootstrap:recent-news'),
    redis.get('bootstrap:market-summary'),
    redis.get('bootstrap:military-hotspots'),
    redis.get('bootstrap:risk-scores'),
    // ...
  ]);
  
  return json({ caches });
}
```

**Client-side** (`src/services/bootstrap.ts`):

```typescript
export async function fetchBootstrapData(): Promise<BootstrapData> {
  // Fetch two tiers concurrently with separate abort controllers:
  
  const fastPromise = premiumFetch('/api/bootstrap?tier=fast')
    .then(r => r.json())
    .catch(() => null);
  
  const slowPromise = premiumFetch('/api/bootstrap?tier=slow')
    .then(r => r.json())
    .catch(() => null);
  
  const [fastData, slowData] = await Promise.race([
    Promise.all([fastPromise, slowPromise]),
    // timeout after 3s for fast, 5s for slow
  ]);
  
  // Consume via getHydratedData(key)
}
```

---

## Part 8: Component Examples

### Example 1: Market Panel (Simple Data Display)

```typescript
export class MarketPanel extends Panel {
  constructor() {
    super({
      id: 'market-panel',
      title: 'Markets',
      defaultRowSpan: 1,
    });
  }

  async render(): Promise<void> {
    const markets = await fetchMultipleStocks([
      { symbol: 'AAPL', name: 'Apple', display: 'AAPL' },
      { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT' },
    ]);

    const html = `
      <table>
        ${markets.data.map(m => `
          <tr>
            <td>${m.symbol}</td>
            <td>${m.price}</td>
            <td class="${m.change > 0 ? 'positive' : 'negative'}">
              ${m.change > 0 ? '+' : ''}${m.change.toFixed(2)}%
            </td>
          </tr>
        `).join('')}
      </table>
    `;
    
    this.setContent(html);
  }
}
```

### Example 2: ChatAnalystPanel (Streaming LLM)

See existing `src/components/ChatAnalystPanel.ts` — uses SSE streaming from `/api/chat-analyst`.

### Example 3: Map-Based Panel (Correlation Detection)

```typescript
export class MilitaryCorrelationPanel extends Panel {
  constructor() {
    super({
      id: 'military-correlation',
      title: 'Military Correlation',
      premium: 'enhanced',
    });
  }

  async render(): Promise<void> {
    const signals = await analysisWorker.correlate({
      flights: await fetchMilitaryFlights(),
      vessels: await fetchMilitaryVessels(),
      threats: await fetchCyberThreats(),
    });

    // Render signals as map markers
    const markers = signals.map(s => ({
      lat: s.latitude,
      lon: s.longitude,
      type: 'correlation',
      severity: s.severity,
    }));

    this.state.map?.addMarkers(markers);
  }
}
```

---

## Part 9: Desktop Architecture (Tauri + Sidecar)

### Tauri Shell (`src-tauri/`)

```rust
// Manages lifecycle, system tray, IPC
// Platform-specific features:
// - macOS: Keychain integration
// - Windows: Credential Manager
// - Linux: keyring
// - All: system tray, app menu, window management
```

### Node.js Sidecar

**File**: `src-tauri/sidecar/local-api-server.mjs`

```javascript
// Runs on dynamic port (injected into frontend)
// Loads Edge Function handler modules dynamically
// Injects secrets from Tauri keyring
// Monkey-patches fetch to force IPv4

import handlers from '../../api/<domain>/index.js';

app.post('/api/<domain>/<path>', (req, res) => {
  const result = handlers.myRpc(req);
  res.json(result);
});
```

### Fetch Patching

**File**: `src/services/runtime.ts`

```typescript
export function installRuntimeFetchPatch(): void {
  if (!isDesktopRuntime()) return;
  
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    
    if (url.pathname.startsWith('/api/')) {
      // Route to sidecar with Bearer token
      const token = await getTauriToken();  // 5-min TTL via IPC
      const sidecarUrl = `http://127.0.0.1:${sidecarPort}${url.pathname}?${url.searchParams}`;
      
      return originalFetch(sidecarUrl, {
        ...init,
        headers: {
          ...init?.headers,
          'Authorization': `Bearer ${token}`,
        },
      });
    }
    
    // Fall back to cloud API if sidecar fails
    return originalFetch(input, init);
  };
}
```

---

## Part 10: Variant System

### How Variants Work

Detected by:
1. Hostname: `tech.worldmonitor.app` → tech variant
2. localStorage on desktop
3. `VITE_VARIANT` env var at build time

### Current Variants

| Variant | Focus | Panels | Layers |
|---------|-------|--------|--------|
| **full** | All domains | 86 panels | All layers |
| **tech** | Technology | Tech, venture, startups | Tech-focused |
| **finance** | Markets | Macro, equities, crypto | Financial |
| **commodity** | Commodity markets | Oil, metals, agriculture | Commodity |
| **happy** | Positive news | Good news only | Positive events |

### Variant Config Structure

**File**: `src/config/variants/full.ts`

```typescript
export const VARIANT_PANELS: VariantPanel[] = [
  { id: 'market-panel', row: 1, col: 1, rowSpan: 1, colSpan: 1 },
  { id: 'military-correlation', row: 1, col: 2, rowSpan: 2, colSpan: 2 },
  { id: 'chat-analyst', row: 3, col: 1, rowSpan: 2, colSpan: 3, premium: 'locked' },
  // ... 83 more panels
];

export const VARIANT_LAYERS: string[] = [
  'military-flights',
  'military-vessels',
  'cyber-threats',
  'power-outages',
  // ... all layers
];

export const REFRESH_INTERVALS = {
  'market-quotes': 60_000,
  'military-activity': 30_000,
  'cyber-threats': 15_000,
};
```

---

## Part 11: Testing Architecture

### Unit/Integration Tests

**File**: `tests/*.test.{mjs,mts}`

Using `node:test` runner:

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { assembleAnalystContext } from '../server/worldmonitor/intelligence/v1/chat-analyst-context.ts';

test('assembleAnalystContext returns context with sources', async (t) => {
  const context = await assembleAnalystContext('market');
  assert(context.sources.length > 0);
  assert(context.recentNews.length > 0);
});
```

### Edge Function Guardrails

**File**: `tests/edge-functions.test.mjs`

Validates self-contained constraints:

```javascript
// Check: No node: imports
// Check: No ../server/ or ../src/ imports
// Check: esbuild can bundle each api/*.js file
```

### E2E Tests

**File**: `e2e/*.spec.ts`

Using Playwright:

```typescript
test('Chat analyst streams SSE response', async ({ page }) => {
  await page.goto('https://worldmonitor.app');
  await page.click('[data-id="chat-analyst"]');
  await page.fill('textarea', 'What are today top risks?');
  
  // Verify SSE stream
  const msgPromise = page.waitForEvent('websocket');  // or event listener
  await page.click('button[data-action="send"]');
  
  const response = await msgPromise;
  assert(response.includes('meta:'));
  assert(response.includes('delta:'));
});
```

---

## Part 12: JARVIS Integration Points

### 1. New Chat Panel (Standalone or Extension)

**Option A: Extend ChatAnalystPanel**
```typescript
export class JarvisPanel extends ChatAnalystPanel {
  // Reuse SSE infrastructure
  // Add multi-modal input (voice, documents)
  // Custom domain filters specific to JARVIS
}
```

**Option B: New Independent Panel**
```typescript
export class JarvisIntelligencePanel extends Panel {
  // New component with different UX
  // Different streaming API endpoint
  // Custom UI patterns
}
```

### 2. New RPC Endpoint (Proto + Handler)

**proto/worldmonitor/intelligence/v1/jarvis_service.proto**:
```protobuf
service JarvisService {
  rpc StreamJarvisQuery(StreamJarvisQueryRequest) returns (stream StreamJarvisQueryResponse) {
    option (sebuf.http.config) = { post: "/jarvis/v1/stream" };
  }
}
```

**server/worldmonitor/intelligence/v1/jarvis-handler.ts**:
```typescript
export async function streamJarvisQuery(req, ctx): Promise<Response> {
  const { query, context } = parseBody(req);
  
  const systemPrompt = buildJarvisSystemPrompt(context);
  const stream = await callLlmReasoningStream(systemPrompt, query);
  
  return streamResponse(stream);
}
```

### 3. Service Layer Integration

**src/services/jarvis/index.ts**:
```typescript
import { JarvisServiceClient } from '@/generated/client/worldmonitor/intelligence/v1/jarvis_service_client';

const client = new JarvisServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args)
});

export async function* streamJarvisQuery(query, context) {
  const response = await client.streamJarvisQuery({ query, context });
  for await (const chunk of response) {
    yield chunk.delta;
  }
}
```

### 4. Data Aggregation

Extend context assembly pattern:

```typescript
// server/worldmonitor/intelligence/v1/jarvis-context.ts
export async function assembleJarvisContext(userQuery, currentViewport) {
  // Gather:
  // - User's recent activity
  // - Panels currently visible
  // - Map viewport bounds
  // - Related historical signals
  // - Market/military/climate context
  
  return {
    query: userQuery,
    viewport: currentViewport,
    recentSignals: [],
    marketContext: {},
    militaryContext: {},
    climateContext: {},
    sources: [],
  };
}
```

### 5. Worker Integration

Use ML worker for:
```typescript
// Embeddings for semantic search
const queryEmbedding = await mlWorker.embed([userQuery]);
const similarHeadlines = await mlWorker.vectorStoreSearch(queryEmbedding, topK: 10);

// Sentiment analysis on retrieved context
const sentiments = await mlWorker.sentiment([
  headline1,
  headline2,
]);

// Named entity extraction from LLM response
const entities = await mlWorker.extractEntities([llmResponse]);
```

### 6. State Extension

Add to `AppContext`:
```typescript
export interface AppContext {
  // ... existing fields ...
  
  jarvisState?: {
    conversationId: string;
    lastQuery: string;
    lastResponse: string;
    context: JarvisContext;
  };
}
```

### 7. UI Integration

Add to panel layout configs:
```typescript
// src/config/variants/full.ts
export const VARIANT_PANELS = [
  // ... existing ...
  { 
    id: 'jarvis-intelligence',
    row: 4,
    col: 1,
    rowSpan: 2,
    colSpan: 3,
    premium: 'locked'
  },
];
```

---

## Key Design Patterns for JARVIS

### Pattern 1: Context Assembly

```typescript
interface JarvisContext {
  userQuery: string;
  userLocation: string;
  viewportBounds: GeoBox;
  recentEvents: Event[];
  marketData: MarketSummary;
  militaryActivity: MilitarySummary;
  predictedRisks: RiskScore[];
  sources: string[];
}

async function assembleJarvisContext(query, viewport): Promise<JarvisContext> {
  const [events, markets, military, risks] = await Promise.all([
    getRecentEvents(viewport),
    getMarketSummary(),
    getMilitaryActivity(viewport),
    getPredictedRisks(),
  ]);
  
  return { userQuery: query, viewportBounds: viewport, recentEvents: events, /* ... */ };
}
```

### Pattern 2: Streaming LLM Responses

```typescript
// In Edge Function
const systemPrompt = buildJarvisSystemPrompt(context);
const stream = await callLlmReasoningStream(systemPrompt, userQuery);

return streamResponse(
  prependSseEvents([{ meta: { sources: context.sources } }], stream)
);
```

### Pattern 3: Action Suggestion

```typescript
// Post-LLM: extract intent from response
async function buildJarvisActions(response): Promise<Action[]> {
  // If LLM mentions "compare markets", suggest MarketComparisonPanel
  // If mentions "show military activity", suggest MilitaryPanel
  // If mentions "check risks", suggest RiskScorePanel
  
  return [
    { type: 'suggest-widget', label: 'Compare Markets', prefill: '...' },
  ];
}
```

### Pattern 4: Real-Time Updates

```typescript
// Keep JARVIS context fresh during conversation
export class JarvisRefreshManager {
  subscribeToContextChanges(callback) {
    // Watch for:
    // - New military activity
    // - Market price changes
    // - Breaking news
    // - Risk score updates
    
    // Automatically append to conversation context
  }
}
```

### Pattern 5: Multi-Modal Input

```typescript
export class JarvisInputManager {
  async processInput(input) {
    // Text: direct query
    if (typeof input === 'string') {
      return input;
    }
    
    // Voice: transcribe first
    if (input.type === 'audio') {
      const text = await transcribeAudio(input);
      return text;
    }
    
    // Image: extract text (OCR) or search by image
    if (input.type === 'image') {
      const text = await ocrImage(input);
      return text;
    }
    
    // Document: parse and summarize
    if (input.type === 'document') {
      const summary = await summarizeDocument(input);
      return summary;
    }
  }
}
```

---

## Critical Conventions & Constraints

### Don't

- ❌ `fetch.bind(globalThis)` — use `(...args) => globalThis.fetch(...args)`
- ❌ `node:http`, `node:https`, `node:zlib` in Edge Functions
- ❌ `../server/` or `../src/` imports in Edge Functions
- ❌ Forget request-varying params in cache keys (data leakage)
- ❌ Stall Yahoo Finance without 150ms+ delays between requests
- ❌ Create new panel configs without updating variant files

### Do

- ✅ Include `User-Agent` header in server-side fetches
- ✅ Stagger Yahoo Finance requests by 150ms
- ✅ Add bootstrap hydration for new data sources in `api/bootstrap.js`
- ✅ Write `seed-meta:<key>` for health monitoring in seed scripts
- ✅ Include at least 3 lines of context when replacing code
- ✅ Run `make generate` after proto changes
- ✅ Update `.github/workflows/proto-check.yml` if needed

---

## File Reference Quick Navigation

### Core Application
- `src/App.ts` — Main app class (8-phase initialization)
- `src/app/app-context.ts` — Central AppContext type definition
- `src/components/Panel.ts` — Base Panel class
- `src/components/ChatAnalystPanel.ts` — Existing chat UI

### API & RPC
- `api/chat-analyst.ts` — Chat streaming endpoint
- `server/gateway.ts` — Vercel Edge gateway factory
- `server/worldmonitor/*/v1/handler.ts` — Domain handlers
- `src/services/rpc-client.ts` — Base RPC utilities

### Services & Data
- `src/services/market/index.ts` — Example service (market data)
- `src/services/ml-worker.ts` — ONNX model manager
- `src/services/analysis-worker.ts` — Clustering & correlation
- `src/app/data-loader.ts` — Main data loading orchestration
- `src/app/refresh-scheduler.ts` — Polling & refresh logic

### Proto & Generated Code
- `proto/buf.yaml` — Buf CLI config
- `proto/worldmonitor/*/v1/service.proto` — Service definitions
- `src/generated/client/` — Generated RPC clients
- `src/generated/server/` — Generated message types
- `Makefile` — `make generate` target

### Desktop
- `src-tauri/src/main.rs` — Tauri shell
- `src-tauri/sidecar/local-api-server.mjs` — Node.js sidecar
- `src/services/runtime.ts` — Fetch patching for desktop

### Configuration
- `src/config/variants/` — Variant configs (full, tech, finance, etc.)
- `src/config/panels.ts` — All 86 panel definitions
- `src/config/map-layer-definitions.ts` — Map layer specs

### Testing
- `tests/edge-functions.test.mjs` — Edge function guardrails
- `e2e/` — Playwright E2E specs
- `.husky/pre-push` — Pre-push hook (typecheck, esbuild, lint)

---

## Summary

WorldMonitor's architecture is sophisticated but well-organized:

1. **Component Model**: 86 Panel subclasses with shared base, event delegation, localStorage persistence
2. **State Management**: Central mutable `AppContext` with event-based subscriptions (no Redux)
3. **Service Layer**: 120+ domain services using generated RPC clients with circuit breakers
4. **RPC Contract**: Protocol Buffers + sebuf → auto-generated TypeScript clients
5. **API Layer**: Vercel Edge Functions (self-contained) + Server layer (bundled) + Gateway factory
6. **Caching**: 4-tier hierarchy (bootstrap → memory → Redis → upstream) with stampede protection
7. **AI Infrastructure**: SSE streaming chat, ONNX ML worker, context assembly pattern
8. **Data Refresh**: Smart polling with viewport awareness, tab pause, exponential backoff
9. **Desktop**: Tauri shell + Node.js sidecar + fetch patching for local API
10. **Variants**: Config-driven UI variants (tech, finance, commodity, happy)

**For JARVIS integration**, the most effective approach is to:
- Extend the existing Chat Analyst pattern (SSE streaming)
- Add new proto RPC endpoints for JARVIS-specific logic
- Leverage the ML worker for embeddings/sentiment/NER
- Use the context assembly pattern to gather rich decision-making data
- Extend AppContext for JARVIS state management
- Follow the service pattern for client-side orchestration
