# WorldMonitor Architecture Exploration

## 1. Panel Component Base Structure & Lifecycle

### Panel Base Class (`src/components/Panel.ts`)

The `Panel` class is the foundational abstract class for all 86+ UI components. It's a class-based component system (not React/Preact based, despite the Preact build) that manages its own DOM lifecycle.

**Constructor & Key Properties:**
```typescript
interface PanelOptions {
  id: string;                    // Unique identifier (e.g., 'economic', 'news')
  title: string;                 // Display title
  showCount?: boolean;           // Show item count badge
  className?: string;            // CSS classes
  trackActivity?: boolean;       // Track panel activity/novelty
  infoTooltip?: string;         // Methodology tooltip (HTML)
  premium?: 'locked' | 'enhanced';  // Paywall gate
  closable?: boolean;            // User can close panel
  collapsible?: boolean;         // User can minimize panel
  defaultRowSpan?: number;       // Grid height (1-4 rows)
}
```

**Key Properties & State:**
- `element`: Root HTMLElement
- `content`: HTMLElement container for panel body
- `header`: Panel header with title, badges, controls
- `countEl`: Optional count badge (e.g., "News: 24")
- `statusBadgeEl`: Data freshness badge ("live", "cached", "unavailable")
- `_fetching`: Boolean flag tracking load state
- `_locked`: Boolean for paywall lock state
- `_collapsed`: Boolean for minimized state

**Core Lifecycle Methods:**

1. **`showLoading()`** — Renders spinner, called by panel subclasses during initial fetch
2. **`setContent(html: string, debounceMs?: number)`** — Debounced DOM update (150ms default); subclasses call this to render results
3. **`setDataBadge(state, detail)`** — Sets "live · 2s ago", "cached", or "unavailable" badge
4. **`setSeverity(level)`** — Sets colored severity dot: 'critical', 'high', 'medium', 'low', 'none'
5. **`showGatedCta(reason)`** — Renders "Sign In to Unlock" / "Upgrade to Pro" overlay
6. **`unlockPanel()`** — Removes gate overlay, restores original content
7. **`showRetry(callback, attemptNum)`** — Retry button with countdown timer (backoff)
8. **`destroy()`** — Cleanup: abort pending fetches, remove DOM, clear listeners

**Sizing & Persistence:**
- Panels persist user-resized dimensions to localStorage (`worldmonitor-panel-spans`, `worldmonitor-panel-col-spans`)
- Supports 1-4 row spans and 1-3 column spans
- Resize handles use mouse/touch with debounced frame updates
- Double-click resize handle resets to default size
- Closed/minimized state stored in `worldmonitor-panel-collapsed`

**Premium & Gating:**
- Checks `PanelGateReason` at render time (web-specific `WEB_PREMIUM_PANELS`, Clerk-only `WEB_CLERK_PRO_ONLY_PANELS`)
- Saves content snapshot (`_savedContent`) when showing lock, restores on unlock (preserves subclass DOM references)

**Common Subclass Pattern:**
```typescript
export class StatusPanel extends Panel {
  constructor() {
    super({ id: 'status', title: 'Status', showCount: true });
    this.init();
  }
  
  private init(): void {
    // Set up initial state, event listeners
  }
  
  async load(): Promise<void> {
    this.showLoading();
    try {
      const data = await fetchStatus();
      this.renderStatus(data);
      this.setDataBadge('live', '5s ago');
    } catch (e) {
      this.showRetry(() => this.load(), 1);
    }
  }
  
  private renderStatus(data: StatusData): void {
    const html = `<div>${data.items.map(item => 
      `<div>${escapeHtml(item.name)}</div>`
    ).join('')}</div>`;
    this.setContent(html);
  }
}
```

---

## 2. Data-Loader Architecture

### DataLoaderManager (`src/app/data-loader.ts`)

The data-loader is the orchestration layer that coordinates async data fetching for all panels. It's a state machine that manages panel callbacks, retry logic, circuit breakers, and hierarchical refresh scheduling.

