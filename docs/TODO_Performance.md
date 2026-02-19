# IntelHQ — Performance Optimization Roadmap

All items below target **end-user perceived speed**: faster initial load, smoother panel rendering,
lower memory footprint, and snappier map interactions. Items are ordered roughly by expected impact.

Priority: 🔴 High impact · 🟡 Medium impact · 🟢 Low impact (polish).

---

## 🔴 Critical Path — First Load & Time to Interactive

### PERF-001 — Code-Split Panels into Lazy-Loaded Chunks

- **Impact:** 🔴 High | **Effort:** ~2 days
- `App.ts` statically imports all 35+ panel components, bloating the main bundle to ~1.5 MB.
- Split each panel into a dynamic `import()` and only load when the user enables that panel.
- **Implementation:** Wrap each panel constructor in `App.ts` with `await import('@/components/FooPanel')`. Use Vite's built-in chunk splitting.
- **Expected gain:** Reduce initial JS payload by 40–60%.

### PERF-002 — Tree-Shake Unused Locale Files

- **Impact:** 🔴 High | **Effort:** ~4 hours
- All 13 locale JSON files are bundled, but the user only needs 1 at a time.
- Dynamically `import(`@/locales/${lang}.json`)` only the active language. Pre-load the fallback (`en.json`) and lazy-load the rest.
- **Expected gain:** Save ~500 KB from initial bundle.

### PERF-003 — Defer Non-Critical API Calls

- **Impact:** 🔴 High | **Effort:** ~1 day
- `App.init()` fires ~30 fetch calls simultaneously on startup. Most are background data (UCDP, displacement, climate, fires, stablecoins).
- Prioritize: map tiles + conflicts + news + CII. Defer everything else by 5–10 seconds using `requestIdleCallback`.
- **Expected gain:** Reduce Time to Interactive by 2–3 seconds on slow connections.

### PERF-004 — Pre-Render Critical CSS / Above-the-Fold Skeleton

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- The page is blank until JavaScript boots. Inline a minimal CSS + HTML skeleton in `index.html` (dark background, header bar, map placeholder, sidebar placeholder).
- **Expected gain:** Perceived load time drops to <0.5s.

### PERF-005 — Enable Vite Chunk Splitting Strategy

- **Impact:** 🔴 High | **Effort:** ~2 hours
- Configure `build.rollupOptions.output.manualChunks` to split:
  - `vendor-mapbox` (deck.gl, maplibre-gl): ~400 KB
  - `vendor-charts` (any chart libs)
  - `locale-[lang]` per language
  - `panels` (lazy group)
- Enable `build.cssCodeSplit: true` for per-chunk CSS.
- **Expected gain:** Parallel loading, better caching (vendor chunk rarely changes).

### PERF-006 — Compress and Pre-Compress Static Assets

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- Enable Brotli pre-compression via `vite-plugin-compression`. Serve `.br` files from Nginx/Cloudflare.
- For the Hetzner server, configure Nginx to serve pre-compressed `.br` with `gzip_static on` and `brotli_static on`.
- **Expected gain:** 20–30% smaller transfer sizes vs gzip alone.

### PERF-007 — Service Worker Pre-Cache Strategy

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- The PWA service worker exists but doesn't pre-cache intelligently. Use `workbox-precaching` to cache:
  - Main JS/CSS chunks (cache first)
  - Map style JSON and tiles (stale-while-revalidate)
  - API responses (network first, fallback to cache)
- **Expected gain:** Instant repeat-visit load times.

---

## 🟡 Runtime Performance — Rendering & DOM

### PERF-008 — Virtualize Panel Content Lists

- **Impact:** 🔴 High | **Effort:** ~1 day
- The `VirtualList.ts` component exists but is not used by most panels. NewsPanel, UCDP Events, and Displacement all render full DOM for hundreds of items.
- Integrate `VirtualList` into every panel that can display >20 rows.
- **Expected gain:** DOM node count drops from ~5000 to ~500. Smooth scrolling.

### PERF-009 — Batch DOM Updates with requestAnimationFrame

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Many panels call `this.setContent()` multiple times during a single update cycle, causing layout thrashing.
- Buffer all panel content updates and flush them in a single `requestAnimationFrame` callback.
- **Expected gain:** Eliminates forced synchronous layouts during refresh.

### PERF-010 — Debounce Rapid Panel Re-renders

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- Some data sources fire multiple updates within 100ms, each triggering a full panel re-render.
- Add a 150ms debounce to `Panel.setContent()` to batch rapid-fire updates.
- **Expected gain:** Fewer re-renders, smoother UI during data bursts.

### PERF-011 — Use `DocumentFragment` for Batch DOM Insertion

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Several components build HTML strings and assign to `innerHTML`. For complex panels, pre-build a `DocumentFragment` off-DOM and append once.
- **Expected gain:** Single reflow per panel update instead of multiple.

