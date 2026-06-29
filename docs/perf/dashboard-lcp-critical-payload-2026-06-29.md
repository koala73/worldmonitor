# Dashboard LCP Critical Payload Evidence - 2026-06-29

## Scope

Issue: https://github.com/koala73/worldmonitor/issues/4489

This note records the fresh-worktree implementation slice for the dashboard LCP critical-payload plan:

- Add opt-in final-LCP attribution for `/dashboard`.
- Mark startup gates that can delay shell replacement, map readiness, country geometry, slow bootstrap, first data fan-out, and feed digest timing.
- Move non-LCP precision country geometry and the slow-tier checkpoint out of the awaited visible-data fan-out path.

## Local Changes

- `src/bootstrap/lcp-attribution.ts` exposes `window.__wmLcpDebug` only when `?wm_lcp_debug=1`, `sessionStorage.wm_lcp_debug=1`, `localStorage.wm_lcp_debug=1`, or the matching hyphenated storage key is set. Storage-blocked contexts are handled without throwing during top-level boot.
- LCP snapshots include element tag/id/class/closest marker, capped text, redacted resource URL, viewport, DPR, variant, theme, visibility state, and pre-LCP resource groups.
- `src/utils/lcp-debug.ts` provides the shared mark helper so services can mark resource timing without importing from `src/bootstrap/`.
- `src/main.ts` installs the observer before `new App('app')`.
- `src/App.ts`, `src/app/panel-layout.ts`, `src/components/MapContainer.ts`, and `src/services/country-geometry.ts` add `performance.mark()` checkpoints for boot, layout, map, slow tier, country geometry, actual geometry fetch, and initial data fan-out.
- `src/app/data-loader.ts` marks `/api/news/v1/list-feed-digest` start, ready, and error timing so the digest can be proven in or out of the pre-LCP path.
- `src/App.ts` starts the slow-tier wait as a background checkpoint and starts `preloadCountryGeometry()` only after initial visible data fan-out completes. Correlation and country-learning now wait on that background geometry work instead of blocking the first data fan-out.
- `src/app/data-loader.ts` replays cached geometry-sensitive CII inputs after deferred country geometry is ready, preserving country attribution without reintroducing a pre-fanout await.
- `scripts/measure-mobile-mainthread.mjs` enables LCP debug during browser measurement and includes the LCP candidate, context, and resource groups in the JSON and human reports.

## Verification Run

Fresh isolated worktree:

```bash
git worktree add -b codex/4489-lcp-critical-payload-worktree /tmp/worldmonitor-issue-4489-lcp origin/main
npm run worktree:bootstrap
```

Result: dependencies installed in the isolated worktree. No `.env.local` or `.env` source was available to link, so live credentialed data sources fell back to their local unauthenticated behavior during browser runs.

Focused attribution, bootstrap, and measurement tests:

```bash
./node_modules/.bin/tsx --test tests/lcp-attribution.test.mts tests/lcp-attribution-contract.test.mjs tests/measure-mobile-mainthread.test.mts tests/bootstrap.test.mjs
```

Result: 65 tests passed. Coverage includes debug flag parsing, storage-blocked contexts, URL redaction, resource classification, startup mark contracts, the slow-tier/country-geometry fan-out guard, and mobile measurement report shaping.

TypeScript:

```bash
npm run typecheck
```

Result: passed.

Full build and built-output guards:

```bash
npm run build:full
./node_modules/.bin/tsx --test tests/dashboard-critical-css.test.mjs tests/panel-cluster-chunks.test.mjs tests/dashboard-eager-chunks.test.mjs
```

Result: build passed and emitted `dist/dashboard.html`. Built-output guards passed 54 tests. Known lazy chunks, Sentry, opt-in data tables, secondary settings/checkout, and post-paint enrichment chunks stayed out of dashboard HTML modulepreloads; large dashboard CSS stayed off the render-blocking stylesheet path.

Browser LCP/shell coverage:

```bash
npx playwright test e2e/prehydration-shell.spec.ts e2e/dashboard-lcp-attribution.spec.ts
```

Result: 5 tests passed. Desktop and mobile LCP debug runs captured final candidates plus core boot/map marks, and the pre-hydration shell remained contentful before the dashboard bundle hydrated.

Adjacent browser regression pass:

```bash
npx playwright test e2e/dashboard-cls.spec.ts e2e/runtime-fetch.spec.ts
```

Result: 21 tests passed and 3 existing runtime-fetch assertions failed in areas not touched by this patch:

- `update badge picks architecture-correct desktop download url`: expected `worldmonitor.app`, received `api.worldmonitor.app`.
- `loadMarkets keeps Yahoo-backed data when Finnhub is skipped`: direct harness render assertion did not observe market rows.
- `fetchHapiSummary maps proto countryCode to iso2 field`: direct harness fixture returned a shape that tripped `Object.entries` on null/undefined.

The two `dashboard-cls.spec.ts` tests passed. No files related to the three failing assertions are modified by this patch.

Full data/unit suite:

```bash
npm run test:data
```

Result: passed with 11,813 passing tests, 6 skipped, 0 failures.

Local deterministic mobile measurement:

```bash
VITE_E2E=1 npm run dev -- --host 127.0.0.1 --port 4173
node scripts/measure-mobile-mainthread.mjs http://127.0.0.1:4173/dashboard?wm_lcp_debug=1 --cpu 4 --settle 15000 --json
```

Result:

- LCP candidate: `p.skeleton-map-copy`
- Closest marker: `shell`
- Start time: 884 ms
- Size: 18,356
- Pre-LCP resources: `script` group only, 2 entries, 237,940 transfer bytes
- Viewport: 430 x 740, DPR 3, dark theme
- DOM after settle: 1,576 total nodes, 734 panel nodes, 250 map SVG nodes
- Long task summary in this local dev run: 38 tasks, 37 long tasks, 6,100 ms TBT

The measurement indicates the local mobile final candidate remained the pre-hydration shell copy in this run. `countries.geojson`, map topology, bootstrap slow tier, and `/api/news/v1/list-feed-digest` did not appear in the pre-LCP resource groups for the captured candidate.

## Follow-Up Evidence Needed

After deploy, capture preview and production runs with `?wm_lcp_debug=1` on mobile and desktop and record:

- final LCP candidate selector and closest marker;
- whether the shell candidate is superseded after hydration;
- pre-LCP resource groups for entry JS/CSS, map topology, country geometry, bootstrap, and feed digest;
- whether `/api/news/v1/list-feed-digest` appears before final LCP and needs a narrower visible-category scheduling change.

Field validation still requires PageSpeed Insights median-of-3 after deploy and a delayed CrUX follow-up because field data uses a rolling 28-day window.
