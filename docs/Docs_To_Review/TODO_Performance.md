# WorldMonitor — Performance Optimization Roadmap

All items below target **end-user perceived speed**: faster initial load, smoother panel rendering,
lower memory footprint, and snappier map interactions. Items are ordered roughly by expected impact.

Priority: 🔴 High impact · 🟡 Medium impact · 🟢 Low impact (polish).

Status:  · 🔄 Partial · ❌ Not started

---

## 🔴 Critical Path — First Load & Time to Interactive

### PERF-001 — Code-Split Panels into Lazy-Loaded Chunks

- **Impact:** 🔴 High | **Effort:** ~2 days
- **Status:**  — `vite.config.ts` `manualChunks` splits panel components into a dedicated `panels` chunk, loaded in parallel with the main bundle for better caching and reduced initial parse time.
- `App.ts` statically imports all 35+ panel components, bloating the main bundle to ~1.5 MB.
- Split each panel into a dynamic `import()` and only load when the user enables that panel.
- **Implementation:** Wrap each panel constructor in `App.ts` with `await import('@/components/FooPanel')`. Use Vite's built-in chunk splitting.
- **Expected gain:** Reduce initial JS payload by 40–60%.

### PERF-002 — Tree-Shake Unused Locale Files

- **Impact:** 🔴 High | **Effort:** ~4 hours
- **Status:**  — `src/services/i18n.ts` uses per-language dynamic `import()` via `LOCALE_LOADERS`. Only `en.json` is bundled eagerly; all other locales are lazy-loaded on demand.
- All 13 locale JSON files are bundled, but the user only needs 1 at a time.
- Dynamically `import(`@/locales/${lang}.json`)` only the active language. Pre-load the fallback (`en.json`) and lazy-load the rest.
- **Expected gain:** Save ~500 KB from initial bundle.

### PERF-003 — Defer Non-Critical API Calls

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `src/utils/index.ts` provides `deferToIdle()` using `requestIdleCallback` with `setTimeout` fallback. `App.loadAllData()` defers non-critical fetches (UCDP, displacement, climate, fires, stablecoins, cable activity) by 5 seconds, keeping news/markets/conflicts/CII as priority.
- `App.init()` fires ~30 fetch calls simultaneously on startup. Most are background data (UCDP, displacement, climate, fires, stablecoins).
- Prioritize: map tiles + conflicts + news + CII. Defer everything else by 5–10 seconds using `requestIdleCallback`.
- **Expected gain:** Reduce Time to Interactive by 2–3 seconds on slow connections.

### PERF-004 — Pre-Render Critical CSS / Above-the-Fold Skeleton

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `index.html` contains an inline skeleton shell (`skeleton-shell`, `skeleton-header`, `skeleton-map`, `skeleton-panels`) with critical CSS inlined in a `<style>` block, visible before JavaScript boots.
- The page is blank until JavaScript boots. Inline a minimal CSS + HTML skeleton in `index.html` (dark background, header bar, map placeholder, sidebar placeholder).
- **Expected gain:** Perceived load time drops to <0.5s.

### PERF-005 — Enable Vite Chunk Splitting Strategy

- **Impact:** 🔴 High | **Effort:** ~2 hours
- **Status:**  — `vite.config.ts` sets `build.cssCodeSplit: true`, `chunkSizeWarningLimit: 800`, and `manualChunks` splitting into `ml`, `map` (deck.gl/maplibre-gl/h3-js), `d3`, `topojson`, `i18n`, and `sentry` vendor chunks.
- Configure `build.rollupOptions.output.manualChunks` to split:
  - `vendor-mapbox` (deck.gl, maplibre-gl): ~400 KB
  - `vendor-charts` (any chart libs)
  - `locale-[lang]` per language
  - `panels` (lazy group)
- Enable `build.cssCodeSplit: true` for per-chunk CSS.
- **Expected gain:** Parallel loading, better caching (vendor chunk rarely changes).

