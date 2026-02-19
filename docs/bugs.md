# World Monitor — Bug Registry

Bugs are prefixed with `BUG-` and a three-digit number.
Each entry includes severity, description, affected files, and dependencies on other items.

---

## Critical

### BUG-001 — Monolithic `App.ts` God-Class (4 357 lines)

| Field | Value |
|---|---|
| **Severity** | Critical (architectural) |
| **Affected** | `src/App.ts` |
| **Depends on** | — |

**Description**
`App.ts` holds the entire application orchestration in a single 4 357-line class with 136 methods.
Any change risks regressions elsewhere; HMR is fragile because the whole class must reload after every edit.

**AI instructions**
Split `App.ts` into focused controllers (e.g., `DataLoader`, `PanelManager`, `MapController`, `RefreshScheduler`, `DeepLinkHandler`), each in a separate file under `src/controllers/`.
Keep the `App` class as a thin composition root that wires controllers together.

---

### BUG-002 — Unsafe `innerHTML` Assignments with External Data

| Field | Value |
|---|---|
| **Severity** | Critical (security) |
| **Affected** | `src/components/MapPopup.ts`, `src/components/DeckGLMap.ts`, `src/components/CascadePanel.ts`, `src/components/CountryBriefPage.ts`, `src/components/CountryIntelModal.ts`, `src/components/InsightsPanel.ts`, `src/App.ts` (lines ~2763, ~2817) |
| **Depends on** | — |

**Description**
Despite documentation claiming all external data passes through `escapeHtml()`, many `innerHTML` assignments interpolate feed-sourced strings (headlines, source names, tension labels) without escaping.
An RSS feed with `<img onerror=alert(1)>` in its title could execute arbitrary JS.

**AI instructions**
Audit every `innerHTML` assignment in `src/`.
Replace raw interpolation with either `escapeHtml()` wrapping on every external value, or switch to `textContent` / `createElement` where possible.
Add an ESLint rule or grep pre-commit hook to flag new `innerHTML` usage.

---

### BUG-003 — `youtube/live` Dev Endpoint Always Returns `null` Video

| Field | Value |
|---|---|
| **Severity** | Critical (feature broken in dev) |
| **Affected** | `vite.config.ts` (line ~148-151) |
| **Depends on** | — |

**Description**
The `youtubeLivePlugin()` Vite middleware hardcodes `{ videoId: null, channel }` with a TODO comment: *"will implement proper detection later"*.
This means the LiveNewsPanel falls back to static channel-level video IDs during local development, never resolving the actual live stream.

**AI instructions**
Implement the pending live-stream detection using the `youtubei.js` library already in `package.json`, or remove the dev plugin and proxy to the production API route (`/api/youtube/live.js`).

---

## High

### BUG-004 — Panel-Order Migration Log Says "v1.8" but Key Says "v1.9"

| Field | Value |
|---|---|
| **Severity** | High (data inconsistency) |
| **Affected** | `src/App.ts` (line ~237) |
| **Depends on** | — |

**Description**
`PANEL_ORDER_MIGRATION_KEY` is `worldmonitor-panel-order-v1.9` but the `console.log` says `"Migrated panel order to v1.8 layout"`.
This is confusing for anyone debugging migrations.

**AI instructions**
Change the log message to `v1.9`.

---

### BUG-005 — Duplicate `layerToSource` Mapping

| Field | Value |
|---|---|
| **Severity** | High (maintenance risk) |
| **Affected** | `src/App.ts` — `syncDataFreshnessWithLayers()` (line ~606) and `setupMapLayerHandlers()` (line ~643) |
| **Depends on** | BUG-001 |

**Description**
The `layerToSource` map is copy-pasted in two places. If a new layer is added to one and not the other, freshness tracking silently breaks for that layer.

**AI instructions**
Extract `layerToSource` to a shared constant (e.g., in `src/config/panels.ts`), import it in both locations.

---

### BUG-006 — RSS Proxy Mirrors Polymarket Through Production URL

| Field | Value |
|---|---|
| **Severity** | High (reliability / circular dependency) |
| **Affected** | `vite.config.ts` (line ~348) |
| **Depends on** | — |

**Description**
The Polymarket dev proxy targets `https://worldmonitor.app` (the live production site).
This creates a circular dependency in dev → prod, means dev can break when prod is deploying, and masks local proxy bugs until they hit production.

**AI instructions**
Proxy directly to `gamma-api.polymarket.com` or implement the same edge-function logic locally in a Vite middleware plugin (similar to `youtubeLivePlugin`).

---

