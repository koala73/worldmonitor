# WorldMonitor: Complete System Audit for Macroeconomics Retooling

> Comprehensive analysis of information organization, infrastructure, loose ends, and architectural patterns — from an agentic AI builder perspective.

---

## 1. SYSTEM OVERVIEW

WorldMonitor is a **real-time geopolitical intelligence dashboard** built as a vanilla TypeScript SPA (no React/Vue/Angular). It ingests 100+ data sources, performs client-side ML clustering, and renders a multi-panel + WebGL map interface.

### Key Stats
| Metric | Count |
|--------|-------|
| Proto definitions | 93 files |
| Generated RPC clients/servers | 34 files |
| Services (business logic) | 79 files |
| UI Components | 52 files |
| Config/static data | 28 files |
| Server handlers | 79 files |
| Edge functions (API) | 18 files |
| Types (index.ts) | 1,275 lines |
| Main orchestrator (App.ts) | 4,597 lines |
| Stylesheet (main.css) | 15,252 lines |
| Supported languages | 17 |

---

## 2. INFORMATION ORGANIZATION STRUCTURE

### 2.1 The Domain Model (17 Verticals)

The system organizes information across these domains, each with its own types, services, config, and UI panels:

| # | Domain | Types | Service Files | Config | Panels | RPC Service |
|---|--------|-------|---------------|--------|--------|-------------|
| 1 | **News/RSS** | `NewsItem`, `ClusteredEvent`, `VelocityMetrics` | `rss.ts`, `clustering.ts`, `threat-classifier.ts`, `trending-keywords.ts` | `feeds.ts` (100+ sources) | NewsPanel, LiveNewsPanel, RegionalNews | `news/v1` |
| 2 | **Geopolitical Conflicts** | `ConflictZone`, `UcdpGeoEvent`, `Hotspot` | `conflict/index.ts`, `hotspot-escalation.ts` | `geo.ts` (30+ hotspots) | IntelFeed, UCDPPanel | `conflict/v1` |
| 3 | **Social Unrest** | `SocialUnrestEvent`, `ProtestCluster` | `unrest/index.ts` | — | ProtestPanel | `unrest/v1` |
| 4 | **Military Aviation** | `MilitaryFlight`, `MilitaryFlightCluster` | `military-flights.ts`, `military-surge.ts` | `airports.ts`, `bases-expanded.ts` | FlightsPanel, PosturePanel | `military/v1` |
| 5 | **Naval/Maritime** | `MilitaryVessel`, `MilitaryVesselCluster`, `AisDisruptionEvent` | `military-vessels.ts`, `usni-fleet.ts` | — | VesselsPanel, FleetPanel | `maritime/v1` |
| 6 | **Undersea Cables** | `UnderseaCable`, `CableAdvisory`, `CableHealthRecord` | `cable-activity.ts`, `cable-health.ts` | cable config files | CascadePanel | `infrastructure/v1` |
| 7 | **Pipelines/Energy Infra** | `Pipeline`, `PipelineTerminal`, `ShippingChokepoint` | `infrastructure-cascade.ts` | `pipelines.ts` | CascadePanel | `infrastructure/v1` |
| 8 | **Markets/Equities** | `MarketData`, `Sector`, `MarketSymbol` | `market/index.ts` | `markets.ts` | MarketPanel | `market/v1` |
| 9 | **Crypto** | `CryptoData` | `market/index.ts` | `markets.ts` | CryptoPanel | `market/v1` |
| 10 | **Economic Indicators** | `FredSeries`, `OilMetric` | `economic/index.ts` | — | EconomicPanel | `economic/v1` |
| 11 | **Cyber Threats** | `CyberThreat`, `APTGroup` | `cyber/` | — | CyberPanel | `cyber/v1` |
| 12 | **Climate/Weather** | `ClimateAnomaly`, `NaturalEvent` | `climate/index.ts`, `eonet.ts`, `weather.ts` | — | ClimatePanel | `climate/v1` |
| 13 | **Wildfires** | `FireDetection` | `wildfires/index.ts` | — | SatelliteFiresPanel | `wildfire/v1` |
| 14 | **Seismology** | `Earthquake` | (via RPC) | — | — | `seismology/v1` |
| 15 | **Displacement** | `CountryDisplacement`, `DisplacementFlow` | `displacement/index.ts` | — | DisplacementPanel | `displacement/v1` |
| 16 | **Tech/AI** (variant) | `AIDataCenter`, `AIRegulation`, `TechCompany` | — | `ai-datacenters.ts`, `ai-regulations.ts`, `tech-geo.ts` | Tech panels | — |
| 17 | **Finance** (variant) | `GulfInvestment`, various | — | `finance-geo.ts`, `gulf-fdi.ts` | Finance panels | — |