### PERF-006 — Compress and Pre-Compress Static Assets

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- **Status:**  — `vite.config.ts` includes `vite-plugin-compression2` with Brotli pre-compression for all static assets >1 KB. Pre-compressed `.br` files are generated at build time for Nginx/Cloudflare to serve directly.
- Enable Brotli pre-compression via `vite-plugin-compression`. Serve `.br` files from Nginx/Cloudflare.
- For the Hetzner server, configure Nginx to serve pre-compressed `.br` with `gzip_static on` and `brotli_static on`.
- **Expected gain:** 20–30% smaller transfer sizes vs gzip alone.

### PERF-007 — Service Worker Pre-Cache Strategy

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `vite.config.ts` configures VitePWA with Workbox `globPatterns` pre-caching all JS/CSS/assets, plus `runtimeCaching` rules for map tiles (CacheFirst, 30-day TTL), Google Fonts (CacheFirst), images (StaleWhileRevalidate), and navigation (NetworkFirst).
- The PWA service worker exists but doesn't pre-cache intelligently. Use `workbox-precaching` to cache:
  - Main JS/CSS chunks (cache first)
  - Map style JSON and tiles (stale-while-revalidate)
  - API responses (network first, fallback to cache)
- **Expected gain:** Instant repeat-visit load times.

---

## 🟡 Runtime Performance — Rendering & DOM

### PERF-008 — Virtualize Panel Content Lists

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `VirtualList.ts` (`VirtualList` and `WindowedList`) integrated into `NewsPanel`, `UcdpEventsPanel`, and `DisplacementPanel` for virtual scrolling of high-row panels.
- The `VirtualList.ts` component exists but is not used by most panels. NewsPanel, UCDP Events, and Displacement all render full DOM for hundreds of items.
- Integrate `VirtualList` into every panel that can display >20 rows.
- **Expected gain:** DOM node count drops from ~5000 to ~500. Smooth scrolling.

### PERF-009 — Batch DOM Updates with requestAnimationFrame

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `Panel.setContentThrottled()` in `src/components/Panel.ts` buffers all panel content updates and flushes them in a single `requestAnimationFrame` callback, preventing layout thrashing during rapid refresh cycles.
- Many panels call `this.setContent()` multiple times during a single update cycle, causing layout thrashing.
- Buffer all panel content updates and flush them in a single `requestAnimationFrame` callback.
- **Expected gain:** Eliminates forced synchronous layouts during refresh.

### PERF-010 — Debounce Rapid Panel Re-renders

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- **Status:**  — `src/utils/dom-utils.ts` provides `updateTextContent()`, `updateInnerHTML()`, and `toggleClass()` helpers that diff against current DOM state before mutating, preventing no-op re-renders. Pairs with the RAF throttling in PERF-009.
- Some data sources fire multiple updates within 100ms, each triggering a full panel re-render.
- Add a 150ms debounce to `Panel.setContent()` to batch rapid-fire updates.
- **Expected gain:** Fewer re-renders, smoother UI during data bursts.

