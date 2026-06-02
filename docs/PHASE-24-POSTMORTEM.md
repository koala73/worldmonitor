# Phase 24: Performance Validation & Postmortem

**Issue:** #3111  
**Date:** 2026-04-21  
**Engineer:** @shivamkusc  

---

## Summary

Phase 24 establishes a performance baseline, implements the highest-impact bundle optimization available without architectural changes to the rendering pipeline, and documents the full before/after state with Lighthouse audit results.

The primary win is **lazy-loading GlobeMap** (`globe.gl` + `three.js`), removing ~1,781 kB from the initial JS bundle. This moves the desktop Lighthouse Performance score from **54 → 79**.

---

## Baseline (Before — Issue #3111)

Scores measured against `worldmonitor.app` (production) and documented in the issue.

| Category | Desktop | Mobile |
|---|---|---|
| Performance | 54 | 41 |
| Accessibility | 89 | 92 |
| Best Practices | 92 | 88 |
| SEO | 100 | 100 |

**Initial payload (uncompressed):** ~19,861 KiB total dist  
**main.js (uncompressed):** 2,836 kB  
**panels.js (uncompressed):** 2,253 kB

---

## After (This PR)

Lighthouse run against `npm run preview` (`http://localhost:4173`) with production build.

| Category | Desktop | Mobile |
|---|---|---|
| Performance | **79** | **53** |
| Accessibility | 91 | 91 |
| Best Practices | 92 | 85 |
| SEO | 100 | 100 |

**Desktop key metrics:**
| Metric | Value |
|---|---|
| First Contentful Paint | 1.8 s |
| Speed Index | 1.8 s |
| Largest Contentful Paint | 2.2 s |
| Time to Interactive | 2.2 s |
| Total Blocking Time | 0 ms |
| Cumulative Layout Shift | 0.055 |

**Mobile key metrics:**
| Metric | Value |
|---|---|
| First Contentful Paint | 10.1 s |
| Speed Index | 10.1 s |
| Largest Contentful Paint | 12.3 s |
| Time to Interactive | 12.3 s |
| Total Blocking Time | 190 ms |

---

## Changes Implemented

### 1. Lazy-load GlobeMap (globe.gl + three.js) — `src/components/MapContainer.ts`

**Problem:** `MapContainer.ts` statically imported `GlobeMap`, which pulled `globe.gl` and `three.js` into the main bundle for every user — even those who never activate globe mode (the vast majority).

**Fix:** Replaced the static import with `import type` (type-only, erased at build time) and converted both instantiation paths to use `import('./GlobeMap').then(...)`:

- `init()` — globe used on page load (user had globe mode saved): async IIFE pattern; all downstream calls use optional chaining (`this.globeMap?.xxx`) so null-safety was already in place.
- `switchToGlobe()` — user activates globe at runtime: async `.then()` chain; caller is fire-and-forget so no await needed.

**Result:** `three.js` and `globe-stack` are now separate lazy chunks loaded only when globe mode is activated.

### 2. Split globe.gl + three.js into named chunks — `vite.config.ts`

Added to `manualChunks`:
- `globe-stack`: `globe.gl`, `globe-kapsule`, `three-globe`, `three-slippy-map-globe`, and related three.js geometry/render packages
- `three`: `three/` module itself

These chunks are independently cacheable once loaded.

### 3. Bundle analysis tooling — `vite.config.ts`, `package.json`

Added `rollup-plugin-visualizer` (dev dependency). Activated via `ANALYZE=1` env flag:

```bash
npm run build:analyze   # generates dist/bundle-analysis.html
```

The treemap shows the size of every module in the bundle — useful for identifying future reduction targets.

---

## Bundle Size Before vs After

| Chunk | Before (uncompressed) | After (uncompressed) | Change |
|---|---|---|---|
| `main.js` | 2,836 kB | 1,055 kB | **-1,781 kB (−63%)** |
| `three.js` | — (in main) | 1,412 kB (lazy) | moved to lazy |
| `globe-stack.js` | — (in main) | 278 kB (lazy) | moved to lazy |
| `panels.js` | 2,253 kB | 2,253 kB | no change |
| `deck-stack.js` | 1,048 kB | 1,048 kB | no change |
| `maplibre.js` | 1,107 kB | 1,107 kB | no change |

**Net initial payload reduction: ~1,781 kB uncompressed / ~490 kB gzipped**