### BUG-007 — No Error Boundary on News Cluster Rendering

| Field | Value |
|---|---|
| **Severity** | High |
| **Affected** | `src/components/NewsPanel.ts`, `src/services/clustering.ts` |
| **Depends on** | — |

**Description**
If the clustering worker returns malformed data (e.g., a cluster with `undefined` headline), the `NewsPanel` render loop throws, leaving the panel blank.
There is no try/catch wrapping individual cluster renders.

**AI instructions**
Wrap each cluster card render in a try/catch. Log the bad cluster and render a "failed to display" placeholder so the remaining clusters still appear.

---

### BUG-008 — `setInterval` Clock Leak in `startHeaderClock()`

| Field | Value |
|---|---|
| **Severity** | High (memory leak on HMR) |
| **Affected** | `src/App.ts` (line ~523) |
| **Depends on** | — |

**Description**
`setInterval(tick, 1000)` in `startHeaderClock()` is never stored or cleared.
On Vite HMR reload the old interval keeps ticking, doubling DOM writes each hot reload until the page is hard-refreshed.

**AI instructions**
Store the interval ID and clear it in `App.destroy()`.

---

### BUG-009 — `deepLinkCountry` Polling Has No Maximum Retry

| Field | Value |
|---|---|
| **Severity** | High |
| **Affected** | `src/App.ts` — `handleDeepLinks()` (lines ~392-400, ~413-419) |
| **Depends on** | — |

**Description**
`checkAndOpen()` and `checkAndOpenBrief()` use `setTimeout(…, 500)` recursively with no cap. If the data source is permanently down, the browser spins polling forever.

**AI instructions**
Add a max retry counter (e.g., 60 attempts = 30 seconds) and show a user-facing error ("Data not available") if exceeded.

---

### BUG-010 — Finance Variant Missing Desktop Packaging Scripts

| Field | Value |
|---|---|
| **Severity** | High |
| **Affected** | `package.json` |
| **Depends on** | — |

**Description**
The `finance` variant has `dev:finance`, `build:finance`, and `desktop:build:finance` scripts, but there are no `desktop:package:*:finance` scripts.
Running `desktop:package` for the finance variant will fail silently or produce the wrong build.

**AI instructions**
Add `desktop:package:macos:finance`, `desktop:package:windows:finance`, and their `:sign` variants, pointing to a `tauri.finance.conf.json` config.

---

## Medium

### BUG-011 — Inconsistent Idle Timeout Values

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Affected** | `src/App.ts` (2 min), `src/components/LiveNewsPanel.ts` (5 min), `src/components/LiveWebcamsPanel.ts` (5 min) |
| **Depends on** | — |

**Description**
Documentation says "5 min idle" pauses the stream, but `App.ts` uses a 2-minute `IDLE_PAUSE_MS`.
The mismatch means map animations pause 3 minutes before the live stream panels, which may confuse users.

**AI instructions**
Unify idle timeouts via a shared constant in config, or document the intentional difference.

---

### BUG-012 — Missing `GDELT Doc` in Data Freshness Tracker

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Affected** | `src/services/data-freshness.ts`, `src/App.ts` — `syncDataFreshnessWithLayers()` |
| **Depends on** | BUG-005 |

**Description**
`layerToSource` maps layers to freshness source IDs, but several API-backed data sources (GDELT Doc intelligence feed, FRED, EIA oil, USASpending, PizzINT, Polymarket, Predictions) are not tracked in the freshness system.
The Status Panel cannot report staleness for these feeds.

**AI instructions**
Register all backend data sources in `data-freshness.ts` and call `dataFreshness.recordUpdate(sourceId)` after each successful fetch.

---

### BUG-013 — `VITE_VARIANT` Env Var Not Windows-Compatible in npm Scripts

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Affected** | `package.json` (all `VITE_VARIANT=…` scripts) |
| **Depends on** | — |