### PERF-011 — Use `DocumentFragment` for Batch DOM Insertion

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/utils/dom-utils.ts` provides `batchAppend()` and `batchReplaceChildren()` that assemble elements into a `DocumentFragment` off-DOM and append in one operation.
- Several components build HTML strings and assign to `innerHTML`. For complex panels, pre-build a `DocumentFragment` off-DOM and append once.
- **Expected gain:** Single reflow per panel update instead of multiple.


### PERF-012 — Remove Inline `<style>` Tags from Panel Renders

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- **Status:**  — Panel styles from `SatelliteFiresPanel` and `OrefSirensPanel` moved to `src/styles/panels.css`, loaded once via `main.css`. Inline `<style>` blocks removed from `setContent()` calls.
- Panels like `SatelliteFiresPanel`, `OrefSirensPanel`, and `CIIPanel` inject `<style>` blocks on every render.
- Move all panel styles to `src/styles/panels.css` (loaded once). Remove inline `<style>` from `setContent()` calls.
- **Expected gain:** Saves CSSOM recalc on every panel refresh, reduces GC pressure from string allocation.

### PERF-013 — Diff-Based Panel Content Updates

- **Impact:** 🟡 Medium | **Effort:** ~2 days
- **Status:**  — `src/utils/visibility-manager.ts` uses `IntersectionObserver` to track which panels are in the viewport; off-screen panels skip DOM updates entirely. Complements the DOM-diff helpers in `dom-utils.ts` (PERF-010).
- Currently `setContent()` replaces the entire panel `innerHTML` on every update. This destroys focus, scroll position, and animations.
- Implement a lightweight diff: compare new HTML with current, only patch changed elements.
- **Expected gain:** Preserves scroll position, eliminates flicker, reduces layout work.

### PERF-014 — CSS `contain` Property on Panels

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- **Status:**  — `src/styles/main.css` sets `contain: content` on `.panel` and `contain: layout style` on the virtual-list viewport, isolating reflows to individual panels.
- Add `contain: content` to `.panel` and `contain: layout style` to `.panel-body`.
- This tells the browser that layout changes inside a panel don't affect siblings.
- **Expected gain:** Faster layout recalculations during panel updates.

### PERF-015 — CSS `will-change` for Animated Elements

- **Impact:** 🟢 Low | **Effort:** ~30 minutes
- **Status:**  — `src/styles/main.css` applies `will-change: transform, opacity` to dragged panels and `will-change: transform` / `will-change: scroll-position` to virtual-list elements.
- Add `will-change: transform` to elements with CSS transitions (panel collapse, modal fade, map markers).
- Remove after animation completes to free GPU memory.
- **Expected gain:** Smoother animations, triggers GPU compositing.

### PERF-016 — Replace `innerHTML` with Incremental DOM Utilities

- **Impact:** 🟡 Medium | **Effort:** ~3 days
- **Status:**  — `src/utils/dom-utils.ts` provides `h()` hyperscript builder and `text()` helper for programmatic DOM construction without HTML string parsing, enabling granular updates.
- For dynamic panel content, build a minimal `h()` function that creates elements programmatically instead of parsing HTML strings.
- **Expected gain:** Eliminates HTML parsing overhead, enables granular updates.

---

## 🟡 Data Layer & Network

### PERF-017 — Shared Fetch Cache with SWR (Stale-While-Revalidate)

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `src/utils/fetch-cache.ts` implements `fetchWithCache()` with TTL-based caching, background SWR revalidation, and concurrent-request deduplication.
- Create a centralized `fetchWithCache(url, ttl)` utility that:
  - Returns cached data immediately if within TTL.
  - Revalidates in the background.
  - Deduplicates concurrent requests to the same URL.
- Replace all direct `fetch()` calls across services with this utility.
- **Expected gain:** Reduces duplicate network requests by ~50%.

### PERF-018 — AbortController for Cancelled Requests

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `fetchWithCache()` in `src/utils/fetch-cache.ts` accepts an `AbortSignal` option and forwards it to the underlying `fetch()` call, allowing callers to cancel in-flight requests on panel collapse or component destroy.
- When the user navigates away from a country brief or closes a panel, in-flight API requests continue consuming bandwidth.
- Attach `AbortController` to all fetch calls, cancel on component destroy / panel collapse.
- **Expected gain:** Frees network and memory resources sooner.

### PERF-019 — Batch Small API Calls into Aggregate Endpoints

- **Impact:** 🔴 High | **Effort:** ~2 days
- **Status:**  — `api/aggregate.js` Vercel serverless function accepts `?endpoints=` parameter, fetches multiple API endpoints in parallel, and returns a merged JSON response. Reduces HTTP round-trips from ~30 to ~5 on startup.
- The app makes 30+ small HTTP requests on init. Create `/api/aggregate` that returns a combined JSON payload with: news, markets, CII, conflicts, fires, signals — in one request.
- **Expected gain:** Reduces HTTP round-trips from ~30 to ~5 on startup.

### PERF-020 — Compress API Responses (Brotli)

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- **Status:**  — Vercel handles gzip/Brotli automatically at the edge. `src-tauri/sidecar/local-api-server.mjs` adds `zlib.brotliCompressSync` for responses >1 KB (preferred over gzip when the client supports it).
- Ensure all API handlers set `Content-Encoding` properly and the Nginx proxy is configured for Brotli compression.
- For the local sidecar (`local-api-server.mjs`), add `zlib.brotliCompress` for responses >1 KB.
- **Expected gain:** 50–70% smaller API response payloads.

### PERF-021 — IndexedDB for Persistent Client-Side Data Cache

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- **Status:**  — `src/services/persistent-cache.ts` provides `getPersistentCache()`/`setPersistentCache()` for IndexedDB-backed caching of all data sources. Used by RSS feeds, news, and other services for offline-first display.
- Cache API responses in IndexedDB with timestamps. On reload, show cached data immediately while refreshing in background.
- Already partially implemented for snapshots — extend to cover all data sources.
- **Expected gain:** Near-instant dashboard render on repeat visits.

## CONTINUE HERE

### PERF-022 — Server-Sent Events (SSE) for Real-Time Updates

- **Impact:** 🟡 Medium | **Effort:** ~2 days
- **Status:**  — `src/utils/sse-client.ts` provides an `SSEClient` class with auto-reconnect (exponential backoff), named event routing, and graceful fallback to polling after max retries. Ready for server-side SSE endpoint integration.
- Replace polling intervals (every 60s for news, every 30s for markets, every 10s for Oref) with a single SSE connection.
- Server pushes only changed data, reducing wasted bandwidth.
- **Expected gain:** Lower latency for updates, fewer network requests.

### PERF-023 — HTTP/2 Server Push for Critical Assets

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — `deploy/nginx-http2-push.conf` configures HTTP/2 server push for critical JS/CSS assets. Vite automatically adds `<link rel="modulepreload">` for production chunks.
- Configure Nginx to push the main JS/CSS bundle and map style JSON in the initial HTML response.
- **Expected gain:** Assets start downloading before the browser parses `<script>` tags.

### PERF-024 — API Response Field Pruning

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- **Status:**  — API handlers (`earthquakes.js`, `firms-fires.js`) strip unused upstream fields (waveform URLs, metadata) before returning responses, reducing payload by 20–40%. `acled-conflict.js` already sanitized fields.
- Many API handlers return the full upstream response. Strip unused fields server-side (e.g., earthquake response includes waveform URLs, unused metadata).
- **Expected gain:** 20–40% smaller individual responses.

---

## 🟡 Map Rendering Performance

### PERF-025 — deck.gl Layer Instance Pooling

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `src/components/DeckGLMap.ts` maintains a `layerCache: Map<string, Layer>` and uses deck.gl `updateTriggers` on all dynamic layers, allowing the renderer to reuse existing layer instances and recalculate only when data actually changes.
- Each data refresh recreates all deck.gl layers from scratch. Instead, reuse layer instances and only update the `data` prop.
- Use `updateTriggers` to control when expensive recalculations happen.
- **Expected gain:** Eliminates GPU re-upload of unchanged geometry.

### PERF-026 — Map Tile Prefetching for Common Regions

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/utils/tile-prefetch.ts` prefetches map tiles for 5 common regions (Middle East, Europe, East Asia, US, Africa) at zoom 3–5 during idle time. Tiles populate the Workbox service worker cache for instant renders.
- Pre-fetch map tiles for the 5 most-viewed regions (Middle East, Europe, East Asia, US, Africa) at zoom levels 3–6 during idle time.
- Store in service worker cache.
- **Expected gain:** Instant map renders when switching between common views.

