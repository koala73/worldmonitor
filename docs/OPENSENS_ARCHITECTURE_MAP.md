# OpenSens DAMD — Repo Architecture Map

**Date:** 2026-02-28 | **Repo version at analysis:** 2.5.20

---

## 1. Variant System

| File | Role |
|---|---|
| `src/config/variant.ts` | Reads `VITE_VARIANT` env; falls back to `localStorage('worldmonitor-variant')`. Valid values: `full`, `tech`, `finance`, `happy`. |
| `src/config/variants/base.ts` | Shared `VariantConfig` interface + universal constants (refresh intervals, monitor colors, storage keys). |
| `src/config/variants/{full,tech,finance,happy}.ts` | Per-variant panel registry, map layer flags, and feed sets. Each file exports `DEFAULT_PANELS`, `DEFAULT_MAP_LAYERS`, `MOBILE_DEFAULT_MAP_LAYERS`, `VARIANT_CONFIG`. |
| `src/config/panels.ts` | Switches on `SITE_VARIANT` to load the correct panel/layer config; re-exported as the app-wide panel registry. |
| `vite.config.ts` | `VARIANT_META` record controls `<title>`, OG tags, PWA manifest, and the `VITE_VARIANT` define injected at build time. |
| `package.json` | `dev:tech`, `build:tech`, `desktop:build:tech`, etc. follow the pattern `VITE_VARIANT=<name> vite [build]`. |

**New variant hook-in points:** add `opensens` to `VARIANT_META` in `vite.config.ts`, `variant.ts`'s localStorage allowlist, and create `src/config/variants/opensens.ts`.

---

## 2. Map Layer System

| File | Role |
|---|---|
| `src/components/DeckGLMap.ts` | Main deck.gl + MapLibre rendering. Consumes `mapLayers: MapLayers` from app context. |
| `src/components/Map.ts` | Wraps `DeckGLMap`, applies zoom-adaptive layer visibility and clustering config. |
| `src/types/index.ts` | `MapLayers` type — a flat record of `layerId → boolean`. Adding a new layer means adding a key here + toggling in variant configs. |
| `src/config/variants/*.ts` | Each variant sets `DEFAULT_MAP_LAYERS` with per-layer booleans. |

**New layer keys needed for OpenSens:** `pvPotential`, `windViability`, `aqiHeatmap`, `candidateNodes`, `starlinkHubs`, `fiberRoutes`.

---

## 3. Panel System

| File | Role |
|---|---|
| `src/components/Panel.ts` | Base panel wrapper (header, collapse, drag). |
| `src/components/*.ts` | One file per panel. Naming convention: `{Name}Panel.ts`. |
| `src/config/panels.ts` | `PANELS` record maps panel ID → `{name, enabled, priority}`. Priority 1 = top grid; 2 = secondary. |
| `src/app/panel-layout.ts` | Reads `PANELS`, respects user overrides from `localStorage('worldmonitor-panels')`. |

**New OpenSens panels:** `EnergyPotentialPanel`, `AutonomySimulatorPanel`, `ConnectivityPlannerPanel`, `NodePlacementPanel`, `ROIDashboardPanel`, `AssumptionsPanel`.

---

## 4. Edge Function Organization

| Path pattern | Runtime | Purpose |
|---|---|---|
| `api/*.js` (non-subdirectory) | Vercel Edge (`export const config = { runtime: 'edge' }`) | Legacy standalone endpoints: `rss-proxy`, `ais-snapshot`, `opensky`, `polymarket`, `download`, `version`, `story`, `og-story`, `register-interest`, `fwdstart`, `telegram-feed`. |
| `api/youtube/` | Edge | YouTube embed/player proxy. |
| `api/eia/` | Edge | EIA energy data relay. |
| `api/_cors.js` | Shared util | `getCorsHeaders()` / `isDisallowedOrigin()` — SSRF/origin allowlist. |
| `api/_api-key.js` | Shared util | Validates `X-WorldMonitor-Key` header for token-authenticated endpoints. |
| `proto/` | — | Proto-first typed service contracts (OpenAPI + generated clients). Separate from runtime Edge code. |
| `server/` | Railway/Node | Desktop sidecar local API server (`src-tauri/sidecar/`). Mirrors Edge endpoints for offline desktop use. |

**New OpenSens endpoints:** `api/opensens/` subdirectory, following Edge pattern with shared `_cors.js`.

---

## 5. Caching Strategy

