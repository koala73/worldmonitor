# Documentation Roadmap — World Monitor

> **Purpose**: Comprehensive task list to bring project documentation to production-grade quality for AI agent-assisted development. Each task is scoped, self-contained, and AI-actionable.
>
> **Status legend**: `[ ]` Not started · `[-]` In progress · `[x]` Done

---

## 1. Foundation & Project Overview

### 1.1 README.md Overhaul

- [x] Update version badge to current release (currently shows outdated version)
- [x] Add Finance Monitor variant to the variant table with correct subdomain
- [x] Refresh architecture ASCII diagram to include Finance variant data flow
- [x] Add "Repository Structure" section with annotated directory tree
- [x] Update Quick Start section with current prerequisites (Node.js version, npm/pnpm)
- [x] Add badges: CI status, test coverage, license, deployment status
- [x] Add a "For AI Agents" section explaining how to navigate the codebase programmatically
- [x] Verify all internal doc links resolve correctly (anchors, file paths)

### 1.2 Create `.env.example`

- [x] Audit all `process.env` / `import.meta.env` references across the codebase
- [x] Create `.env.example` with every environment variable, grouped by service
- [x] Add inline comments explaining each variable's purpose, format, and where to obtain keys
- [x] Document which variables are required vs optional and their defaults
- [x] Document variant-specific variables (`VITE_VARIANT`, variant-conditional env vars)

### 1.3 Create `CONTRIBUTING.md`

- [x] Code style & conventions (TypeScript strict, no-framework vanilla TS, class-based components)
- [x] Branch naming strategy (`feat/`, `fix/`, `docs/`, etc.)
- [x] Commit message format
- [x] PR process and review checklist
- [x] How to add a new panel (step-by-step)
- [x] How to add a new API endpoint (step-by-step)
- [x] How to add a new data source / service
- [x] How to add a new map layer
- [x] How to add a new locale
- [x] Coding patterns: circuit breaker usage, caching strategy, error handling

### 1.4 Create `SECURITY.md`

- [x] Vulnerability reporting process (email, timeline, scope)
- [x] Security architecture overview (CSP, API key handling, Tauri permissions)
- [x] Supported versions for security patches
- [x] Known security boundaries (client-side ML, proxy endpoints, rate limiting)

---

## 2. Architecture Documentation

### 2.1 Create `docs/ARCHITECTURE.md`

- [x] High-level system diagram (Mermaid): Browser ↔ Vercel Edge ↔ External APIs ↔ Redis
- [x] Variant architecture: how `VITE_VARIANT` controls config tree-shaking and panel registration
- [x] Data flow diagram: RSS ingestion → clustering → classification → display pipeline
- [x] Signal intelligence pipeline: source → normalization → correlation → aggregation → scoring
- [x] Map rendering pipeline: MapLibre base → deck.gl overlay → layer toggle → popup system
- [x] Caching architecture: Upstash Redis → Vercel CDN (s-maxage) → Service Worker → IndexedDB
- [x] Desktop architecture: Tauri shell → Node.js sidecar → local API server → OS keychain
- [x] ML pipeline: Groq API → OpenRouter fallback → browser Transformers.js (T5/NER/embeddings)
- [x] Error handling hierarchy: circuit breaker → retry → fallback → graceful degradation

### 2.2 Create `docs/DATA_MODEL.md`

- [x] Document all TypeScript interfaces from `src/types/index.ts` (1,297 lines) with prose descriptions
- [x] Entity model: `Entity`, `EntityType`, multi-index lookup strategy
- [x] News item lifecycle: raw RSS → parsed → clustered → classified → scored → displayed
- [x] Signal model: `Signal`, `SignalType`, correlation rules, aggregation
- [x] Map data models: layers, features, popups, deck.gl props
- [x] Panel state model: position, size, visibility, persistence
- [x] Variant config model: `VariantConfig`, base → override chain
- [x] Risk scoring models: CII, composite risk, hotspot escalation, theater posture
- [x] Cache entry schemas (Redis key patterns, TTLs, serialization)

### 2.3 Create `docs/STATE_MANAGEMENT.md`