### 2.2 Cross-Cutting Analytical Layers

These aren't domains but **synthesis engines** that aggregate across domains:

| Layer | File | What It Does |
|-------|------|--------------|
| **Country Instability Index (CII)** | `country-instability.ts` | Weighted risk score per country from protests + conflicts + military + outages + climate |
| **Signal Aggregator** | `signal-aggregator.ts` | Cross-domain signal convergence by country/region |
| **Geo-Convergence** | `geo-convergence.ts` | Spatial intersection of multi-type events within radius |
| **Focal Point Detector** | `focal-point-detector.ts` | Entity-level intelligence synthesis (countries, companies, commodities) |
| **Infrastructure Cascade** | `infrastructure-cascade.ts` | Dependency graph traversal for cable/pipeline failure scenarios |
| **Hotspot Escalation** | `hotspot-escalation.ts` | Dynamic escalation scoring for predefined hotspots |
| **Temporal Baseline** | `temporal-baseline.ts` | Anomaly detection vs. 7/30-day historical averages |
| **Trending Keywords** | `trending-keywords.ts` | Topic velocity detection with suppressed common terms |

### 2.3 Three-Variant Architecture

Single codebase, three products via `VITE_VARIANT`:

| Variant | Domain | Panels | Map Layers | Feeds |
|---------|--------|--------|------------|-------|
| `full` | Geopolitical intelligence | 50+ | All 30+ layers | Politics, gov, intel, finance, tech |
| `tech` | AI/startup ecosystem | ~25 | Tech-specific | AI, startups, VC, cybersecurity |
| `finance` | Markets & macro | ~25 | Finance-specific | Markets, central banks, commodities |

---

## 3. INFRASTRUCTURE ARCHITECTURE

### 3.1 Build & Deploy Stack

```
Vite (build) → Vercel (hosting) + Tauri (desktop)
   ├── Proto (Sebuf) → codegen → client/server stubs
   ├── Web Workers (ML + clustering)
   ├── PWA (service worker, offline)
   └── Brotli precompression
```

- **Build**: Vite with custom plugins (proto codegen, Brotli, Tauri compat)
- **Deploy**: Vercel (serverless edge functions + static)
- **Desktop**: Tauri (Rust-based, with native window management)
- **RPC**: Sebuf protocol (proto-based, HTTP transport)
- **Workers**: 2 web workers (analysis + ML embedding)

### 3.2 Data Fetching Architecture

```
                    ┌─────────────────┐
                    │   Browser App   │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐      ┌──────▼──────┐      ┌─────▼──────┐
   │ Direct   │      │ RPC Client  │      │ WebSocket  │
   │ RSS/API  │      │ (Sebuf)     │      │ Relay      │
   └────┬─────┘      └──────┬──────┘      └─────┬──────┘
        │                    │                    │
        │             ┌──────▼──────┐      ┌─────▼──────┐
        │             │ Vercel Edge │      │ Railway    │
        │             │ Functions   │      │ Relay      │
        │             └──────┬──────┘      └─────┬──────┘
        │                    │                    │
   ┌────▼────────────────────▼────────────────────▼──────┐
   │              External APIs (30+)                     │
   │  FRED, EIA, Finnhub, ACLED, UCDP, NASA FIRMS,      │
   │  OpenSky, AISStream, Cloudflare, CoinGecko,         │
   │  USGS, UNHCR, GDELT, Feodo, etc.                   │
   └─────────────────────────────────────────────────────┘
```

### 3.3 State Management (No Library)

State lives across multiple layers with **no centralized store**:

| Layer | Mechanism | Contents | Persistence |
|-------|-----------|----------|-------------|
| **Service memory** | Module-level variables | Caches, circuit breaker state, in-flight data | None (lost on refresh) |
| **App instance** | `App` class properties | All panels, news, monitors, map state | None |
| **localStorage** | Key-value | Panel spans, theme, language, variant, monitors, settings | Persistent |
| **IndexedDB** | Structured | Baselines (temporal), snapshots, RSS cache | Persistent |
| **URL params** | Query string | Map view, zoom, center, layers, country | Shareable |