**Description**
Scripts like `"build:tech": "VITE_VARIANT=tech tsc && VITE_VARIANT=tech vite build"` use Unix shell syntax.
On Windows (the project's primary development OS per user profile) these will silently ignore the variable, building the wrong variant.

**AI instructions**
Use `cross-env` (npm package) to set environment variables portably, e.g., `"build:tech": "cross-env VITE_VARIANT=tech tsc && cross-env VITE_VARIANT=tech vite build"`.
Alternatively, use `.env` file-based variant selection.

---

### BUG-014 — No Automated Tests for API Handler Input Validation

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Affected** | `api/*.js` (55 handlers) |
| **Depends on** | — |

**Description**
Only `api/_cors.test.mjs`, `api/cyber-threats.test.mjs`, and `api/youtube/embed.test.mjs` have unit tests.
The remaining 52 API handlers have no tests, including security-critical endpoints like `rss-proxy.js`, `groq-summarize.js`, and `openrouter-summarize.js` that accept user-controlled input.

**AI instructions**
Write unit tests for all API handlers using the node built-in test runner. Prioritize endpoints that accept user parameters: `yahoo-finance.js`, `coingecko.js`, `polymarket.js`, `rss-proxy.js`, `finnhub.js`, `groq-summarize.js`, `openrouter-summarize.js`.

---

### BUG-015 — Service Worker Excludes ML WASM but Still Caches 60+ MB ML JS Chunk

| Field | Value |
|---|---|
| **Severity** | Medium |
| **Affected** | `vite.config.ts` (line ~200) |
| **Depends on** | — |

**Description**
`globIgnores` excludes `**/onnx*.wasm` but the `ml` chunk (Xenova Transformers JS code) is still matched by `**/*.{js,…}` and will be precached by Workbox.
This inflates the initial service worker cache by ~60 MB, wasting bandwidth for users who never use browser ML.

**AI instructions**
Add `**/ml-*.js` to `globPatterns` exclude (it's in `globIgnores` already — verify it's working; if the chunk name doesn't start with `ml-` adjust the pattern to match the actual output filename).

---

### BUG-016 — `MapPopup.ts` at 113 KB — Largest Component

| Field | Value |
|---|---|
| **Severity** | Medium (maintainability) |
| **Affected** | `src/components/MapPopup.ts` (113 133 bytes) |
| **Depends on** | BUG-001 |

**Description**
A single file handling popup rendering for every data layer type (conflicts, bases, cables, pipelines, ports, vessels, aircraft, protests, earthquakes, nuclear, datacenters, tech HQs, etc.).
Changes to one popup type risk breaking all others.

**AI instructions**
Split into per-layer popup renderers (e.g., `popups/ConflictPopup.ts`, `popups/MilitaryPopup.ts`, etc.) with a dispatcher in `MapPopup.ts`.

---

## Low

### BUG-017 — Magic Numbers Across Scoring Algorithms

| Field | Value |
|---|---|
| **Severity** | Low |
| **Affected** | `src/services/country-instability.ts`, `src/services/hotspot-escalation.ts`, `src/services/military-surge.ts`, `src/services/geo-convergence.ts` |
| **Depends on** | — |

**Description**
Scoring thresholds (e.g., `0.35`, `0.25`, `0.15`, `min(50, count × 8)`) are scattered as raw numbers.
The documentation describes them well, but the code is hard to tune without grepping across files.

**AI instructions**
Extract all scoring weights and thresholds into `src/utils/analysis-constants.ts` (which already exists for some constants), making them centrally tunable.

---

### BUG-018 — Localization Coverage Gaps

| Field | Value |
|---|---|
| **Severity** | Low |
| **Affected** | `src/locales/` (22 locale files), various components |
| **Depends on** | — |

**Description**
Several components use hardcoded English strings (e.g., `"No instability signals detected"` in `CIIPanel.ts` line 114, `"Hide Intelligence Findings"` in `IntelligenceGapBadge.ts` line 161).
The i18n system (`i18next`) is initialized but not consistently applied.

**AI instructions**
Audit all user-facing strings for missing `t(…)` calls. Add keys to `en.json` and all other locale files.

---

### BUG-019 — `test:e2e` Scripts Fail on Windows Due to Shell Syntax

| Field | Value |
|---|---|
| **Severity** | Low |
| **Affected** | `package.json` — all `test:e2e:*` scripts |
| **Depends on** | BUG-013 |

**Description**
Same issue as BUG-013 — `VITE_VARIANT=full playwright test` is Unix-only.
E2E tests are untestable on the primary development platform (Windows).

**AI instructions**
Fix alongside BUG-013 using `cross-env`.

---

### BUG-020 — `DeckGLMap.ts` at 156 KB — Largest File in Project

| Field | Value |
|---|---|
| **Severity** | Low (maintainability) |
| **Affected** | `src/components/DeckGLMap.ts` (156 750 bytes) |
| **Depends on** | BUG-016 |

**Description**
The WebGL map implementation handles all deck.gl layer construction, interaction, controls, and popups in one massive file.
IDE performance suffers, and code review is impractical.

**AI instructions**
Extract logical sections into separate modules: `DeckGLLayers.ts` (layer factories), `DeckGLControls.ts` (UI controls), `DeckGLInteraction.ts` (picking/click handlers).