- [x] Document application state flow (no framework — manual class-based state)
- [x] `App.ts` state properties and their lifecycle (4,332 lines — needs mapping)
- [x] Panel state persistence (localStorage keys, URL state encoding)
- [x] Theme state management (light/dark, CSS custom properties)
- [x] IndexedDB storage schema (playback snapshots, persistent cache)
- [x] URL state encoding/decoding (`urlState.ts`) — query params for sharing
- [x] Runtime config state (desktop feature toggles via `runtime-config.ts`)
- [x] Activity tracking and idle detection (`activity-tracker.ts`)

---

## 3. API Reference

### 3.1 Create `docs/API_REFERENCE.md`

- [x] Document all 60+ Vercel Edge Functions with:
  - HTTP method, path, query parameters
  - Request/response schemas (TypeScript interfaces or JSON examples)
  - Cache headers and TTLs
  - Rate limiting behavior
  - External API dependencies and required env vars
  - Error response format
- [x] Group endpoints by domain:
  - **Geopolitical**: acled, acled-conflict, ucdp, ucdp-events, gdelt-doc, gdelt-geo, nga-warnings
  - **Markets & Finance**: finnhub, yahoo-finance, coingecko, stablecoin-markets, etf-flows, stock-index, fred-data, macro-signals
  - **Military & Security**: opensky, ais-snapshot, theater-posture, cyber-threats
  - **Natural Events**: earthquakes, firms-fires, climate-anomalies
  - **AI/ML**: classify-batch, classify-event, groq-summarize, openrouter-summarize, arxiv
  - **Infrastructure**: cloudflare-outages, service-status, faa-status
  - **Humanitarian**: unhcr-population, hapi, worldpop-exposure, worldbank
  - **Content**: rss-proxy, hackernews, github-trending, tech-events
  - **Prediction**: polymarket
  - **Meta**: version, cache-telemetry, debug-env, download, og-story, story
  - **Proxy/Passthrough**: eia, pizzint, wingbits, youtube
- [x] Document shared middleware modules: `_cors.js`, `_cache-telemetry.js`, `_ip-rate-limit.js`, `_upstash-cache.js`
- [x] Document the RSS domain allowlist and proxy security model

### 3.2 Create `docs/EXTERNAL_APIS.md`

- [x] Catalog every external API the system calls (30+ sources)
- [x] For each: base URL, auth method, rate limits, data format, fallback behavior
- [x] Document API key requirements and which tier/plan is needed
- [x] Map external API → env var → API endpoint → frontend service
- [x] Document degradation behavior when each API is unavailable

---

## 4. Component Documentation

### 4.1 Create `docs/COMPONENTS.md`

- [x] Document all 45+ components in `src/components/`:
  - Purpose and user-facing behavior
  - Constructor parameters and configuration
  - DOM structure and CSS classes
  - Events emitted/consumed
  - Data sources (which services it calls)
  - Variant visibility (World / Tech / Finance)
- [x] Document the `Panel` base class: drag, resize, collapse, persistence
- [x] Document `DeckGLMap.ts`: layer registration, WebGL rendering, interaction handlers
- [x] Document `Map.ts` and `MapContainer.ts`: MapLibre setup, region controls, popup system
- [x] Document `VirtualList.ts`: virtual scrolling implementation details
- [x] Document `SearchModal.ts`: Cmd+K search, fuzzy matching, result ranking

### 4.2 Create `docs/PANELS.md`

- [x] List all panels with screenshots/descriptions per variant
- [x] Document panel registration system (`src/config/panels.ts`)
- [x] Document default panel layouts per variant
- [x] Document panel configuration options (position, size, default visibility)
- [x] Document panel persistence (which settings survive page reload)

---

## 5. Services Documentation

### 5.1 Create `docs/SERVICES.md`

- [ ] Document all 70+ services in `src/services/`:
  - Purpose and responsibility
  - Public API (exported functions/classes)
  - Dependencies (other services, config, external APIs)
  - Caching strategy (Redis / IndexedDB / in-memory)
  - Refresh intervals and polling behavior
  - Error handling and fallback chains