### 3.4 Fault Tolerance

| Pattern | Implementation | Coverage |
|---------|---------------|----------|
| **Circuit Breakers** | `circuit-breaker.ts` (3 failures → 5min cooldown) | All RPC calls, RSS feeds |
| **Persistent Cache** | `persistent-cache.ts` (IndexedDB) | RSS feeds, Polymarket |
| **Fallback Values** | Per-service defaults | Markets, crypto, economic data |
| **4-Layer Retry** | Direct → Tauri → Railway → Sebuf | Polymarket (Cloudflare bypass) |
| **WebGL Fallback** | DeckGL → SVG map | Map rendering |
| **Worker Fallback** | Main thread clustering if worker fails | Analysis |

---

## 4. LOOSE ENDS & ISSUES

### 4.1 Architectural Issues (Critical for Retooling)

| # | Issue | Location | Impact | Recommendation |
|---|-------|----------|--------|----------------|
| 1 | **God Object: App.ts (4,597 lines)** | `src/App.ts` | All orchestration, state, rendering, event handling in one class. Impossible to test, extend, or compose with agents. | Decompose into: AppShell, DataOrchestrator, PanelManager, MapController, EventBus |
| 2 | **No centralized state management** | Scattered across services | State is fragmented across module-level vars, localStorage, IndexedDB. No reactive data flow. No way for an agent to observe/mutate state. | Introduce a pub/sub event bus or minimal store (Zustand-like) |
| 3 | **No event bus / message system** | Everywhere | Components communicate via direct method calls on App. No decoupled messaging. Agents can't subscribe to events. | Add EventEmitter/MessageBus for domain events |
| 4 | **Monolithic CSS (15,252 lines)** | `src/styles/main.css` | All styles in one file. Hard to scope, override, or theme for macro variants. | Split per component/domain or adopt CSS modules |
| 5 | **No dependency injection** | Services import each other directly | Tight coupling. Can't swap implementations. Can't mock for testing. | Service registry / DI container pattern |
| 6 | **No test infrastructure** | Playwright config exists but no unit tests | Zero test coverage. Refactoring is blind. | Add Vitest + component tests before retooling |

### 4.2 Data Model Gaps (For Macroeconomics)

| # | Missing/Weak | Current State | What Macroeconomics Needs |
|---|-------------|---------------|--------------------------|
| 1 | **Central Bank Policy** | No dedicated type/service | Interest rate decisions, QE/QT tracking, forward guidance parsing, dot plots |
| 2 | **Yield Curves** | No bond data | Treasury yields (2Y/10Y/30Y), yield curve inversion detection, term premium |
| 3 | **FX / Currency Pairs** | Minimal | DXY, major pairs, carry trade signals, intervention detection |
| 4 | **Labor Market** | Only FRED unemployment | NFP, JOLTS, initial claims, wage growth, labor force participation |
| 5 | **Inflation Decomposition** | Only CPI via FRED | Core PCE, PPI, breakevens, components (shelter, energy, food), real-time inflation |
| 6 | **GDP / Output** | Not tracked | GDP nowcasting, industrial production, PMI/ISM, capacity utilization |
| 7 | **Trade / Balance of Payments** | Shipping chokepoints only | Trade balances, current account, tariff impact modeling, supply chain indices |
| 8 | **Fiscal Policy** | Not tracked | Government spending, debt/GDP, deficit tracking, CBO projections |
| 9 | **Credit / Lending** | Not tracked | Credit spreads (IG/HY), bank lending standards, consumer credit, delinquencies |
| 10 | **Housing** | Not tracked | Case-Shiller, housing starts, mortgage rates, affordability indices |
| 11 | **Sentiment / Surveys** | Only news sentiment | Consumer confidence, U of Michigan, CEO surveys, PMI expectations |
| 12 | **Cross-Country Macro** | Basic World Bank only | Comparative GDP, rates, inflation across economies (G7, G20, EM) |
| 13 | **Economic Calendar** | Not present | Scheduled releases with consensus, surprise indices, revision tracking |
| 14 | **Monetary Aggregates** | FRED has Fed balance sheet | M2, velocity, reserve balances, repo market stress |

### 4.3 Service-Level Issues