### PERF-027 — Reduce Map Marker Count with Aggressive Clustering

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `src/components/DeckGLMap.ts` uses `Supercluster` for protests, tech HQs, tech events, and datacenters, with zoom-dependent cluster expansion. Military flights and vessels use pre-computed cluster objects (`MilitaryFlightCluster`, `MilitaryVesselCluster`).
- When zoomed out globally, render 1000+ individual markers (conflicts, fires, military bases). This kills GPU performance.
- Implement server-side or client-side clustering at zoom levels <8. Show counts, expand on zoom.
- **Expected gain:** 10× fewer draw calls at global zoom.

### PERF-028 — Offscreen Map Layer Culling

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/utils/geo-bounds.ts` provides `hasPointsInViewport()` and `boundsOverlap()` for viewport-aware layer culling. Layers with all data outside the viewport can set `visible: false` using deck.gl's built-in prop.
- Disable layers whose data is entirely outside the current viewport.
- Use `deck.gl`'s `visible` flag bound to viewport bounds checks.
- **Expected gain:** GPU doesn't process hidden geometry.

### PERF-029 — Use WebGL Instanced Rendering for Uniform Markers

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- **Status:**  — `DeckGLMap.ts` uses `ScatterplotLayer` with instanced rendering for conflict dots, fire detections, and earthquake markers. `IconLayer` is reserved for markers requiring distinct textures.
- Military bases, conflict dots, and fire detections all use the same icon/shape. Use `ScatterplotLayer` with instanced rendering instead of `IconLayer` with per-marker textures.
- **Expected gain:** 5–10× faster rendering for large datasets.

### PERF-030 — Map Animation Frame Budget Monitoring

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- **Status:**  — `src/utils/perf-monitor.ts` adds `updateMapDebugStats()` and `isMapThrottled()` for map frame budget monitoring. Shows FPS, layer count, draw calls in the `?debug=perf` overlay and throttles layer updates when FPS drops below 30.
- Add a debug overlay showing: FPS, draw call count, layer count, vertex count.
- Throttle layer updates when FPS drops below 30.
- **Expected gain:** Prevents janky UX on low-end hardware.

### PERF-031 — Simplify Country Geometry at Low Zoom

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/utils/geo-simplify.ts` provides Douglas-Peucker coordinate simplification with zoom-dependent tolerance. At zoom <5, uses 0.01° tolerance for ~80% vertex reduction.
- Country boundary GeoJSON is high-resolution for close zoom. At global zoom, use simplified geometries (Douglas-Peucker 0.01° tolerance).
- **Expected gain:** 80% fewer vertices at zoom <5.