- [ ] Group services by domain:
  - **Intelligence Analysis**: `analysis-core`, `signal-aggregator`, `correlation`, `focal-point-detector`, `hotspot-escalation`, `trending-keywords`, `threat-classifier`
  - **Data Ingestion**: `rss`, `conflicts`, `earthquakes`, `climate`, `ais`, `markets`, etc.
  - **ML/AI**: `ml-worker`, `ml-capabilities`, `summarization`, `entity-extraction`, `clustering`
  - **Geospatial**: `country-geometry`, `geo-convergence`, `geo-activity`, `geo-hub-index`, `reverse-geocode`
  - **Military**: `military-flights`, `military-surge`, `military-vessels`
  - **Infrastructure**: `infrastructure-cascade`, `cable-activity`, `outages`, `data-freshness`
  - **Platform**: `runtime`, `tauri-bridge`, `runtime-config`, `i18n`, `persistent-cache`, `storage`
  - **Content**: `story-data`, `story-renderer`, `story-share`, `meta-tags`

### 5.2 Document Key Algorithms

- [ ] **News Clustering** (`clustering.ts`): Jaccard + semantic similarity, threshold tuning
- [ ] **Threat Classification** (`threat-classifier.ts`): hybrid keyword + LLM pipeline
- [ ] **Signal Correlation** (`correlation.ts`): cross-source pattern matching logic
- [ ] **Hotspot Escalation** (`hotspot-escalation.ts`): 4-signal scoring methodology
- [ ] **Country Instability Index** (`country-instability.ts`): 22-country CII computation
- [ ] **Temporal Baseline** (`temporal-baseline.ts`): Welford's online algorithm for anomaly detection
- [ ] **Trending Keywords** (`trending-keywords.ts`): 2h vs 7d window spike detection
- [ ] **Infrastructure Cascade** (`infrastructure-cascade.ts`): BFS propagation model
- [ ] **Geo-Convergence** (`geo-convergence.ts`): 1°×1° cell multi-source convergence
- [ ] **Macro Signals** (api `macro-signals.js`): 7-signal radar BUY/CASH methodology
- [ ] **Circuit Breaker** (`utils/circuit-breaker.ts`): per-feed failure tracking, 5-min cooldown

---

## 6. Configuration Documentation

### 6.1 Create `docs/CONFIGURATION.md`

- [ ] Document variant system (`src/config/variant.ts`): detection logic, hostname → variant mapping
- [ ] Document config hierarchy: `variants/base.ts` → `variants/full.ts` / `tech.ts` / `finance.ts`
- [ ] Document all static data configs with entry counts and data structure:
  - `entities.ts` (600+ entries, multi-index)
  - `feeds.ts` (150+ RSS feeds, tier/type/propaganda risk)
  - `geo.ts` (hotspots, conflict zones, nuclear sites, cables, waterways)
  - `bases-expanded.ts` (220+ military bases)
  - `finance-geo.ts` (92 exchanges, 19 centers, 13 CBs, 10 commodity hubs)
  - `airports.ts` (monitored airports + FAA data)
  - `pipelines.ts` (88 oil/gas pipelines)
  - `ports.ts` (83 strategic ports)
  - `ai-datacenters.ts` (111 AI datacenter locations)
  - `ai-regulations.ts`, `ai-research-labs.ts`, `startup-ecosystems.ts`, `tech-companies.ts`
  - `gulf-fdi.ts` (64 Saudi/UAE FDI investments)
  - `irradiators.ts` (gamma irradiator locations)
  - `markets.ts` (symbols, sectors, commodities)
  - `military.ts` (military entity data)
  - `ml-config.ts` (ML model configuration)
- [ ] Document panel/layer default configs (`panels.ts`) per variant
- [ ] Document the `beta.ts` feature flag system

### 6.2 Update `docs/DESKTOP_CONFIGURATION.md`

- [ ] Verify all 17 desktop secret keys are current
- [ ] Add screenshots of the settings window
- [ ] Document the keychain storage backend (OS-specific behavior)
- [ ] Document the sidecar startup sequence and health check
- [ ] Document offline/degraded mode behavior per missing key

