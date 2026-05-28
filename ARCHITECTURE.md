# Architecture

> **Last verified**: 2026-03-14 against commit `24b502d0`
>
> **Ownership rule**: When deployment topology, API surface, desktop runtime, or bootstrap keys change, this document must be updated in the same PR.

> **Design philosophy**: For the "why" behind architectural decisions, intelligence tradecraft, and algorithmic choices, see [Design Philosophy](docs/architecture.mdx).

World Monitor is a real-time global intelligence dashboard built as a TypeScript single-page application. It aggregates data from dozens of external sources covering geopolitics, military activity, financial markets, cyber threats, climate events, maritime tracking, and aviation into a unified operational picture rendered through an interactive map and a grid of specialized panels.

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser / Desktop                        │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ DeckGLMap│  │ GlobeMap │  │  Panels    │  │  Workers     │  │
│  │(deck.gl) │  │(globe.gl)│  │(86 classes)│  │(ML, analysis)│  │
│  └────┬─────┘  └────┬─────┘  └─────┬──────┘  └──────────────┘  │
│       └──────────────┴──────────────┘                           │
│                         │ fetch /api/*                          │
└─────────────────────────┼───────────────────────────────────────┘
                          │
           ┌──────────────┼──────────────┐
           │              │              │
    ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼──────┐
    │   Vercel    │ │  Railway  │ │   Tauri    │
    │ Edge Funcs  │ │ AIS Relay │ │  Sidecar   │
    │ + Middleware│ │ + Seeds   │ │ (Node.js)  │
    └──────┬──────┘ └─────┬─────┘ └─────┬──────┘
           │              │              │
           └──────────────┼──────────────┘
                          │
                   ┌──────▼──────┐
                   │   Upstash   │
                   │    Redis    │
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼───┐ ┌─────▼───┐ ┌────▼────┐
        │ Finnhub │ │  Yahoo  │ │ ACLED   │
        │ OpenSky │ │  GDELT  │ │ UCDP    │
        │ CoinGeck│ │  FRED   │ │ FIRMS   │
        │   ...   │ │   ...   │ │   ...   │
        └─────────┘ └─────────┘ └─────────┘
              30+ upstream data sources
```

**Source files**: `package.json`, `vercel.json`

---

## 2. Deployment Topology

| Service | Platform | Role |
|---------|----------|------|
| SPA + Edge Functions | Vercel | Static files, API endpoints, middleware (bot filtering, social OG) |
| AIS Relay | Railway | WebSocket proxy (AIS stream), seed loops (market, aviation, GPSJAM, risk scores, UCDP, positive events), RSS proxy, OREF polling |
| Redis | Upstash | Cache layer with stampede protection, seed-meta freshness tracking, rate limiting |
| Convex | Convex Cloud | Contact form submissions, waitlist registrations |
| Documentation | Mintlify | Public docs, proxied through Vercel at `/docs` |
| Desktop App | Tauri 2.x | macOS (ARM64, x64), Windows (x64), Linux (x64, ARM64) with bundled Node.js sidecar |
| Container Image | GHCR | Multi-arch Docker image (nginx serving built SPA, proxies API to upstream) |

**Source files**: `vercel.json`, `docker/Dockerfile`, `scripts/ais-relay.cjs`, `convex/schema.ts`, `src-tauri/tauri.conf.json`

---

## 3. Frontend Architecture

### Entry and Initialization

`src/main.ts` initializes Sentry error tracking, Vercel analytics, dynamic meta tags, runtime fetch patches (desktop sidecar redirection), theme application, and creates the `App` instance.

`App.init()` runs in 8 phases:

1. **Storage + i18n**: IndexedDB, language detection, locale loading
2. **ML Worker**: ONNX model prep (embeddings, sentiment, summarization)
3. **Sidecar**: Wait for desktop sidecar readiness (desktop only)
4. **Bootstrap**: Two-tier concurrent hydration from `/api/bootstrap` (fast 3s + slow 5s timeouts)
5. **Layout**: PanelLayoutManager renders map and panels
6. **UI**: SignalModal, IntelligenceGapBadge, BreakingNewsBanner, correlation engine
7. **Data**: Parallel `loadAllData()` + viewport-conditional `primeVisiblePanelData()`
8. **Refresh**: Variant-specific polling intervals via `startSmartPollLoop()`

### Component Model

All panels extend the `Panel` base class. Panels render via `setContent(html)` (debounced 150ms) and use event delegation on a stable `this.content` element. Panels support resizable row/col spans persisted to localStorage.

### Dual Map System

- **DeckGLMap**: WebGL rendering via deck.gl + maplibre-gl. Supports ScatterplotLayer, GeoJsonLayer, PathLayer, IconLayer, PolygonLayer, ArcLayer, HeatmapLayer, H3HexagonLayer. PMTiles protocol for self-hosted basemap tiles. Supercluster for marker clustering.
- **GlobeMap**: 3D interactive globe via globe.gl. Single merged `htmlElementsData` array with `_kind` discriminator. Earth texture, atmosphere shader, auto-rotate after idle.

Layer definitions live in `src/config/map-layer-definitions.ts`, each specifying renderer support (flat/globe), premium status, variant filtering, and i18n keys.

### State Management

No external state library. `AppContext` is a central mutable object holding: map references, panel instances, panel/layer settings, all cached data (news, markets, predictions, clusters, intelligence caches), in-flight request tracking, and UI component references. URL state syncs bidirectionally via `src/utils/urlState.ts` (debounced 250ms).

### Web Workers

- **analysis.worker.ts**: News clustering (Jaccard similarity), cross-domain correlation detection
- **ml.worker.ts**: ONNX inference via `@xenova/transformers` (MiniLM-L6 embeddings, sentiment, summarization, NER), in-worker vector store for headline memory
- **vector-db.ts**: IndexedDB-backed vector store for semantic search

### Variant System

Detected by hostname (`tech.worldmonitor.app` → tech, `finance.worldmonitor.app` → finance, etc.) or localStorage on desktop. Controls: default panels, map layers, refresh intervals, theme, UI text. Variant change resets all settings to defaults.

**Source files**: `src/main.ts`, `src/App.ts`, `src/app/`, `src/components/Panel.ts`, `src/components/DeckGLMap.ts`, `src/components/GlobeMap.ts`, `src/config/variant.ts`, `src/workers/`

---

## 4. API Layer

### Edge Functions

All API endpoints live in `api/` as self-contained JavaScript files deployed as Vercel Edge Functions. They cannot import from `../src/` or `../server/` (different runtime). Only same-directory `_*.js` helpers and npm packages are allowed. This constraint is enforced by `tests/edge-functions.test.mjs` and the pre-push esbuild bundle check.

### Shared Helpers

| File | Purpose |
|------|---------|
| `_cors.js` | Origin allowlist (worldmonitor.app, Vercel previews, tauri://localhost, localhost) |
| `_rate-limit.js` | Upstash sliding window rate limiting, IP extraction |
| `_api-key.js` | Origin-aware API key validation (desktop requires key, trusted browser exempt) |
| `_relay.js` | Factory for proxying requests to Railway relay service |

### Gateway Factory

`server/gateway.ts` provides `createDomainGateway(routes)` for per-domain Edge Function bundles. Pipeline:

1. Origin check (403 if disallowed)
2. CORS headers
3. OPTIONS preflight
4. API key validation
5. Rate limiting (endpoint-specific, then global fallback)
6. Route matching (static Map lookup, then dynamic `{param}` scan)
7. POST-to-GET compatibility (for stale clients)
8. Handler execution with error boundary
9. ETag generation (FNV-1a hash) + 304 Not Modified
10. Cache header application

### Cache Tiers

| Tier | s-maxage | Use case |
|------|----------|----------|
| fast | 300s | Live event streams, flight status |
| medium | 600s | Market quotes, stock analysis |
| slow | 1800s | ACLED events, cyber threats |
| static | 7200s | Humanitarian summaries, ETF flows |
| daily | 86400s | Critical minerals, static reference data |
| no-store | 0 | Vessel snapshots, aircraft tracking |

### Domain Handlers

`server/worldmonitor/<domain>/v1/handler.ts` exports handler objects with per-RPC functions. Each RPC function uses `cachedFetchJson()` from `server/_shared/redis.ts` for cache-miss coalescing: concurrent requests for the same key share a single upstream fetch and Redis write.

**Source files**: `api/`, `server/gateway.ts`, `server/router.ts`, `server/_shared/redis.ts`, `server/worldmonitor/`

---

## 5. Proto/RPC Contract System

The project uses the **sebuf** framework built on Protocol Buffers:

```
proto/ definitions
    ↓ buf generate
src/generated/client/   (TypeScript RPC client stubs)
src/generated/server/   (TypeScript server message types)
docs/api/               (OpenAPI v3 specs)
```

Service definitions use `(sebuf.http.config)` annotations to map RPCs to HTTP verbs and paths. GET fields require `(sebuf.http.query)` annotation. `repeated string` fields need `parseStringArray()` in the handler. `int64` maps to `string` in TypeScript.

CI enforces generated code freshness via `.github/workflows/proto-check.yml`: runs `make generate` and fails if output differs from committed files.

**Source files**: `proto/`, `Makefile`, `src/generated/`, `.github/workflows/proto-check.yml`

---

## 6. Data Pipeline

### Bootstrap Hydration

`/api/bootstrap` reads cached keys from Redis in a single batch call. The SPA fetches two tiers concurrently (fast + slow) with separate abort controllers and timeouts. Hydrated data is consumed on-demand by panels via `getHydratedData(key)`.

### Seed Scripts

`scripts/seed-*.mjs` fetch upstream data, transform it, and write to Redis via `atomicPublish()` from `scripts/_seed-utils.mjs`. Atomic publish acquires a Redis lock (SET NX), validates data, writes the cache key, writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`, and releases the lock.

### AIS Relay Seed Loops

The Railway relay service (`scripts/ais-relay.cjs`) runs continuous seed loops:

- Market data (stocks, commodities, crypto, stablecoins, sectors, ETF flows, gulf quotes)
- Aviation (international delays)
- Positive events
- GPSJAM (GPS interference)
- Risk scores (CII)
- UCDP events

These are the primary seeders. Standalone `seed-*.mjs` scripts on Railway cron are secondary/backup.

### Refresh Scheduling

`startSmartPollLoop()` supports: exponential backoff (max 4x), viewport-conditional refresh (only if panel is near viewport), tab-pause (suspend when hidden), and staggered flush on tab visibility (150ms delays).

### Health Monitoring

`api/health.js` checks every bootstrap and standalone key. For each key it reads `seed-meta:<key>` and compares `fetchedAt` against `maxStaleMin`. Cascade groups handle fallback chains (e.g., theater-posture: live, stale, backup). Returns per-key status: OK, STALE, WARN, EMPTY.

**Source files**: `api/bootstrap.js`, `api/health.js`, `scripts/_seed-utils.mjs`, `scripts/seed-*.mjs`, `scripts/ais-relay.cjs`, `src/services/bootstrap.ts`, `src/app/refresh-scheduler.ts`

---

## 7. Desktop Architecture

### Tauri Shell

Tauri 2.x (Rust) manages the app lifecycle, system tray, and IPC commands:

- **Secret management**: Read/write platform keyring (macOS Keychain, Windows Credential Manager, Linux keyring)
- **Sidecar control**: Spawn Node.js process, probe port, inject environment variables
- **Window management**: Three trusted windows (main, settings, live-channels) with Edit menu for macOS clipboard shortcuts

### Node.js Sidecar

`src-tauri/sidecar/local-api-server.mjs` runs on a dynamic port. It dynamically loads Edge Function handler modules from `api/`, injects secrets from the keyring via environment variables, and monkey-patches `globalThis.fetch` to force IPv4 (Node.js tries IPv6 first, but many government APIs have broken IPv6).

### Fetch Patching

`installRuntimeFetchPatch()` in `src/services/runtime.ts` replaces `window.fetch` on the desktop renderer. All `/api/*` requests route to the sidecar with `Authorization: Bearer <token>` (5-min TTL from Tauri IPC). If the sidecar fails, requests fall back to the cloud API.

**Source files**: `src-tauri/src/main.rs`, `src-tauri/sidecar/local-api-server.mjs`, `src/services/runtime.ts`, `src/services/tauri-bridge.ts`

---

## 8. Security Model

### Trust Boundaries

```
Browser ↔ Vercel Edge ↔ Upstream APIs
Desktop ↔ Sidecar ↔ Cloud API / Upstream APIs
```

### Content Security Policy

Three CSP sources that must stay in sync:

1. `index.html` `<meta>` tag (development, Tauri fallback)
2. `vercel.json` HTTP header (production, overrides meta)
3. `src-tauri/tauri.conf.json` (desktop)

### Authentication

API keys are required for non-browser origins. Trusted browser origins (production domains, Vercel preview deployments, localhost) are exempt. Premium RPC paths always require a key.

### Bot Protection

`middleware.ts` filters automated traffic: blocks known crawler user-agents on API and asset paths, allows social preview bots (Twitter, Facebook, LinkedIn, Telegram, Discord) on story and OG endpoints.

### Rate Limiting

Per-IP sliding window via Upstash with per-endpoint overrides for high-traffic paths.

### Desktop Secret Storage

Secrets are stored in the platform keyring (never plaintext), injected into the sidecar via Tauri IPC, and scoped to an allowlist of environment variable keys.

**Source files**: `middleware.ts`, `vercel.json`, `index.html`, `src-tauri/tauri.conf.json`, `api/_api-key.js`, `server/_shared/rate-limit.ts`

---

## 9. Caching Architecture

### Four-Layer Hierarchy

```
Bootstrap seed (Railway writes to Redis on schedule)
    ↓ miss
In-memory cache (per Vercel instance, short TTL)
    ↓ miss
Redis (Upstash, cross-instance, cachedFetchJson coalesces concurrent misses)
    ↓ miss
Upstream API fetch (result cached back to Redis + seed-meta written)
```

### Cache Key Rules

Every RPC handler with shared cache MUST include request-varying parameters in the cache key. Failure to do so causes cross-request data leakage.

### ETag / Conditional Requests

`server/gateway.ts` computes an FNV-1a hash of each response body and returns it as an `ETag`. Clients send `If-None-Match` and receive `304 Not Modified` when content is unchanged.

### CDN Integration

`CDN-Cache-Control` headers give Cloudflare edge (when enabled) longer TTLs than `Cache-Control`, since CF can revalidate via ETag without full payload transfer.

### Seed Metadata

Every cache write also writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`. The health endpoint reads these to determine data freshness and raise staleness alerts.

**Source files**: `server/_shared/redis.ts`, `server/gateway.ts`, `api/health.js`

---

## 10. Testing

### Unit and Integration

`node:test` runner. Test files in `tests/*.test.{mjs,mts}` cover: server handlers, cache keying, circuit breakers, edge function constraints, data validation, market quote dedup, health checks, panel config guardrails, and variant layer filtering.

### Sidecar and API Tests

`api/*.test.mjs` and `src-tauri/sidecar/*.test.mjs` test CORS handling, YouTube embed proxying, and local API server behavior.

### End-to-End

Playwright specs in `e2e/*.spec.ts` test theme toggling, circuit breaker persistence, keyword spike flows, mobile map interactions, runtime fetch patching, and visual regression via golden screenshot comparison per variant.

### Edge Function Guardrails

`tests/edge-functions.test.mjs` validates that all non-helper `api/*.js` files are self-contained: no `node:` built-in imports, no cross-directory `../server/` or `../src/` imports. The pre-push hook also runs an esbuild bundle check on each endpoint.

### Pre-Push Hook

Runs before every `git push`:

1. TypeScript check (`tsc --noEmit` for src and API)
2. CJS syntax validation
3. Edge function esbuild bundle check
4. Edge function import guardrail test
5. Markdown lint
6. MDX lint (Mintlify compatibility)
7. Version sync check

**Source files**: `tests/`, `e2e/`, `playwright.config.ts`, `.husky/pre-push`

---

## 11. CI/CD

| Workflow | Trigger | Checks |
|----------|---------|--------|
| `typecheck.yml` | PR, push to main | `tsc --noEmit` for src and API tsconfigs |
| `lint.yml` | PR (markdown changes) | markdownlint-cli2 |
| `proto-check.yml` | PR (proto changes) | Generated code matches committed output |
| `build-desktop.yml` | Release tag, manual | 5-platform matrix build, code signing (macOS), AppImage library stripping (Linux), smoke test |
| `docker-publish.yml` | Release, manual | Multi-arch image (amd64, arm64) pushed to GHCR |
| `test-linux-app.yml` | Manual | Linux AppImage build + headless smoke test with screenshot verification |

**Source files**: `.github/workflows/`, `.husky/pre-push`

---

## 12. Directory Reference

```
.
├── api/                    Vercel Edge Functions (self-contained JS)
│   ├── _*.js               Shared helpers (CORS, rate-limit, API key, relay)
│   └── <domain>/           Domain endpoints (aviation/, climate/, conflict/, ...)
├── blog-site/              Static blog (built into public/blog/)
├── convex/                 Convex backend (contact form, waitlist)
├── data/                   Static data files (conservation, renewable, happiness)
├── deploy/                 Deployment configs
├── docker/                 Dockerfile + nginx config for Railway
├── docs/                   Mintlify documentation site
├── e2e/                    Playwright E2E specs
├── proto/                  Protobuf service definitions (sebuf framework)
├── scripts/                Seed scripts, build helpers, relay service
├── server/                 Server-side code (bundled into Edge Functions)
│   ├── _shared/            Redis, rate-limit, LLM, caching utilities
│   ├── gateway.ts          Domain gateway factory
│   ├── router.ts           Route matching
│   └── worldmonitor/       Domain handlers (mirrors proto structure)
├── shared/                 Cross-platform JSON configs (markets, RSS domains)
├── src/                    Browser SPA (TypeScript)
│   ├── app/                App orchestration managers
│   ├── bootstrap/          Chunk reload recovery
│   ├── components/         Panel subclasses + map components
│   ├── config/             Variant, panel, layer, market configurations
│   ├── generated/          Proto-generated client/server stubs (DO NOT EDIT)
│   ├── locales/            i18n translation files
│   ├── services/           Business logic organized by domain
│   ├── types/              TypeScript type definitions
│   ├── utils/              Shared utilities (circuit-breaker, theme, URL state)
│   └── workers/            Web Workers (analysis, ML, vector DB)
├── src-tauri/              Tauri desktop shell (Rust)
│   └── sidecar/            Node.js sidecar API server
└── tests/                  Unit/integration tests (node:test)
```