**Design Principles:**
- **No blocking**: All fetches are non-blocking async; UI remains interactive
- **Coalescing**: Multiple concurrent requests to same endpoint use a single network call
- **Circuit breaking**: Failed data sources get cooldown periods (5–30 min depending on tier)
- **Fallback cascades**: When a primary feed fails, fall back to per-feed backups, then cached digests
- **Debouncing**: Heavy operations like news clustering debounced to prevent thrashing

**Data Flow:**

```
App.ts
  ↓
DataLoaderManager.init()
  ├─ Registers panel load callbacks
  ├─ Sets up refresh scheduler (60s interval default)
  └─ Subscribes to framework changes (market, brief)
       ↓
       loadAllData() / loadPanel(key)
         ├─ Calls panel.load() or enqueuePanelCall()
         ├─ Each panel fetches via services
         ├─ Services use cachedFetchJson() + Redis memoization
         └─ Panel.setContent() + setDataBadge()
```

**Key Methods:**

1. **`loadAllData(): Promise<void>`** — Master orchestrator; loads all visible panels in dependency order
   - News digest (base feed resolution)
   - Markets (stocks, commodities, crypto)
   - Intelligence signals (conflicts, protests, military)
   - Specialized panels (economic, climate, etc.)
   - Runs ~60s on startup, repeats on interval

2. **`loadPanel(key: string): Promise<void>`** — Load a single panel by ID
   - Used for on-demand opens, targeted refresh
   - Example: `loadPanel('economic')` → calls `panels['economic'].load()`

3. **`tryFetchDigest()`** — Central news aggregator
   - Fetches unified feed digest from `/api/news/v1/list-feed-digest`
   - Circuit breaker with 5m cooldown on failure
   - Cascades to cached digest if network fails
   - Result memoized for news panels to avoid duplicate fetches

4. **`loadNews()`** — Renders news into NewsPanel
   - Clusters headlines with ML worker (`clusterNewsHybrid()`)
   - Enriches with threat classification, geolocation
   - Dedupes against OREF breaking alerts
   - Supports time-range filtering (1h, 24h, 7d)

5. **`loadMarkets()`** — Stocks, commodities, crypto
   - Fetches from user's watchlist
   - Calls `fetchMultipleStocks()`, `fetchCommodityQuotes()`, etc.
   - Each has own circuit breaker

6. **`loadIntelligence()`** — Military, conflicts, protests
   - Aggregates conflicts (UCDP, ACLED), protests, military flights/vessels
   - Runs geo-convergence analysis (detects clusters near critical infrastructure)
   - Updates CII (Country Instability Index) scores
   - Calls `ingestProtests()`, `ingestFlights()`, etc. to update country-instability service

7. **Panel Call Enqueueing** — Asynchronous panel mounting
   - If panel not yet instantiated, calls are queued in `pending-panel-data`
   - When panel mounts, queued calls replay automatically
   - Example: NewsPanel.load() queued before panel constructor runs

**Circuit Breaker Pattern:**
```typescript
private digestBreaker = { 
  state: 'closed' | 'open' | 'half-open',
  failures: 0, 
  cooldownUntil: 0 
};

// On failure count ≥ 2: state='open', cooldown 5min
// During cooldown: return cached result
// After cooldown: state='half-open', try once
// On success: state='closed', reset failures
```

**Caching Tiers:**
- **Fast cache (5m)**: Real-time data (markets, outages, flights)
- **Medium cache (10m)**: Feed aggregation, analysis
- **Slow cache (30m)**: Economic indicators, climate anomalies
- **Static cache (2h)**: Geometry, ports, bases
- **Daily cache (24h)**: IMF WEO, JODI, historical data

---

## 3. Main UI Layout & State Management

### PanelLayoutManager (`src/app/panel-layout.ts`)

The layout system manages panel instantiation, grid rendering, user interactions (drag, resize, close), and dynamic access control based on entitlements.

**Panel Registry:**
- 86+ panels defined in `src/config/panels.ts`
- Each variant (full, tech, finance, etc.) has a subset in `VARIANT_DEFAULTS`
- Free tier limited to `FREE_MAX_PANELS=12`, `FREE_MAX_SOURCES=3`