---

## 7. Deployment & Operations

### 7.1 Create `docs/DEPLOYMENT.md`

- [ ] **Vercel deployment**: step-by-step from fork to production
  - Environment variable setup (complete list with values/format)
  - Domain configuration for 3 variants
  - Build settings and variant-specific builds
  - Cache and CDN behavior
- [ ] **Railway deployment**: WebSocket relay + RSS proxy setup
- [ ] **Redis (Upstash)** setup: database creation, connection string, key namespaces
- [ ] **DNS configuration**: subdomain routing for variants
- [ ] **CI/CD pipeline**: build → test → deploy flow
- [ ] **Monitoring**: Sentry setup, Vercel Analytics, cache telemetry dashboard
- [ ] **Rollback procedure**: version pinning, instant rollback via Vercel

### 7.2 Update `docs/RELEASE_PACKAGING.md`

- [ ] Verify all desktop packaging steps are current for Tauri 2
- [ ] Add automated release workflow documentation (if exists)
- [ ] Document code signing certificate management
- [ ] Document auto-update mechanism (if implemented)
- [ ] Add release QA checklist with specific test scenarios

### 7.3 Create `docs/SELF_HOSTING.md`

- [ ] Full self-hosting guide (non-Vercel deployment)
- [ ] Docker setup (if applicable, or document creating one)
- [ ] Nginx configuration (reference `deploy/nginx-worldmonitor.conf`)
- [ ] SystemD service setup (reference `deploy/worldmonitor-api.service`)
- [ ] Environment variable configuration for self-hosted
- [ ] SSL/TLS setup
- [ ] Performance tuning recommendations

---

## 8. Internationalization (i18n)

### 8.1 Create `docs/I18N.md`

- [ ] Document all 14 supported locales: en, fr, de, es, it, pt, nl, sv, pl, ru, ar, zh, ja, he
- [ ] Document i18n key structure and naming conventions
- [ ] Document the translation workflow (how to add/update translations)
- [ ] Document RTL support (`rtl-overrides.css`) for Arabic 
- [ ] Guide for adding a new locale (files to create, registration, testing)
- [ ] Document translation completeness per locale (which keys are missing)
- [ ] Document language detection and fallback chain
- [ ] Document date/number/currency formatting per locale

---

## 9. Testing Documentation

### 9.1 Create `docs/TESTING.md`

- [ ] Document testing strategy and philosophy
- [ ] **E2E tests** (Playwright):
  - Test file inventory and what each covers
  - How to run tests per variant (`test:e2e`, `test:e2e:tech`, `test:e2e:finance`)
  - Visual regression: golden screenshot workflow, update process
  - WebGL testing setup (SwiftShader, headless Chromium)
  - Map harness system (`src/e2e/`, `tests/map-harness.html`)
- [ ] **Unit tests** (Node.js test runner):
  - Test file inventory
  - How to run (`test:data`)
  - Coverage targets
- [ ] **API tests**:
  - `_cors.test.mjs`, `cyber-threats.test.mjs`
  - How to run API-level tests
- [ ] **Manual test scenarios** for features that can't be automated
- [ ] How to write new tests (templates, patterns, assertions)
- [ ] CI integration: how tests run in CI, failure handling

---

## 10. Map & Geospatial Documentation

### 10.1 Create `docs/MAP_SYSTEM.md`

- [ ] Document MapLibre GL JS base map setup and style configuration
- [ ] Document deck.gl 3D globe integration and WebGL layer system
- [ ] Document all map layers with toggle keys and data sources:
  - Military bases, conflict zones, nuclear sites, hotspots
  - Subsea cables, waterways, pipelines, ports, airports
  - AI datacenters, tech HQs, cloud regions
  - Financial exchanges, commodity hubs, central banks
  - AIS vessels, military flights, fire detection
  - Risk heatmaps, population exposure, climate anomalies