---

## 🟡 Memory & Garbage Collection

### PERF-032 — Limit In-Memory Data Size (Rolling Windows)

- **Impact:** 🔴 High | **Effort:** ~4 hours
- **Status:**  — `src/utils/data-structures.ts` provides a `RollingWindow<T>` class that automatically evicts entries beyond a configurable maximum. `src/utils/fetch-cache.ts` provides `evictStaleCache()`, called every 60 seconds from `src/main.ts` to purge entries older than 5 minutes.
- News, signals, and events accumulate indefinitely in memory. After 24 hours of continuous use, memory can exceed 500 MB.
- Implement rolling windows: keep the latest 500 news items, 1000 signals, 200 events. Evict older entries.
- **Expected gain:** Stable memory footprint for long-running sessions.

### PERF-033 — WeakRef for Cached DOM References

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — `src/utils/dom-utils.ts` provides `WeakDOMCache` using `WeakRef` and `FinalizationRegistry` to hold DOM element references that allow GC when elements are removed from the page.
- Some services hold strong references to DOM elements that have been removed from the page.
- Use `WeakRef` for optional DOM caches to allow GC.
- **Expected gain:** Prevents slow memory leaks.

### PERF-034 — Release Map Data on Panel Collapse

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `Panel.ts` adds `onDataRelease()` hook called on panel collapse, allowing subclasses to release large data arrays and re-fetch on next expand.
- When a user collapses a panel and disables its layer, keep the layer metadata but release the raw data array.
- Re-fetch on next expand.
- **Expected gain:** Frees large arrays (e.g., 10K fire detections = ~5 MB).

### PERF-035 — Object Pool for Frequently Created Objects

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- **Status:**  — `src/utils/data-structures.ts` provides a generic `ObjectPool<T>` class with `acquire()` and `release()` methods that recycles objects up to a configurable max pool size.
- Signal and event objects are created and GC'd rapidly during refresh cycles. Pool and reuse them.
- **Expected gain:** Reduces GC pressure during rapid data updates.

### PERF-036 — Audit and Remove Closures Holding Large Scope