**Panel Gating (Paywall):**
```typescript
const WEB_PREMIUM_PANELS = new Set([
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'market-implications',
  'deduction',
  'chat-analyst',
  'wsb-ticker-scanner',
  'latest-brief',
  'regional-intelligence',
  'trade-policy',
]);

const WEB_CLERK_PRO_ONLY_PANELS = new Set([
  'latest-brief',  // Must have Clerk auth (not just API key)
]);
```

**Layout Rendering:**

1. **`renderLayout(): Promise<void>`** — Master init
   - Instantiates all visible panels for current variant
   - Injects into grid DOM
   - Applies saved user preferences (spans, collapsed, custom order)
   - Mounts critical warning banner (e.g., OREF alerts)

2. **Grid Structure:**
   ```html
   <div class="panels-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
     <div class="panel span-2 col-span-2">
       <div class="panel-header">
         <div class="panel-header-left">
           <span class="panel-title">News</span>
           <span class="panel-severity-dot"></span>
         </div>
         <span class="panel-data-badge">live · 3s ago</span>
         <span class="panel-count">24</span>
         <button class="panel-close-btn">×</button>
       </div>
       <div class="panel-content" id="newsContent"><!-- Rendered by panel --></div>
       <div class="panel-resize-handle"></div>
       <div class="panel-col-resize-handle"></div>
     </div>
   </div>
   ```

3. **Panel Lifecycle in Layout:**
   - `mountPanel(panelId)` → new Panel() → injects into grid
   - User opens Country Brief → `openCountryBrief(code)` → modal overlay (CountryDeepDivePanel)
   - User closes panel → `closePanel(panelId)` → removes from DOM, cleans up listeners
   - Panel unmounts on variant switch → destroyAllPanels()

**State Management & Context:**

`AppContext` (src/app/app-context.ts) is the global state tree:

```typescript
export interface AppContext {
  map: MapContainer | null;                      // Deck.gl map instance
  readonly isMobile: boolean;
  readonly isDesktopApp: boolean;                // Tauri desktop or browser
  readonly container: HTMLElement;               // Root mount point

  panels: Record<string, Panel>;                 // panel[id] = instance
  newsPanels: Record<string, NewsPanel>;        // Convenience subset
  panelSettings: Record<string, PanelConfig>;   // Saved prefs (size, order, hidden)

  mapLayers: MapLayers;                         // CII choropleth, conflict zones, etc.

  allNews: NewsItem[];                          // Aggregated headlines
  newsByCategory: Record<string, NewsItem[]>;   // Partitioned by feed
  latestMarkets: MarketData[];                  // Stock/commodity quotes
  latestPredictions: PredictionMarket[];        // Polymarket data
  latestClusters: ClusteredEvent[];             // Geo-clustered events (conflicts, protests)
  intelligenceCache: IntelligenceCache;         // Flights, vessels, earthquakes, etc.

  disabledSources: Set<string>;                 // User-disabled feeds
  currentTimeRange: TimeRange;                  // 1h | 24h | 7d
}
```

**Event Delegation:**

Panels communicate via custom events:

```typescript
// Panel A: Emit
window.dispatchEvent(new CustomEvent('wm-market-watchlist-changed', {
  detail: { symbol: 'NVDA', action: 'add' }
}));

// DataLoaderManager: Listen
this.boundMarketWatchlistHandler = () => {
  void this.loadMarkets().then(async () => {
    if (hasPremiumAccess()) {
      await this.loadStockAnalysis();
    }
  });
};
window.addEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler);
```

**User Interaction Handlers:**

1. **Drag/Reorder** (not yet fully implemented for panels):
   - Grid uses CSS Grid layout; manual drag would require custom JS
   - Currently panels have fixed order per variant

2. **Resize** (vertical & horizontal):
   - Mouse/touch handlers on resize handles
   - Converts pixel deltas to grid span deltas (80px per span)
   - Persists to localStorage on mouseUp

3. **Close**:
   - Remove from DOM
   - Emit `wm-panel-closed` event (optional)
   - Update panelSettings