- [ ] Document the popup system (`MapPopup.ts`): click handling, content generation
- [ ] Document the region control system and geographic focus
- [ ] Document playback mode: time slider, snapshot storage, historical data
- [ ] Document layer performance considerations (feature count limits, LOD)
- [ ] Document coordinate systems and projection handling

---

## 11. PWA & Offline

### 11.1 Create `docs/PWA.md`

- [ ] Document Service Worker configuration (Workbox via vite-plugin-pwa)
- [ ] Document caching strategies per resource type (NetworkFirst, CacheFirst, StaleWhileRevalidate)
- [ ] Document offline fallback page (`public/offline.html`)
- [ ] Document precache manifest and runtime cache rules
- [ ] Document update flow: new version detection, prompt, activation
- [ ] Document chunk reload strategy (`bootstrap/chunk-reload.ts`)

---

## 12. Developer Workflow

### 12.1 Create `docs/DEVELOPER_GUIDE.md`

- [ ] IDE setup: VS Code recommended extensions, settings
- [ ] Local development: `npm run dev` → `dev:tech` → `dev:finance`
- [ ] Debugging: browser DevTools, Tauri DevTools, API endpoint testing
- [ ] Hot module replacement behavior and limitations
- [ ] Build process: `npm run build` variants, output structure
- [ ] Preview builds: `npm run preview` and Vercel preview deployments
- [ ] Common development tasks:
  - Adding a new panel end-to-end
  - Adding a new API endpoint
  - Adding a new map layer
  - Adding a new data source
  - Modifying the entity registry
  - Updating RSS feeds
- [ ] Performance profiling: deck.gl frame budget, DOM node count, memory
- [ ] Troubleshooting common issues

### 12.2 Create `docs/AI_AGENT_GUIDE.md`

- [ ] Codebase navigation map for AI agents (key entry points, where to find what)
- [ ] File naming conventions and patterns
- [ ] Import/export patterns (`@/` alias, barrel exports)
- [ ] Class-based component pattern (no framework, vanilla TS)
- [ ] How services are initialized and wired together in `App.ts`
- [ ] Configuration lookup paths per variant
- [ ] Common modification patterns with examples:
  - "Add a new panel" → files to create/modify
  - "Add a new API endpoint" → files to create/modify
  - "Add a new map layer" → files to create/modify
  - "Fix a data source" → where to look
  - "Update styling" → CSS custom properties in `main.css`
- [ ] Testing expectations after changes
- [ ] Known gotchas and pitfalls (e.g., tree-shaking with variant configs, circular deps)
- [ ] File size warnings (App.ts: 4,332 lines, types/index.ts: 1,297 lines)

---

## 13. Existing Doc Updates

### 13.1 Update `docs/DOCUMENTATION.md`

- [ ] Update version badge from v2.1.4 to current version
- [ ] Add Finance Monitor variant documentation (panels, features, data sources)
- [ ] Refresh panel inventory to match current `src/components/` directory
- [ ] Update entity count (verify 600+ is current)
- [ ] Update feed count (verify 150+ is current)
- [ ] Verify all code references and file paths are current
- [ ] Add missing components: `ETFFlowsPanel`, `MacroSignalsPanel`, `StablecoinPanel`, `InvestmentsPanel`, `RegulationPanel`, `TechEventsPanel`, `TechHubsPanel`, `TechReadinessPanel`, `PlaybackControl`, `RuntimeConfigPanel`
- [ ] Update signal intelligence section with current algorithms
- [ ] Cross-reference with new architecture docs to avoid duplication

### 13.2 Update `CHANGELOG.md`

- [ ] Ensure all changes since v2.4.0 are documented
- [ ] Add entries for UI customizations on `feat/ui-customizations-worldmonitor` branch
- [ ] Standardize changelog format (Keep a Changelog)
- [ ] Add links to relevant PRs/commits

### 13.3 Review & Update Other Docs

- [ ] `docs/local-backend-audit.md` — Verify sidecar handler parity matrix is current
- [ ] `docs/NEWS_TRANSLATION_ANALYSIS.md` — Mark as implemented or still pending
- [ ] `docs/TAURI_VALIDATION_REPORT.md` — Update with latest Tauri 2 findings