### PERF-012 — Remove Inline `<style>` Tags from Panel Renders

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- Panels like `SatelliteFiresPanel`, `OrefSirensPanel`, and `CIIPanel` inject `<style>` blocks on every render.
- Move all panel styles to `src/styles/panels.css` (loaded once). Remove inline `<style>` from `setContent()` calls.
- **Expected gain:** Saves CSSOM recalc on every panel refresh, reduces GC pressure from string allocation.

### PERF-013 — Diff-Based Panel Content Updates

- **Impact:** 🟡 Medium | **Effort:** ~2 days
- Currently `setContent()` replaces the entire panel `innerHTML` on every update. This destroys focus, scroll position, and animations.
- Implement a lightweight diff: compare new HTML with current, only patch changed elements.
- **Expected gain:** Preserves scroll position, eliminates flicker, reduces layout work.

### PERF-014 — CSS `contain` Property on Panels

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- Add `contain: content` to `.panel` and `contain: layout style` to `.panel-body`.
- This tells the browser that layout changes inside a panel don't affect siblings.
- **Expected gain:** Faster layout recalculations during panel updates.

### PERF-015 — CSS `will-change` for Animated Elements

- **Impact:** 🟢 Low | **Effort:** ~30 minutes
- Add `will-change: transform` to elements with CSS transitions (panel collapse, modal fade, map markers).
- Remove after animation completes to free GPU memory.
- **Expected gain:** Smoother animations, triggers GPU compositing.

### PERF-016 — Replace `innerHTML` with Incremental DOM Utilities

- **Impact:** 🟡 Medium | **Effort:** ~3 days
- For dynamic panel content, build a minimal `h()` function that creates elements programmatically instead of parsing HTML strings.
- **Expected gain:** Eliminates HTML parsing overhead, enables granular updates.

---

## 🟡 Data Layer & Network

### PERF-017 — Shared Fetch Cache with SWR (Stale-While-Revalidate)

- **Impact:** 🔴 High | **Effort:** ~1 day
- Create a centralized `fetchWithCache(url, ttl)` utility that:
  - Returns cached data immediately if within TTL.
  - Revalidates in the background.
  - Deduplicates concurrent requests to the same URL.
- Replace all direct `fetch()` calls across services with this utility.
- **Expected gain:** Reduces duplicate network requests by ~50%.

### PERF-018 — AbortController for Cancelled Requests

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- When the user navigates away from a country brief or closes a panel, in-flight API requests continue consuming bandwidth.
- Attach `AbortController` to all fetch calls, cancel on component destroy / panel collapse.
- **Expected gain:** Frees network and memory resources sooner.

### PERF-019 — Batch Small API Calls into Aggregate Endpoints

- **Impact:** 🔴 High | **Effort:** ~2 days
- The app makes 30+ small HTTP requests on init. Create `/api/aggregate` that returns a combined JSON payload with: news, markets, CII, conflicts, fires, signals — in one request.
- **Expected gain:** Reduces HTTP round-trips from ~30 to ~5 on startup.

### PERF-020 — Compress API Responses (Brotli)

- **Impact:** 🟡 Medium | **Effort:** ~1 hour
- Ensure all API handlers set `Content-Encoding` properly and the Nginx proxy is configured for Brotli compression.
- For the local sidecar (`local-api-server.mjs`), add `zlib.brotliCompress` for responses >1 KB.
- **Expected gain:** 50–70% smaller API response payloads.

### PERF-021 — IndexedDB for Persistent Client-Side Data Cache

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- Cache API responses in IndexedDB with timestamps. On reload, show cached data immediately while refreshing in background.
- Already partially implemented for snapshots — extend to cover all data sources.
- **Expected gain:** Near-instant dashboard render on repeat visits.

### PERF-022 — Server-Sent Events (SSE) for Real-Time Updates

- **Impact:** 🟡 Medium | **Effort:** ~2 days
- Replace polling intervals (every 60s for news, every 30s for markets, every 10s for Oref) with a single SSE connection.
- Server pushes only changed data, reducing wasted bandwidth.
- **Expected gain:** Lower latency for updates, fewer network requests.

### PERF-023 — HTTP/2 Server Push for Critical Assets

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Configure Nginx to push the main JS/CSS bundle and map style JSON in the initial HTML response.
- **Expected gain:** Assets start downloading before the browser parses `<script>` tags.

### PERF-024 — API Response Field Pruning

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- Many API handlers return the full upstream response. Strip unused fields server-side (e.g., earthquake response includes waveform URLs, unused metadata).
- **Expected gain:** 20–40% smaller individual responses.

---

## 🟡 Map Rendering Performance

