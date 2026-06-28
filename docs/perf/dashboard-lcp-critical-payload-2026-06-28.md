# Dashboard LCP Critical Payload Evidence - 2026-06-28

## Scope

Issue: https://github.com/koala73/worldmonitor/issues/4489

This note records the first implementation slice for the dashboard LCP critical-payload plan:

- Add opt-in final-LCP attribution for `/dashboard`.
- Mark startup gates that can delay shell replacement, map readiness, country geometry, slow bootstrap, first data fan-out, and feed digest timing.
- Move non-LCP country geometry and the slow-tier checkpoint out of the awaited visible-data fan-out path.

## Local Changes

- `src/bootstrap/lcp-attribution.ts` exposes `window.__wmLcpDebug` only when `?wm_lcp_debug=1`, `sessionStorage.wm_lcp_debug=1`, `localStorage.wm_lcp_debug=1`, or the matching hyphenated storage key is set. Storage-blocked contexts are handled without throwing during top-level boot.
- LCP snapshots include element tag/id/class/closest marker, capped text, redacted resource URL, viewport, DPR, variant, theme, visibility state, and pre-LCP resource groups.
- `src/utils/lcp-debug.ts` provides the shared mark helper so services can mark resource timing without importing from `src/bootstrap/`.
- `src/main.ts` installs the observer before `new App('app')`.
- `src/App.ts`, `src/app/panel-layout.ts`, `src/components/MapContainer.ts`, and `src/services/country-geometry.ts` add `performance.mark()` checkpoints for boot, layout, map, slow tier, country geometry, actual geometry fetch, and initial data fan-out.
- `src/app/data-loader.ts` marks `/api/news/v1/list-feed-digest` start, ready, and error timing so U4 can prove whether the digest competes before final LCP.
- `src/App.ts` starts the slow-tier wait as a background checkpoint and starts `preloadCountryGeometry()` only after initial visible data fan-out completes. Correlation and country-learning now wait on that background geometry work instead of blocking the first data fan-out.
- `src/app/data-loader.ts` replays cached geometry-sensitive CII inputs after deferred country geometry is ready, preserving country attribution without reintroducing a pre-fanout await.
- `scripts/measure-mobile-mainthread.mjs` enables LCP debug during browser measurement and includes the LCP candidate/context/resource groups in the JSON and human reports.

## Verification Run

Focused attribution/bootstrap pass:

```bash
npx --yes tsx --test tests/lcp-attribution.test.mts tests/lcp-attribution-contract.test.mjs tests/bootstrap.test.mjs
git diff --check
```

Result: 65 focused tests passed. `git diff --check` reported no whitespace errors. The bootstrap guard now enforces that slow-tier and country-geometry waits stay off the visible data fan-out path, post-geometry CII replay remains wired, and the LCP contract guard includes actual country-geometry fetch plus feed-digest timing marks.

Wider focused guard pass:

```bash
npx --yes tsx --test tests/secondary-startup.test.mts tests/map-mobile-topology.test.mts tests/map-deferred-overlays.test.mts tests/news-loader-sequencing.test.mts tests/lcp-attribution.test.mts tests/lcp-attribution-contract.test.mjs tests/bootstrap.test.mjs tests/measure-mobile-mainthread.test.mts
```

Result: 97 tests passed. Passing coverage included bootstrap, LCP attribution, secondary startup, deferred Umami, mobile topology, map deferred-overlay guards, news digest sequencing, and deterministic mobile measurement report shaping.

Previously attempted broader static/source guard:

```bash
npx --yes tsx --test tests/dashboard-critical-css.test.mjs tests/panel-cluster-chunks.test.mjs tests/dashboard-eager-chunks.test.mjs tests/secondary-startup.test.mts tests/map-renderer-deferral.test.mjs tests/map-mobile-topology.test.mts tests/map-deferred-overlays.test.mts tests/lcp-attribution.test.mts tests/lcp-attribution-contract.test.mjs tests/bootstrap.test.mjs
```

Result: 73 tests passed, 3 test files failed before running assertions because they import the local `typescript` package and this checkout has no `node_modules`: `tests/dashboard-critical-css.test.mjs`, `tests/map-renderer-deferral.test.mjs`, and `tests/panel-cluster-chunks.test.mjs`.

Blocked in this environment:

```bash
npm run typecheck
npx playwright test e2e/dashboard-lcp-attribution.spec.ts
npx playwright test e2e/prehydration-shell.spec.ts
```

Reason: the checkout has no `node_modules`. `npm run typecheck` fails with `tsc: not found`. `npx playwright test e2e/dashboard-lcp-attribution.spec.ts` fails before running assertions because `playwright.config.ts` imports repo-local `@playwright/test`. Full `npm install`, slim `npm install --ignore-scripts --omit=optional --no-audit --no-fund`, and a local TypeScript-only install attempt all failed with `ENOSPC` while extracting dependencies. Incomplete `node_modules` directories were removed after each failed attempt. Current filesystem free space is about 295 MB, so dependency restoration is not possible in this checkout without freeing disk.

## Follow-Up Evidence Needed

After dependencies are available, run:

```bash
npm run typecheck
npx playwright test e2e/prehydration-shell.spec.ts e2e/dashboard-lcp-attribution.spec.ts
node scripts/measure-mobile-mainthread.mjs <local-or-preview-dashboard-url> --cpu 4 --settle 15000 --json
```

Then capture a dashboard run with `?wm_lcp_debug=1` on mobile and desktop and record:

- final LCP candidate selector and closest marker;
- whether the shell candidate is superseded after hydration;
- pre-LCP resource groups for entry JS/CSS, map topology, country geometry, bootstrap, and feed digest;
- whether `/api/news/v1/list-feed-digest` appears before final LCP and needs a U4 scheduling change.

Field validation still requires PageSpeed Insights median-of-3 after deploy and a delayed CrUX follow-up because field data uses a rolling window.