---

## 14. Supplementary Documentation

### 14.1 Create `docs/GLOSSARY.md`

- [ ] Define domain-specific terms: CII, ACLED, UCDP, GDELT, FIRMS, GDACS, EONET, FRED, EIA
- [ ] Define technical terms: deck.gl, MapLibre, Transformers.js, Workbox, sidecar
- [ ] Define project-specific terms: focal point, signal, hotspot escalation, cascade, theater posture
- [ ] Define abbreviations: NER, NGA, UNHCR, HAPI, IOC, APT, CVE, OG

### 14.2 Create `docs/DATA_SOURCES.md`

- [ ] Catalog all 30+ external data sources with:
  - Full name and URL
  - Data type (geopolitical, military, economic, climate, etc.)
  - Update frequency
  - API key requirement (yes/no, which env var)
  - Data license / terms of use
  - Reliability tier (primary, secondary, fallback)
  - Which panel/service consumes it
- [ ] Document data freshness expectations per source (`data-freshness.ts`)
- [ ] Document fallback chains when primary sources fail

### 14.3 Create `docs/TROUBLESHOOTING.md`

- [ ] Common build errors and fixes
- [ ] API endpoint debugging (missing env vars, rate limits, CORS)
- [ ] Map rendering issues (WebGL context loss, layer conflicts)
- [ ] Desktop app issues (sidecar startup, keychain access, CSP)
- [ ] PWA issues (stale cache, update not applying)
- [ ] Performance issues (memory leaks, slow rendering)
- [ ] i18n issues (missing keys, RTL layout)

---

## 15. Documentation Infrastructure

### 15.1 Documentation Standards

- [ ] Create `docs/DOCS_STYLE_GUIDE.md` — formatting, tone, naming, linking conventions
- [ ] Add doc linting (markdownlint config) to CI
- [ ] Add link checker to CI (verify all internal doc links resolve)
- [ ] Add table of contents generation for long documents
- [ ] Create doc index page (`docs/INDEX.md`) linking all documentation files

### 15.2 Diagrams

- [ ] Create Mermaid architecture diagram (system-level)
- [ ] Create Mermaid data flow diagram (ingestion → display pipeline)
- [ ] Create Mermaid component hierarchy diagram
- [ ] Create Mermaid service dependency graph
- [ ] Create Mermaid deployment topology diagram
- [ ] Store diagrams as `.mmd` files or inline in relevant docs

---

## Prioritization Guide

| Priority | Tasks | Rationale |
|----------|-------|-----------|
| **P0 — Critical** | 1.2 `.env.example`, 2.1 Architecture, 12.2 AI Agent Guide | Unblocks AI agent development immediately |
| **P1 — High** | 1.3 Contributing, 3.1 API Reference, 5.1 Services, 6.1 Configuration | Core reference for any code changes |
| **P2 — Medium** | 2.2 Data Model, 4.1 Components, 9.1 Testing, 10.1 Map System, 12.1 Dev Guide | Deeper understanding for complex changes |
| **P3 — Standard** | 7.1 Deployment, 8.1 i18n, 11.1 PWA, 13.x Updates, 14.2 Data Sources | Operational completeness |
| **P4 — Nice to Have** | 1.4 Security, 14.1 Glossary, 14.3 Troubleshooting, 15.x Infrastructure | Polish and maintenance |

---

## Execution Notes for AI Agents

1. **Always read the source code** before writing documentation — do not guess or hallucinate
2. **Use `src/types/index.ts`** as the single source of truth for data models
3. **Use `src/config/`** as the source of truth for all static data and variant configuration
4. **Cross-reference `App.ts`** (4,332 lines) for how services and components are wired together
5. **Each doc task is independent** — tasks can be parallelized across agents
6. **Verify file paths** against the actual workspace before referencing them
7. **Include code examples** from the actual codebase, not invented examples
8. **Keep docs DRY** — reference other docs instead of duplicating content
9. **Use Mermaid** for all diagrams (renders natively in GitHub)
10. **Target audience**: senior developers and AI coding agents working on the codebase