### PERF-025 — deck.gl Layer Instance Pooling

- **Impact:** 🔴 High | **Effort:** ~1 day
- Each data refresh recreates all deck.gl layers from scratch. Instead, reuse layer instances and only update the `data` prop.
- Use `updateTriggers` to control when expensive recalculations happen.
- **Expected gain:** Eliminates GPU re-upload of unchanged geometry.

### PERF-026 — Map Tile Prefetching for Common Regions

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Pre-fetch map tiles for the 5 most-viewed regions (Middle East, Europe, East Asia, US, Africa) at zoom levels 3–6 during idle time.
- Store in service worker cache.
- **Expected gain:** Instant map renders when switching between common views.

### PERF-027 — Reduce Map Marker Count with Aggressive Clustering

- **Impact:** 🔴 High | **Effort:** ~1 day
- When zoomed out globally, render 1000+ individual markers (conflicts, fires, military bases). This kills GPU performance.
- Implement server-side or client-side clustering at zoom levels <8. Show counts, expand on zoom.
- **Expected gain:** 10× fewer draw calls at global zoom.

### PERF-028 — Offscreen Map Layer Culling

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Disable layers whose data is entirely outside the current viewport.
- Use `deck.gl`'s `visible` flag bound to viewport bounds checks.
- **Expected gain:** GPU doesn't process hidden geometry.

### PERF-029 — Use WebGL Instanced Rendering for Uniform Markers

- **Impact:** 🟡 Medium | **Effort:** ~1 day
- Military bases, conflict dots, and fire detections all use the same icon/shape. Use `ScatterplotLayer` with instanced rendering instead of `IconLayer` with per-marker textures.
- **Expected gain:** 5–10× faster rendering for large datasets.

### PERF-030 — Map Animation Frame Budget Monitoring

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- Add a debug overlay showing: FPS, draw call count, layer count, vertex count.
- Throttle layer updates when FPS drops below 30.
- **Expected gain:** Prevents janky UX on low-end hardware.

### PERF-031 — Simplify Country Geometry at Low Zoom

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Country boundary GeoJSON is high-resolution for close zoom. At global zoom, use simplified geometries (Douglas-Peucker 0.01° tolerance).
- **Expected gain:** 80% fewer vertices at zoom <5.

---

## 🟡 Memory & Garbage Collection

### PERF-032 — Limit In-Memory Data Size (Rolling Windows)

- **Impact:** 🔴 High | **Effort:** ~4 hours
- News, signals, and events accumulate indefinitely in memory. After 24 hours of continuous use, memory can exceed 500 MB.
- Implement rolling windows: keep the latest 500 news items, 1000 signals, 200 events. Evict older entries.
- **Expected gain:** Stable memory footprint for long-running sessions.

### PERF-033 — WeakRef for Cached DOM References

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Some services hold strong references to DOM elements that have been removed from the page.
- Use `WeakRef` for optional DOM caches to allow GC.
- **Expected gain:** Prevents slow memory leaks.

### PERF-034 — Release Map Data on Panel Collapse

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- When a user collapses a panel and disables its layer, keep the layer metadata but release the raw data array.
- Re-fetch on next expand.
- **Expected gain:** Frees large arrays (e.g., 10K fire detections = ~5 MB).

### PERF-035 — Object Pool for Frequently Created Objects

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- Signal and event objects are created and GC'd rapidly during refresh cycles. Pool and reuse them.
- **Expected gain:** Reduces GC pressure during rapid data updates.

### PERF-036 — Audit and Remove Closures Holding Large Scope

- **Impact:** 🟢 Low | **Effort:** ~1 day
- Some event listeners and callbacks capture the entire `App` instance in closure scope.
- Refactor to capture only the minimum needed variables.
- **Expected gain:** Reduces retained object graph size.

---

## 🟡 Web Workers & Concurrency

### PERF-037 — Move Signal Aggregation to Web Worker

- **Impact:** 🔴 High | **Effort:** ~1 day
- `signal-aggregator.ts` runs complex correlation, clustering, and scoring on the main thread, blocking UI updates.
- Move the entire aggregation pipeline to a dedicated Web Worker.
- **Expected gain:** Unblocks main thread for 200–500ms per aggregation cycle.

### PERF-038 — Move RSS/XML Parsing to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- XML parsing of 70+ RSS feeds is CPU-intensive. Offload to a worker.
- **Expected gain:** Smoother UI during news refresh.

### PERF-039 — Move Geo-Convergence Calculation to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- `geo-convergence.ts` computes pairwise distances between hundreds of events. O(n²) on the main thread.
- **Expected gain:** Eliminates 100–300ms main-thread stalls.