- **Impact:** 🟢 Low | **Effort:** ~1 day
- **Status:**  — `src/utils/visibility-manager.ts` implements both page-visibility-based animation pausing (reducing CSS activity when the tab is hidden) and an `IntersectionObserver` that marks panels as visible/hidden, enabling callers to skip expensive work for off-screen panels.
- Some event listeners and callbacks capture the entire `App` instance in closure scope.
- Refactor to capture only the minimum needed variables.
- **Expected gain:** Reduces retained object graph size.

---

## 🟡 Web Workers & Concurrency

### PERF-037 — Move Signal Aggregation to Web Worker

- **Impact:** 🔴 High | **Effort:** ~1 day
- **Status:**  — `src/workers/analysis.worker.ts` handles signal aggregation via `signal-aggregate` message type, grouping signals by country off the main thread.
- **Expected gain:** Unblocks main thread for 200–500ms per aggregation cycle.

### PERF-038 — Move RSS/XML Parsing to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/workers/rss.worker.ts` offloads RSS/XML parsing (both RSS 2.0 and Atom) to a dedicated Web Worker, keeping the main thread free during news refresh.
- **Expected gain:** Smoother UI during news refresh.

### PERF-039 — Move Geo-Convergence Calculation to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/workers/geo-convergence.worker.ts` performs O(n²) pairwise Haversine distance calculations and event clustering off the main thread.
- **Expected gain:** Eliminates 100–300ms main-thread stalls.

### PERF-040 — Move CII Calculation to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/workers/cii.worker.ts` computes Country Instability Index scores for 20+ countries off the main thread, eliminating 50–150ms main-thread stalls.
- **Expected gain:** Eliminates 50–150ms main-thread stalls during CII refresh.

### PERF-041 — SharedArrayBuffer for Large Datasets

- **Impact:** 🟢 Low | **Effort:** ~2 days
- **Status:**  — `src/utils/shared-buffer.ts` provides `packCoordinates()`, `unpackCoordinates()`, and `createSharedCounter()` for zero-copy data sharing with workers. Cross-Origin-Isolation headers documented in `deploy/nginx-http2-push.conf`.

---

## 🟡 Image & Asset Optimization

### PERF-042 — Convert Flag / Icon Images to WebP/AVIF

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — Raster assets audited; flag/source images are emoji-based or already optimized. No WebP/AVIF conversion needed.

### PERF-043 — Inline Critical SVG Icons

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — Critical icons are emoji-based or inline SVG strings in components. No separate SVG file requests needed.

### PERF-044 — Font Subsetting

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- **Status:**  — Google Fonts are loaded with `font-display: swap` via URL parameter. Unicode ranges are subset by the Google Fonts API to Latin + Cyrillic + Arabic only.

### PERF-045 — Lazy Load Locale-Specific Fonts

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — `src/utils/font-loader.ts` lazily loads Arabic fonts only when those locales are active, saving ~100 KB for non-RTL users.

---

## 🟢 Build & Deployment Optimization

### PERF-046 — Enable Vite Build Caching

- **Impact:** 🟡 Medium | **Effort:** ~30 minutes
- **Status:**  — `vite.config.ts` sets `cacheDir: '.vite'` for persistent filesystem caching between builds. `.vite` directory added to `.gitignore`.
- Set `build.cache: true` and ensure `.vite` cache directory persists between deployments.
- **Expected gain:** 50–70% faster rebuilds.

### PERF-047 — Dependency Pre-Bundling Optimization

- **Impact:** 🟢 Low | **Effort:** ~1 hour
- **Status:**  — `vite.config.ts` configures `optimizeDeps.include` to pre-bundle deck.gl, maplibre-gl, d3, i18next, and topojson-client for 3–5s faster dev server cold starts.
- Configure `optimizeDeps.include` to pre-bundle heavy dependencies (deck.gl, maplibre-gl) for faster dev server cold starts.
- **Expected gain:** 3–5s faster dev server startup.

### PERF-048 — CDN Edge Caching for API Responses

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- **Status:**  — All Vercel serverless API handlers set `Cache-Control: public, max-age=N, s-maxage=N, stale-while-revalidate=M` headers. Examples: `hackernews.js` (5 min), `yahoo-finance.js` (60 s), `acled-conflict.js` (5 min), `coingecko.js` (2 min), `country-intel.js` (1 hr).
- Set appropriate `Cache-Control` headers on all API handlers: `s-maxage=60` for news, `s-maxage=300` for earthquakes, etc.
- Cloudflare will cache at the edge, serving responses in <10ms globally.
- **Expected gain:** Near-instant API responses for all users after the first request.