| # | Issue | File | Details |
|---|-------|------|---------|
| 1 | **TODO: AI flow settings migration** | `src/services/ai-flow-settings.ts:5` | Panel visibility, sources, language selector not migrated |
| 2 | **Focal points not consumed in UI** | `focal-point-detector.ts` | Computes focal points but no dedicated panel renders them fully |
| 3 | **ML sentiment not stored** | `ml-worker.ts` | ONNX sentiment available but results not persisted on NewsItem |
| 4 | **Parallel analysis workers unused** | `parallel-analysis.ts` | Workers defined but not actively used in panel layout |
| 5 | **Story renderer incomplete** | `story-renderer.ts` | Markdown rendering for intel briefs not fully integrated |
| 6 | **getHotspotContext() dead code** | `gdelt-intel.ts` | Defined but never called |
| 7 | **classifyWithAI() underutilized** | `threat-classifier.ts` | Requires GROQ/OpenRouter keys, limited usage path |
| 8 | **Memory leak risk** | `App.ts` refresh runners | Async runners without explicit cancellation on destroy |
| 9 | **Race condition** | `country-instability.ts` | Global mutable learning mode state can race with refresh cycles |
| 10 | **No map recovery** | `DeckGLMap.ts` | Fallback on init error but no recovery from runtime WebGL context loss |

### 4.4 Infrastructure Loose Ends

| # | Issue | Details |
|---|-------|---------|
| 1 | **93 proto files, no schema validation** | Proto types are generated but no runtime validation at boundaries |
| 2 | **API keys scattered** | 12+ API keys with no unified secrets management |
| 3 | **No rate limiting** | Edge functions don't rate-limit client requests |
| 4 | **No health check endpoint** | No `/api/health` for monitoring |
| 5 | **CORS proxy (`/api/rss-proxy.js`)** | Open proxy — potential abuse vector |
| 6 | **No CI/CD pipeline visible** | No GitHub Actions, no automated deployment config |
| 7 | **Displacement data is annual** | UNHCR data not real-time, stale for intelligence use |
| 8 | **Climate data 5+ day lag** | Open-Meteo ERA5 inherent delay |

---

## 5. FROM AN AGENTIC AI BUILDER PERSPECTIVE

### 5.1 What You Have That's Valuable

1. **Mature data ingestion pipeline** — 30+ APIs with circuit breakers, caching, fallbacks
2. **Proto-based RPC** — Clean client/server contract for every domain
3. **Real-time clustering & correlation** — Web Worker ML pipeline already works
4. **Multi-variant architecture** — Adding a `macro` variant is architecturally possible
5. **Intelligence synthesis layers** — CII, signal aggregation, focal points = composable
6. **The interface** — Custom panel grid + WebGL map is genuinely differentiated

### 5.2 What's Missing for Agentic AI

| Capability | Current State | What's Needed |
|-----------|---------------|---------------|
| **Agent loop** | None | A run loop where an AI agent can: observe state → decide → act → observe |
| **Tool definitions** | None (all logic in service functions) | Wrap services as callable tools with typed inputs/outputs |
| **Memory / context** | localStorage + IndexedDB (unstructured) | Structured memory: short-term (session), long-term (cross-session), episodic (event chains) |
| **Event stream** | No event bus | Observable event stream agents can subscribe to and react to |
| **Planning layer** | None | Goal decomposition, multi-step reasoning, priority queue |
| **Natural language interface** | Search modal only | Chat/prompt interface that routes to tools |
| **Evaluation / feedback** | No metrics on analysis quality | Track prediction accuracy, signal-to-noise, user engagement |
| **Multi-agent coordination** | N/A | If multiple agents (macro analyst, risk analyst, trade analyst), they need shared state + conflict resolution |

### 5.3 Recommended Architecture for Macro AI Agent System