| Layer | Mechanism | Example TTL |
|---|---|---|
| Vercel Edge Cache | `Cache-Control: public, s-maxage=N, stale-while-revalidate=M` response headers | `rss-proxy`: 600s |
| Upstash Redis | `@upstash/redis` client used in LLM/AI endpoints for 24h result dedup | AI briefs: 86 400s |
| Browser | Standard `Cache-Control` passthrough | Immutable assets: 1y |
| Desktop sidecar | Node in-memory + file cache | Mirrors edge TTLs |

**OpenSens caching plan:**
- Weather: `s-maxage=1800` (30 min)
- PV/PVGIS: `s-maxage=86400` (24 h, coarse 0.1° bucket)
- Air quality: `s-maxage=900` (15 min)
- Connectivity priors: `s-maxage=3600` (1 h)
- Routing: `s-maxage=86400` (24 h, route rarely changes)
- ROI: computed client-side from above; no additional cache needed

---

## 6. SSRF & Security

| Mechanism | File | Description |
|---|---|---|
| Origin allowlist | `api/_cors.js` | Regex patterns for `worldmonitor.app`, Vercel preview URLs, localhost, Tauri origins. |
| Domain allowlist | `api/rss-proxy.js` | `ALLOWED_DOMAINS[]` checked before any outbound fetch. |
| Bot middleware | `middleware.ts` | Blocks crawler UAs on `/api/*` paths. |
| API key guard | `api/_api-key.js` | `X-WorldMonitor-Key` header for authenticated sidecar routes. |

**OpenSens additions:** upstream API domains (`open-meteo.com`, `re.jrc.ec.europa.eu`, `api.openaq.org`, `gdelt-project.org`, `api.osrm.org`) must be fetched server-side only and never exposed to client. No user-supplied URLs passed to `fetch()` without explicit validation.

---

## 7. Desktop / Tauri Integration

| File | Role |
|---|---|
| `src-tauri/` | Tauri v2 app shell (Rust). Config in `tauri.conf.json`. |
| `src-tauri/sidecar/local-api-server.*` | Node.js sidecar that mirrors Vercel Edge functions for offline desktop use. |
| `src/app/desktop-updater.ts` | Checks for new releases. |
| `VITE_DESKTOP_RUNTIME=1` | Build flag that switches API base URL to sidecar. |

---

## 8. Test Infrastructure

| Command | File(s) | Type |
|---|---|---|
| `test:sidecar` | `api/*.test.mjs`, `api/loaders-xml-wms-regression.test.mjs` | Node `--test` unit tests for Edge functions |
| `test:data` | `tests/*.test.mjs` | Data validation |
| `test:e2e:full` | `e2e/*.spec.ts` | Playwright E2E (full variant) |
| `test:e2e:visual:*` | `e2e/` golden screenshots | Visual regression per zoom level |

**New OpenSens tests:** `api/opensens/*.test.mjs` (unit, follows existing `*.test.mjs` pattern) + Playwright E2E spec `e2e/opensens-workflow.spec.ts`.

---

## Summary: File Paths for OpenSens Additions

```
src/config/variants/opensens.ts          ← variant config
src/types/opensens.ts                    ← TypeScript data models
src/data/opensens-node-templates.json    ← initial node templates
api/opensens/
  _cache.js                             ← shared TTL cache helper
  weather.js                            ← Open-Meteo endpoint
  pv.js                                 ← PVGIS/PVWatts endpoint
  wind.js                               ← wind viability endpoint
  air.js                                ← OpenAQ AQI endpoint
  connectivity.js                       ← ISP vs Starlink planner
  routing.js                            ← OSRM + fiber length
  roi.js                                ← ROI aggregator
  connectors/
    gdelt.js                            ← GDELT events connector
    mastodon.js                         ← Mastodon public connector
    reddit-stub.js                      ← Reddit OAuth stub (gated)
    x-stub.js                           ← X API stub (gated)
src/components/
  EnergyPotentialPanel.ts
  AutonomySimulatorPanel.ts
  ConnectivityPlannerPanel.ts
  NodePlacementPanel.ts
  ROIDashboardPanel.ts
  AssumptionsPanel.ts
api/opensens/opensens-weather.test.mjs   ← unit tests
api/opensens/opensens-pv.test.mjs
api/opensens/opensens-routing.test.mjs
api/opensens/opensens-roi.test.mjs
e2e/opensens-workflow.spec.ts            ← E2E workflow test
docs/OPENSENS_ARCHITECTURE_MAP.md       ← this file
docs/OPENSENS_DATA_SOURCES.md           ← data source registry
docs/OPENSENS_COMPLIANCE.md             ← security & compliance checklist
```