### PERF-040 — Move CII Calculation to Web Worker

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- `country-instability.ts` calculates scores for 20+ countries with multiple data ingestion stages.
- **Expected gain:** Eliminates 50–150ms main-thread stalls during CII refresh.

### PERF-041 — SharedArrayBuffer for Large Datasets

- **Impact:** 🟢 Low | **Effort:** ~2 days
- For very large datasets (fire detections, flight positions), use `SharedArrayBuffer` to share data between main thread and workers without copying.
- Requires `Cross-Origin-Isolation` headers.
- **Expected gain:** Eliminates data serialization overhead.

---

## 🟡 Image & Asset Optimization

### PERF-042 — Convert Flag / Icon Images to WebP/AVIF

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Any raster images (country flags, source logos) should be served as WebP with AVIF fallback.
- **Expected gain:** 30–50% smaller image payload.

### PERF-043 — Inline Critical SVG Icons

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Icons loaded as separate files (search, settings, etc.) add HTTP requests. Inline them as SVG strings.
- **Expected gain:** Fewer network requests.

### PERF-044 — Font Subsetting

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- If using Google Fonts (Inter, Roboto), subset to Latin + Cyrillic + Arabic + Hebrew character ranges only.
- Use `font-display: swap` to prevent FOIT.
- **Expected gain:** 40–60% smaller font files.

### PERF-045 — Lazy Load Locale-Specific Fonts

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Arabic and Hebrew fonts are large. Only load them when those languages are selected.
- **Expected gain:** Save ~100 KB when not using RTL languages.

---

## 🟢 Build & Deployment Optimization

### PERF-046 — Enable Vite Build Caching

- **Impact:** 🟡 Medium | **Effort:** ~30 minutes
- Set `build.cache: true` and ensure `.vite` cache directory persists between deployments.
- **Expected gain:** 50–70% faster rebuilds.

### PERF-047 — Dependency Pre-Bundling Optimization

- **Impact:** 🟢 Low | **Effort:** ~1 hour
- Configure `optimizeDeps.include` to pre-bundle heavy dependencies (deck.gl, maplibre-gl) for faster dev server cold starts.
- **Expected gain:** 3–5s faster dev server startup.

### PERF-048 — CDN Edge Caching for API Responses

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- Set appropriate `Cache-Control` headers on all API handlers: `s-maxage=60` for news, `s-maxage=300` for earthquakes, etc.
- Cloudflare will cache at the edge, serving responses in <10ms globally.
- **Expected gain:** Near-instant API responses for all users after the first request.

### PERF-049 — Preconnect to External Domains

- **Impact:** 🟢 Low | **Effort:** ~15 minutes
- Add `<link rel="preconnect">` in `index.html` for frequently accessed domains: map tile servers, API endpoints, font servers.
- **Expected gain:** Saves 100–200ms DNS+TLS handshake per domain.

### PERF-050 — Module Federation for Desktop vs Web Builds

- **Impact:** 🟢 Low | **Effort:** ~2 days
- Desktop (Tauri) builds include web-only code and vice versa. Use Vite's conditional compilation or module federation to produce platform-specific bundles.
- **Expected gain:** 15–20% smaller platform-specific bundles.

---

## 🟢 Monitoring & Profiling

### PERF-051 — Client-Side Performance Metrics Dashboard

- **Impact:** 🟡 Medium | **Effort:** ~4 hours
- Add a debug panel (hidden behind `/debug` flag) showing: FPS, memory usage, DOM node count, active fetch count, worker thread status, and panel render times.
- **Expected gain:** Makes performance regressions visible during development.

### PERF-052 — Web Vitals Tracking (LCP, FID, CLS)

- **Impact:** 🟡 Medium | **Effort:** ~2 hours
- Use the `web-vitals` library to report Core Web Vitals to the console (dev) or to a lightweight analytics endpoint (prod).
- **Expected gain:** Catch performance regressions before users notice.

### PERF-053 — Bundle Size Budget CI Check

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Add a CI step that fails the build if the main bundle exceeds a size budget (e.g., 800 KB gzipped).
- Use `bundlesize` or Vite's built-in `build.chunkSizeWarningLimit`.
- **Expected gain:** Prevents accidental bundle bloat.

### PERF-054 — Memory Leak Detection in E2E Tests

- **Impact:** 🟢 Low | **Effort:** ~4 hours
- Add a Playwright test that opens the dashboard, runs for 5 minutes with simulated data refreshes, and asserts that JS heap size stays below a threshold.
- **Expected gain:** Catches memory leaks before production.

### PERF-055 — Per-Panel Render Time Logging

- **Impact:** 🟢 Low | **Effort:** ~2 hours
- Wrap `Panel.setContent()` with `performance.mark()` / `performance.measure()`. Log panels that take >16ms to render.
- **Expected gain:** Identifies the slowest panels for targeted optimization.