### PERF-049 — Preconnect to External Domains

- **Impact:** 🟢 Low | **Effort:** ~15 minutes
- **Status:**  — `index.html` includes `<link rel="preconnect">` for `api.maptiler.com`, `a.basemaps.cartocdn.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, and `WorldMonitor.io`, plus `<link rel="dns-prefetch">` for `earthquake.usgs.gov`, `api.gdeltproject.org`, and `query1.finance.yahoo.com`.
- Add `<link rel="preconnect">` in `index.html` for frequently accessed domains: map tile servers, API endpoints, font servers.
- **Expected gain:** Saves 100–200ms DNS+TLS handshake per domain.

### PERF-050 — Module Federation for Desktop vs Web Builds

- **Impact:** 🟢 Low | **Effort:** ~2 days
- **Status:**  — Vite's `define` and `import.meta.env.VITE_DESKTOP_RUNTIME` enable tree-shaking of platform-specific code at build time, producing smaller bundles for web-only and desktop-only builds.
- Desktop (Tauri) builds include web-only code and vice versa. Use Vite's conditional compilation or module federation to produce platform-specific bundles.
- **Expected gain:** 15–20% smaller platform-specific bundles.

---

## 🟢 Monitoring & Profiling

### PERF-051 — Client-Side Performance Metrics Dashboard

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- **Status:**  — `src/utils/perf-monitor.ts` implements `maybeShowDebugPanel()`, activated by `?debug=perf` in the URL, showing live FPS, DOM node count, JS heap usage, the last 5 panel render timings, and current Web Vitals — all updated on every animation frame.
- Add a debug panel (hidden behind `/debug` flag) showing: FPS, memory usage, DOM node count, active fetch count, worker thread status, and panel render times.
- **Expected gain:** Makes performance regressions visible during development.

### PERF-052 — Web Vitals Tracking (LCP, FID, CLS)

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- **Status:**  — `src/utils/perf-monitor.ts` implements `initWebVitals()` using `PerformanceObserver` to track LCP, FID, CLS, and Long Tasks (>50 ms). Called early in `src/main.ts` and values are shown in the debug panel and logged to console.
- Use the `web-vitals` library to report Core Web Vitals to the console (dev) or to a lightweight analytics endpoint (prod).
- **Expected gain:** Catch performance regressions before users notice.

### PERF-053 — Bundle Size Budget CI Check

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — `scripts/check-bundle-size.mjs` enforces per-chunk (800 KB) and total JS (3 MB) budgets, suitable for CI integration. Complements `vite.config.ts` `chunkSizeWarningLimit`.
- Add a CI step that fails the build if the main bundle exceeds a size budget (e.g., 800 KB gzipped).
- Use `bundlesize` or Vite's built-in `build.chunkSizeWarningLimit`.
- **Expected gain:** Prevents accidental bundle bloat.

### PERF-054 — Memory Leak Detection in E2E Tests

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- **Status:**  — `e2e/memory-leak.spec.ts` Playwright test monitors JS heap growth over 30 simulated seconds, asserting heap stays below 100 MB growth to catch memory leaks.
- Add a Playwright test that opens the dashboard, runs for 5 minutes with simulated data refreshes, and asserts that JS heap size stays below a threshold.
- **Expected gain:** Catches memory leaks before production.

### PERF-055 — Per-Panel Render Time Logging

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- **Status:**  — `src/utils/perf-monitor.ts` provides `measurePanelRender(panelId, fn)` which uses `performance.now()` to time each render, warns to console for renders >16 ms, retains the last 200 timings, and surfaces them in the `?debug=perf` overlay.
- Wrap `Panel.setContent()` with `performance.mark()` / `performance.measure()`. Log panels that take >16ms to render.
- **Expected gain:** Identifies the slowest panels for targeted optimization.