```
┌──────────────────────────────────────────────────────┐
│                    UI LAYER                           │
│  Panel Grid + WebGL Map + Chat Interface             │
│  (keep existing, add chat/prompt panel)              │
└────────────────────┬─────────────────────────────────┘
                     │ Events ↑↓ State
┌────────────────────▼─────────────────────────────────┐
│                  EVENT BUS                            │
│  Domain events, state changes, agent messages        │
│  (new: central nervous system)                       │
└────────┬───────────┬──────────────┬──────────────────┘
         │           │              │
┌────────▼──┐  ┌─────▼────┐  ┌─────▼────────┐
│ AGENT     │  │ DATA     │  │ ANALYSIS     │
│ RUNTIME   │  │ SERVICES │  │ ENGINES      │
│           │  │          │  │              │
│ • Observe │  │ (existing│  │ (existing    │
│ • Plan    │  │  30+ API │  │  CII, focal  │
│ • Act     │  │  services│  │  points, etc)│
│ • Reflect │  │  + new   │  │  + new macro │
│           │  │  macro   │  │  models)     │
│ Tools:    │  │  feeds)  │  │              │
│ • fetch   │  │          │  │              │
│ • analyze │  │          │  │              │
│ • alert   │  │          │  │              │
│ • brief   │  │          │  │              │
└───────────┘  └──────────┘  └──────────────┘
                     │
              ┌──────▼──────┐
              │   MEMORY    │
              │ • Session   │
              │ • Long-term │
              │ • Episodic  │
              └─────────────┘
```

### 5.4 Retooling Priority Order

**Phase 1: Foundation (Do First)**
1. Decompose `App.ts` into composable modules
2. Add an EventBus / pub-sub system
3. Add a minimal reactive store (observable state)
4. Add Vitest with basic coverage

**Phase 2: Macro Data Layer**
5. Add macro-specific types (`YieldCurve`, `CentralBankDecision`, `EconomicRelease`, etc.)
6. Add FRED series expansion (yield curves, labor, inflation components)
7. Add economic calendar service
8. Add central bank tracking service
9. Create `macro` variant alongside existing `full/tech/finance`

**Phase 3: Agent Infrastructure**
10. Define tool interfaces wrapping existing services
11. Build agent runtime (observe → plan → act → reflect loop)
12. Add structured memory (IndexedDB-backed)
13. Add chat/prompt panel to UI
14. Wire agent to EventBus for reactive analysis

**Phase 4: Intelligence**
15. Macro-specific analytical models (recession probability, rate path, etc.)
16. Cross-economy comparative analysis
17. Narrative generation (macro briefings)
18. Backtesting framework using playback mode

---

## 6. FILE MANIFEST (Key Files to Understand)

### Entry Points
- `src/main.ts` — App bootstrap
- `src/App.ts` — Everything orchestrator (needs decomposition)

### Type System
- `src/types/index.ts` — All 1,275 lines of domain types

### Services (by priority for macro retooling)
- `src/services/economic/index.ts` — FRED, EIA, World Bank (expand this)
- `src/services/market/index.ts` — Stock/crypto quotes (expand for macro)
- `src/services/signal-aggregator.ts` — Cross-domain synthesis (compose with)
- `src/services/country-instability.ts` — Risk scoring (adapt for macro risk)
- `src/services/focal-point-detector.ts` — Entity intelligence (adapt for macro entities)
- `src/services/rss.ts` — News pipeline (add macro-focused feeds)
- `src/services/infrastructure-cascade.ts` — Dependency modeling (adapt for economic contagion)

### Config (data definitions)
- `src/config/panels.ts` — Panel registry per variant
- `src/config/feeds.ts` — RSS source registry
- `src/config/markets.ts` — Market symbols, sectors, commodities
- `src/config/variant.ts` — Variant detection logic
- `src/config/entities.ts` — Entity catalog

### Generated RPC
- `proto/worldmonitor/economic/v1/` — Economic protos (expand)
- `src/generated/client/worldmonitor/economic/v1/` — Economic client
- `server/worldmonitor/economic/v1/handler.ts` — Economic handler

### UI
- `src/components/Panel.ts` — Base panel class
- `src/components/DeckGLMap.ts` — WebGL map
- `src/components/SearchModal.ts` — Command palette
- `src/styles/main.css` — All styles (needs splitting)

---

## 7. SUMMARY

**What works well**: Data ingestion pipeline, RPC architecture, fault tolerance, multi-variant system, ML clustering, the interface.

**What needs work for macro retooling**: App.ts decomposition, event bus, reactive state, macro data types & services, agent runtime infrastructure.

**What's broken/incomplete**: Focal point UI integration, ML sentiment storage, parallel workers unused, AI flow settings migration, dead code in GDELT, memory leak risk in refresh runners.

**Bottom line**: The bones are excellent. The data pipeline and UI are production-grade. But the monolithic App.ts and lack of an event bus / reactive state are the main blockers for making this an agentic macroeconomics system. Fix those first, then the macro data layer and agent runtime can compose cleanly on top.