4. **Collapse**:
   - Toggle `_collapsed` flag
   - Hide content, show only header
   - Persist to localStorage

5. **Search/Filter**:
   - SearchManager opens modal
   - User types query
   - Dispatches `wm-search-input` event
   - Panels that support search receive callbacks (e.g., NewsPanel filters by keyword)

---

## 4. Country/Geo Data Structures & ISO Codes

### Country Geometry Service (`src/services/country-geometry.ts`)

Core geo-lookup service using **ISO 3166-1 alpha-2** codes (2-letter: US, CN, RU, etc.).

**Data Structure:**

```typescript
interface IndexedCountryGeometry {
  code: string;                      // ISO-2: "US", "GB", "JP"
  name: string;                      // Full name: "United States"
  bbox: [number, number, number, number];  // [minLon, minLat, maxLon, maxLat]
  polygons: [number, number][][][];  // GeoJSON coordinates
}
```

**Loaded from:**
- Primary: `public/data/countries.geojson` (shipped with build)
- Overrides: `https://maps.worldmonitor.app/country-boundary-overrides.geojson` (Natural Earth, 3s timeout)
- Political override: `POLITICAL_OVERRIDES['CN-TW'] = 'TW'` (Taiwan as separate)

**Key Functions:**

1. **`preloadCountryGeometry(): Promise<void>`** — Load and index all countries
   - Called at App startup
   - Normalizes codes (extracts `ISO3166-1-Alpha-2` property from GeoJSON features)
   - Builds `iso3ToIso2` map: ISO-3 → ISO-2 (e.g., "USA" → "US")
   - Builds `nameToIso2` map: Country name → ISO-2 (with aliases: "DR Congo" → "CD")
   - Indexes by bbox for point-in-polygon queries

2. **`getCountryAtCoordinates(lon: number, lat: number): {code, name} | null`**
   - Ray-casting point-in-polygon test
   - Used for reverse geocoding in panels (e.g., click on map → open country brief)

3. **`iso3ToIso2Code(iso3: string): string | null`** — Normalize "USA" → "US"
4. **`nameToCountryCode(name: string): string | null`** — Lookup "Russia" → "RU"
5. **`getCountryNameByCode(code: string): string | null`** — Lookup "JP" → "Japan"
6. **`matchCountryNamesInText(text: string): string[]`** — Extract country codes from article text

**Political Boundary Handling:**

```typescript
const POLITICAL_OVERRIDES: Record<string, string> = {
  'CN-TW': 'TW',  // Taiwan treated as separate country
};

function normalizeCode(properties): string | null {
  const rawCode = properties['ISO3166-1-Alpha-2'] ?? properties.ISO_A2;
  const trimmed = rawCode.trim().toUpperCase();
  return POLITICAL_OVERRIDES[trimmed] ?? trimmed;
}
```

**Name Aliases (Common Misspellings):**

```typescript
const NAME_ALIASES: Record<string, string> = {
  'dr congo': 'CD',
  'czech republic': 'CZ',
  'ivory coast': 'CI',
  'uae': 'AE',
  'uk': 'GB',
  'usa': 'US',
  'south korea': 'KR',
  'north korea': 'KP',
};
```

### Country Instability Index (`src/services/country-instability.ts`)

Real-time risk scoring system keyed by ISO-2 country code.

**CountryScore Type:**

```typescript
export interface CountryScore {
  code: string;              // ISO-2: "RU", "UA", "IL"
  name: string;
  score: number;             // 0–100 (0=peaceful, 100=critical)
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  trend: 'rising' | 'stable' | 'falling';
  change24h: number;         // Score delta in last 24h
  components: ComponentScores;
  lastUpdated: Date | null;
}

export interface ComponentScores {
  unrest: number;      // Protests, strikes (0–25)
  conflict: number;    // Armed conflict, UCDP events (0–25)
  security: number;    // Cyber, advisories, sanctions (0–25)
  information: number; // Internet outages, GPS jamming (0–25)
}
```

**Data Ingest Pipeline:**

The `ingestXxx()` functions consume raw events and update per-country totals:

```typescript
// Military flights in country
ingestFlights(militaryFlights: MilitaryFlight[])
  // Count by country, weighted by operator/type

// Conflict events (UCDP, ACLED)
ingestConflicts(events: ConflictEvent[])
  // Tally deaths, casualties, severity

// Protests & strikes
ingestProtests(events: SocialUnrestEvent[])
  // Count by country

// Internet outages
ingestOutagesForCII(outages: InternetOutage[])
  // Mark outages per country

// GPS jamming, cyber threats, advisories
ingestGpsJammingForCII()
ingestCyberThreatsForCII()
ingestAdvisoriesForCII()
```

**Scoring Model:**

```typescript
score = baselineRisk[country] 
  + (conflicts.length * eventMultiplier[country])
  + (protests.length * 2)
  + (militaryFlights.length * 0.5)
  + (outages.length * 3)
  + ...other factors
```

**Curated Country Config:**

`src/config/countries.ts` defines per-country baseline risk and event weighting:

```typescript
export const CURATED_COUNTRIES: Record<string, CuratedCountryConfig> = {
  RU: {
    name: 'Russia',
    scoringKeywords: ['russia', 'moscow', 'kremlin', 'putin'],
    baselineRisk: 35,      // Always 35 before events
    eventMultiplier: 2.0,  // Each event worth 2× weight
  },
  CN: {
    name: 'China',
    baselineRisk: 25,
    eventMultiplier: 2.5,
  },
  UA: {
    name: 'Ukraine',
    baselineRisk: 50,      // Sustained conflict → high baseline
    eventMultiplier: 0.8,  // Less sensitive to daily events
  },
  // ... 20+ more
};
```

**Hotspot & Conflict Zone Configs:**

`src/config/geo.ts` defines critical regions and their focal points:

```typescript
export const INTEL_HOTSPOTS = [
  { code: 'UA', region: 'donbas', lat: 48.0, lon: 38.0, radiusKm: 150 },
  { code: 'IL', region: 'gaza', lat: 31.9, lon: 34.5, radiusKm: 50 },
  { code: 'IR', region: 'strait-hormuz', lat: 26.5, lon: 56.5, radiusKm: 100 },
  // ...
];

export const STRATEGIC_WATERWAYS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, code: 'IR/OM' },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, code: 'TW/CN' },
  // ...
];
```

### Country Brief Panel Data Structures

**CountryBriefPanel** opens a detail modal with multi-tab data:

```typescript
export interface CountryIntelData {
  brief: string;                // LLM-generated intel summary
  country: string;              // Full name: "Ukraine"
  code: string;                 // ISO-2: "UA"
  cached?: boolean;
  generatedAt?: string;
  error?: string;
  reason?: string;              // Why unavailable (e.g., "gated content")
}

export interface CountryDeepDiveSignalItem {
  type: 'MILITARY' | 'PROTEST' | 'CYBER' | 'DISASTER' | 'OUTAGE' | 'OTHER';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
  timestamp: Date;
}

export interface CountryEnergyProfileData {
  // Energy mix: coal%, gas%, oil%, nuclear%, renewables%
  coalShare: number;
  gasShare: number;
  // ... 30+ fields for electricity, storage, imports/exports
}
```

**Economic Indicators Service:**

`src/services/imf-country-data.ts` fetches IMF WEO data keyed by ISO-2:

```typescript
export interface ImfCountryBundle {
  macro: ImfMacroEntry | null;      // Inflation, debt, reserves
  growth: ImfGrowthEntry | null;    // GDP growth, investment
  labor: ImfLaborEntry | null;      // Unemployment, population
  external: ImfExternalEntry | null; // Trade, current account
  fetchedAt: number;
}

// Data indexed by ISO-2 code in Redis:
// imfMacro:{code} → { inflationPct, govRevenuePct, ... }
```

---

## 5. Panel Data Fetching & Caching Example: StrategicPosturePanel

A complex panel that aggregates military flights, vessels, and bases to assess escalation risk.

### Design:

StrategicPosturePanel fetches from 4+ services, each with independent circuit breakers:

```typescript
export class StrategicPosturePanel extends Panel {
  async load(): Promise<void> {
    this.showLoading();
    try {
      // Parallel fetch: all 4 services at once
      const [flights, vessels, bases, posture] = await Promise.all([
        this.fetchFlights(),
        this.fetchVessels(),
        this.fetchBases(),
        this.fetchPosture(),
      ]);
      
      this.renderTheaterView(flights, vessels, bases, posture);
      this.setDataBadge('live', '12s ago');
    } catch (e) {
      this.showRetry(() => this.load(), 1);
    }
  }

  private async fetchFlights(): Promise<MilitaryFlight[]> {
    // Calls service which uses circuit breaker
    return fetchMilitaryFlights({
      signal: this.abortController.signal
    });
  }

  private async fetchVessels(): Promise<MilitaryVessel[]> {
    return fetchMilitaryVessels({
      signal: this.abortController.signal
    });
  }

  private async fetchBases(): Promise<MilitaryBase[]> {
    // Cached for 24h: geo never changes
    return MILITARY_BASES_EXPANDED;
  }

  private async fetchPosture(): Promise<TheaterPostureSummary[]> {
    // Aggregates flights/vessels by theater, compares to baseline
    return fetchCachedTheaterPosture({
      signal: this.abortController.signal
    });
  }

  private renderTheaterView(
    flights: MilitaryFlight[],
    vessels: MilitaryVessel[],
    bases: MilitaryBase[],
    posture: TheaterPostureSummary[]
  ): void {
    const html = posture.map(theater => `
      <div class="theater">
        <h3>${escapeHtml(theater.name)}</h3>
        <div class="stats">
          <span>Flights: ${theater.flightCount}</span>
          <span class="trend ${theater.trend}">${theater.trend}</span>
        </div>
        ${flights.filter(f => isInTheater(f, theater)).map(f => `
          <div class="flight">
            <span>${escapeHtml(f.operator)}</span>
            <span>${f.type}</span>
          </div>
        `).join('')}
      </div>
    `).join('');
    
    this.setContent(html);
  }
}
```

### Service-Level Caching:

**fetchMilitaryFlights** (src/services/military-flights.ts):

```typescript
const MILITARY_FLIGHTS_CACHE_MS = 5 * 60 * 1000;  // 5 min

export async function fetchMilitaryFlights(opts?: FetchOpts): Promise<MilitaryFlight[]> {
  const rpcUrl = toApiUrl('/api/intelligence/v1/list-military-flights');
  
  // Circuit breaker + deduping
  return cachedFetchJson<ListMilitaryFlightsResponse>(
    rpcUrl,
    { signal: opts?.signal },
    MILITARY_FLIGHTS_CACHE_MS,  // TTL
    (data) => data.flights ?? []  // Result selector
  );
}
```

**cachedFetchJson** (src/services/cached-*.ts):

```typescript
export async function cachedFetchJson<T>(
  url: string,
  init: RequestInit,
  ttlMs: number,
  selector: (data: unknown) => unknown
): Promise<unknown> {
  // 1. Check Redis cache key: md5(url)
  const cacheKey = `fetch:${md5(url)}`;
  const cached = await redis.get(cacheKey);
  if (cached && !isStale(cached.storedAt, ttlMs)) {
    console.log('[Cache HIT]', url);
    return selector(cached.data);
  }

  // 2. Coalesce: if request already in-flight, wait for it
  if (inFlightRequests.has(url)) {
    return inFlightRequests.get(url)!;
  }

  // 3. New request
  const promise = (async () => {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      
      // 4. Store in Redis
      await redis.set(cacheKey, { data, storedAt: Date.now() }, { ex: Math.ceil(ttlMs / 1000) });
      return selector(data);
    } finally {
      inFlightRequests.delete(url);
    }
  })();

  inFlightRequests.set(url, promise);
  return promise;
}
```

### Circuit Breaker in Data-Loader:

If `fetchMilitaryFlights()` fails 2×, cooldown 30m:

```typescript
export class DataLoaderManager {
  private militaryFlightsBreaker = { 
    state: 'closed', 
    failures: 0, 
    cooldownUntil: 0 
  };

  private async loadIntelligence(): Promise<void> {
    // Check breaker state
    const now = Date.now();
    if (this.militaryFlightsBreaker.state === 'open') {
      if (now < this.militaryFlightsBreaker.cooldownUntil) {
        console.warn('[Circuit Open] Military flights cooling down');
        return; // Skip fetch, leave stale data on screen
      }
      this.militaryFlightsBreaker.state = 'half-open';
    }

    try {
      const flights = await fetchMilitaryFlights();
      // Update country-instability
      ingestFlights(flights);
      this.militaryFlightsBreaker = { state: 'closed', failures: 0, cooldownUntil: 0 };
    } catch (e) {
      this.militaryFlightsBreaker.failures++;
      if (this.militaryFlightsBreaker.failures >= 2) {
        this.militaryFlightsBreaker.state = 'open';
        this.militaryFlightsBreaker.cooldownUntil = now + 30 * 60 * 1000;
      }
      console.error('[Fetch Failed] Military flights:', e);
    }
  }
}
```

### Aggregation Example: Military Surge Analysis

**military-surge.ts** combines flights + vessels + bases to detect escalations:

```typescript
export interface TheaterPostureSummary {
  id: string;                      // 'middle-east'
  name: string;                    // 'Middle East / Persian Gulf'
  baselineFlights: number;         // Historical avg
  currentFlights: number;
  surgeFactor: number;             // currentFlights / baselineFlights
  flightTrend: 'rising' | 'stable' | 'falling';
  nearbyBases: string[];
  timeSeriesDataPoints: TheaterActivity[];  // Last 7 days
}

export async function analyzeFlightsForSurge(
  flights: MilitaryFlight[]
): Promise<{ surgeAlerts: SurgeAlert[]; theaters: Map<string, TheaterActivity> }> {
  const byTheater = new Map<string, TheaterActivity>();

  // Cluster flights by theater (geographic region)
  for (const flight of flights) {
    const theater = findTheaterForFlight(flight);
    if (!theater) continue;

    const activity = byTheater.get(theater.id) ?? {
      theaterId: theater.id,
      timestamp: Date.now(),
      transportCount: 0,
      fighterCount: 0,
      reconCount: 0,
      totalMilitary: 0,
      flightIds: [],
    };

    if (flight.type === 'transport') activity.transportCount++;
    else if (flight.type === 'fighter') activity.fighterCount++;
    else if (flight.type === 'reconnaissance') activity.reconCount++;

    activity.totalMilitary++;
    activity.flightIds.push(flight.id);
    byTheater.set(theater.id, activity);
  }

  // Detect surges vs. historical baseline
  const surgeAlerts: SurgeAlert[] = [];
  for (const [theaterId, activity] of byTheater) {
    const baseline = calculateBaselineForTheater(theaterId);
    if (activity.totalMilitary > baseline * 1.5) {
      surgeAlerts.push({
        id: `surge-${theaterId}-${Date.now()}`,
        theater: THEATERS.find(t => t.id === theaterId)!,
        type: activity.fighterCount > activity.transportCount ? 'fighter' : 'airlift',
        currentCount: activity.totalMilitary,
        baselineCount: baseline,
        surgeMultiple: activity.totalMilitary / baseline,
        aircraftTypes: new Map(),
        nearbyBases: findNearbyBases(activity),
        firstDetected: new Date(),
        lastUpdated: new Date(),
      });
    }
  }

  return { surgeAlerts, theaters: byTheater };
}

function findTheaterForFlight(flight: MilitaryFlight): MilitaryTheater | null {
  // Geo-spatial search: which theater contains this lat/lon?
  for (const theater of THEATERS) {
    const dist = haversineDistanceKm(flight.lat, flight.lon, theater.centerLat, theater.centerLon);
    if (dist < 1000) return theater; // Rough radius, actual impl more sophisticated
  }
  return null;
}
```

---

## Architecture Summary Table