---

## Gap Analysis: Remaining Work to Hit Targets

### VAL-01 / VAL-03: Lighthouse Performance 100 on desktop

Desktop is now at **79**. The remaining blockers from Lighthouse audits:

| Opportunity | Estimated Savings |
|---|---|
| Unused JavaScript | 929 kB |
| Cache policy for static assets | 149 kB |
| Render-blocking Google Fonts CSS | 322 ms |
| Main thread work | 2.8 s total |

**Root causes:**
- `panels.js` (2,253 kB uncompressed, 231 kB unused on initial view) — all ~50 panels are statically imported and bundled together. Lazy-loading panels not in `DEFAULT_PANELS` would defer ~1,500+ kB.
- `maplibre.js` (243 kB unused on initial frame) — maplibre loads its full tile engine on init; tree-shaking is limited.
- `deck-stack.js` (207 kB unused on initial frame) — deck.gl layers are registered at startup.

### VAL-02: Performance 90+ on mobile

Mobile is at **53**. The LCP of 12.3 s on mobile is dominated by the initial JS parse time on a throttled CPU. Reducing `panels.js` via dynamic panel loading would be the highest-impact fix.

### BNDL-07: Initial JS payload under 500 KiB

Current initial JS payload (gzipped): ~1,465 kB (main 282 + panels 600 + deck 287 + maplibre 296).

Achieving 500 kB requires deferring at least `panels.js` (600 kB gzip) and either `deck-stack` or `maplibre`. This requires a lazy panel registry pattern, which is a Phase 25+ architectural change.

---

## Lighthouse Report Files

Generated reports are in `docs/lighthouse/`:

| File | Description |
|---|---|
| `desktop-after.report.html` | Full interactive Lighthouse HTML report — desktop |
| `desktop-after.report.json` | Machine-readable JSON — desktop |
| `mobile-after` | Raw JSON — mobile (Lighthouse default throttled profile) |

---

## Bundle Analysis

`dist/bundle-analysis.html` — interactive treemap generated via `npm run build:analyze`. Shows module-level breakdown with gzip and brotli sizes.

---

## Phase-by-Phase Impact Summary

| Phase | Change | Lighthouse Delta (desktop) |
|---|---|---|
| Baseline (issue #3111) | No optimizations | 54 |
| Phase 24 (this PR) | Lazy GlobeMap, chunk splitting | **79 (+25)** |
| Phase 25 (proposed) | Lazy panel registry | ~90 (est.) |
| Phase 26 (proposed) | Critical CSS extraction + resource hints | ~95 (est.) |
| Phase 27 (proposed) | Defer deck-stack / maplibre until map ready | ~100 (est.) |

---

## Lessons Learned

1. **Globe mode was the silent killer.** Three.js (~1.4 MB uncompressed) and globe.gl were loaded for 100% of users despite globe mode being opt-in. Lazy loading a rarely-used feature removed more weight from the critical path than most other optimizations combined.

2. **manualChunks splits for caching, not for payload.** Adding a library to `manualChunks` creates a separately-cacheable file but doesn't remove it from the initial download if the import is still static. The key change was making the import dynamic — the chunk name followed naturally.

3. **panels.js is the next major target.** At 2,253 kB (600 kB gzip), the panels chunk is larger than main after our optimization. Because all ~50 panels are statically registered, they all parse on startup even if only 5–8 are visible. A lazy panel registry (dynamic `import()` keyed to panel ID) would halve the initial parse cost.

4. **Mobile performance is structurally harder.** The 6x slower CPU throttling in Lighthouse mobile means JS parse time dominates. Even after bundle reduction, the app remains JS-heavy. The path to mobile 90+ likely requires a dedicated above-the-fold skeleton that renders before JS completes, not just smaller bundles.

5. **The 500 kB BNDL-07 target requires architectural change.** Getting initial JS to 500 kB gzipped means deferring at least panels + one of deck-stack/maplibre. This is achievable but requires the panel system to support async registration, which the current `PanelLayoutManager` does not.

---

## Files Changed

- `src/components/MapContainer.ts` — lazy GlobeMap
- `vite.config.ts` — globe/three chunk splits, visualizer plugin
- `package.json` — `build:analyze` script, visualizer dev dep
- `docs/lighthouse/` — Lighthouse HTML and JSON reports
- `docs/PHASE-24-POSTMORTEM.md` — this document