| Component | Type | Key Files | Responsibility |
|---|---|---|---|
| **Panel** | Base Class | `src/components/Panel.ts` | DOM lifecycle, resize, paywall gates |
| **Panel Subclass** | Subclass | `src/components/EconomicPanel.ts` | Fetch data, render UI, respond to user input |
| **DataLoaderManager** | Orchestrator | `src/app/data-loader.ts` | Schedule panel loads, circuit breakers, cascading fallbacks |
| **RefreshScheduler** | Scheduler | `src/app/refresh-scheduler.ts` | 60s interval loop, refresh all panels |
| **PanelLayoutManager** | Layout Engine | `src/app/panel-layout.ts` | Grid layout, panel gating, user interactions |
| **Service** | Data Layer | `src/services/market/`, `src/services/military-`, etc. | Fetch from RPC, Redis cache, circuit break |
| **AppContext** | State Container | `src/app/app-context.ts` | Global singleton: panels, news, markets, cache |
| **CountryGeometry** | Geo Library | `src/services/country-geometry.ts` | ISO-2 lookup, point-in-polygon, normalize names |
| **CountryInstability** | Scoring | `src/services/country-instability.ts` | Real-time CII scores, ingest multi-source events |
| **API Layer** | Edge Functions | `api/*.js`, `api/*/index.js` | Vercel serverless, no imports from `src/` |

---

## Key Design Patterns

### 1. **Abort Controller Cleanup**
Every async panel operation stores an AbortController:
```typescript
private abortController: AbortController = new AbortController();

async load() {
  const resp = await fetch(url, { signal: this.abortController.signal });
}

destroy() {
  this.abortController.abort(); // Cancel all pending fetches on unmount
}
```

### 2. **Debounced Content Rendering**
Panels batch rapid updates to avoid thrashing:
```typescript
setContent(html: string, debounceMs = 150) {
  this.pendingContentHtml = html;
  clearTimeout(this.contentDebounceTimer);
  this.contentDebounceTimer = setTimeout(() => {
    replaceChildren(this.content, safeHtml(this.pendingContentHtml));
  }, debounceMs);
}
```

### 3. **Coalesced Caching**
Multiple concurrent requests to the same URL merge into one network call:
```typescript
const inFlightRequests = new Map<string, Promise<unknown>>();

if (inFlightRequests.has(url)) {
  return inFlightRequests.get(url)!; // Reuse pending request
}
```

### 4. **Enqueued Panel Calls**
Before a panel instance exists, data-loader queues method calls:
```typescript
enqueuePanelCall('news', 'load', []);
// Later, when NewsPanel mounts:
replayPendingCalls('news'); // Plays back load()
```

### 5. **Multi-Service Aggregation**
Complex panels orchestrate multiple independent services in parallel:
```typescript
const [flights, vessels, bases, posture] = await Promise.all([
  fetchMilitaryFlights(),
  fetchMilitaryVessels(),
  getBases(), // Static
  fetchCachedTheaterPosture(),
]);
```

---

## Data Flow Diagram

```
User Action (load page / click country)
  ↓
App.ts: initAppContext() → DataLoaderManager.init()
  ↓
PanelLayoutManager.renderLayout() → mount 12+ panels
  ↓
DataLoaderManager.loadAllData()
  ├─ Panel A: load() → fetchService1() → cachedFetchJson() → Redis hit/miss → setContent()
  ├─ Panel B: load() → fetchService2,3,4() → all in parallel → aggregate → setContent()
  ├─ Panel C: load() → fetchService5() → circuit breaker open → use cached result
  └─ ...
      ↓
AppContext.panels[id] / allNews / latestMarkets / intelligenceCache updated
  ↓
RefreshScheduler: every 60s → loadAllData() again
  ↓
User drag/resize panel → localStorage persist → next load restores
User click map → countryGeometry.getCountryAtCoordinates() → open CountryBriefPanel
User search → SearchManager → broadcast to panels → NewsPanel.filterByKeyword()
```

This architecture supports:
- **86+ concurrently-loadable panels** with independent lifecycle
- **30+ external data sources** aggregated via services
- **Real-time geo-risk scoring** (CII) across 195 countries
- **Circuit breaker cascade** preventing cascade failures
- **Browser-local & Redis caching** tiers
- **Fully responsive UI** with user-persisted preferences
