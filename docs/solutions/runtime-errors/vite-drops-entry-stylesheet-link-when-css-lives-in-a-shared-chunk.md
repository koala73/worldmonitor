---
title: "Vite dropped dashboard.html's stylesheet link, so a failed CSS download aborted the App boot"
date: 2026-09-15
category: runtime-errors
module: vite.config.ts (dashboard build)
problem_type: runtime_error
component: tooling
symptoms:
  - "Sentry WORLDMONITOR-XT at error level, `Unable to preload CSS for /assets/debugbear-rum-<hash>.css`"
  - "Production dashboard.html links no app stylesheet, and main-*.js lists it in the preload list of import('./App')"
  - "With the stylesheet download dropped, the App is never constructed and #app stays on its skeleton"
  - "About 642 KB of first-party CSS ships under a vendor-looking name, debugbear-rum-<hash>.css"
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - testing_framework
tags: [vite, rollup, manual-chunks, css-code-split, preload-css, vite-preload-error, dashboard-html, deferred-stylesheet, debugbear-rum, worldmonitor-xt]
---

# Vite dropped dashboard.html's stylesheet link, so a failed CSS download aborted the App boot

## Problem

PR #8115 moved the dashboard application behind a dynamic `import('./App')` (`src/main.ts:635`). After it merged on 2026-09-14, production builds could ship `dashboard.html` with no link to the dashboard stylesheet. The stylesheet then became a CSS dependency of that dynamic import, so Vite's preload helper fetched it at runtime. When that download failed, the import rejected and the dashboard never booted.

The failure was fatal because nothing handled it. Vite's `handlePreloadError` dispatches a cancelable `vite:preloadError` event and rethrows unless a listener calls `preventDefault()` (`node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:45482-45491`). `installChunkReloadGuard` (`src/bootstrap/chunk-reload.ts:65-82`) reloads once per build per session, keyed in sessionStorage, and never calls `preventDefault()`. The `.catch` on the App import rejects the WebMCP bindings, aborts the controller, and rethrows (`src/main.ts:657-661`). A second failure after the one reload leaves the page on its skeleton.

The link went missing because of a cache in the build-html plugin of Vite 6.4.3. `generateBundle` creates one `analyzedImportedCssFiles` map (`dep-Dm0c1Wj2.js:36623`) and reuses it for every HTML entry in the loop at `:36702`. `getCssFilesForChunk` (`:36672-36698`) behaves like this:

- It returns `[]` for a chunk already in the current traversal's `seenChunks` (`:36673-36675`).
- It caches a chunk's CSS list the first time it analyzes that chunk (`:36690`), even when that happens inside the traversal of a different HTML entry.
- On every later call it returns the cached list, filtered by `seenCss` (`:36677-36682`).

In the investigated build the stylesheet sat inside a shared JavaScript chunk, and other entries could reach the main entry chunk: the App chunk imports `main-*.js`, and `live-channels.html` preloads both `main-*.js` and `App-*.js`. If another entry's traversal visited the shared chunk before it reached main, main's cached CSS list lacked the stylesheet. `dashboard.html` then received no stylesheet tag when its turn came (`:36756`). The outcome depends on HTML processing order. One local build of the unfixed tree dropped the link, and the next build of the same source kept it.

The asset name pointed at the wrong owner. `src/styles/base-layer.css` wraps main.css, header.css, country-deep-dive.css, map-context-menu.css and supply-chain-panel.css in `layer(base)`, and both `src/main.ts:1` and `src/embed-main.ts:1` import it. A chunk dump of the unfixed build, taken in this investigation, showed the main entry with `importedCss: []` and a chunk named `debugbear-rum` holding `base-layer.css`, `lcp-debug.ts`, `web-vitals-utils.ts`, `map-layer-definitions.ts` and `debugbear-rum.ts`, with `importedCss: [debugbear-rum-9hl8Iil4.css]`. Rollup named the chunk after its last module, `src/bootstrap/debugbear-rum.ts`, and Vite names extracted CSS after the chunk. About 642 KB of first-party CSS shipped as `debugbear-rum-*.css`.

## Symptoms

- Sentry WORLDMONITOR-XT, error level: `Error: Unable to preload CSS for /assets/debugbear-rum-<hash>.css`. The top frame is Vite's preload helper, bundled into our clerk chunk.
- The first events came after PR #8115 merged: 3 events from 3 users between 2026-09-14 18:49 and 2026-09-15 08:56 UTC, on Chrome 152 and 153 (two on Android 10, one on Windows).
- The asset served 200, so the downloads were dropped mid-flight rather than missing.
- Production `dashboard.html` (build `c18ab87fae`, measured on 2026-09-15) had no stylesheet link. `main-*.js` listed the CSS in the `__vite__mapDeps` preload list for `import('./App')`.
- A Playwright run against production, with the stylesheet request aborted and service workers blocked, logged two page errors `Unable to preload CSS for /assets/debugbear-rum-9hl8Iil4.css`: one on first load and one after the chunk-reload guard's single reload. The `wm:boot:app-construct` mark (`src/main.ts:636`) never fired, and `#app` kept only its skeleton child. The dashboard stayed dead for that session.

## What Didn't Work

- **Blaming DebugBear.** The asset name suggested a vendor file. The bytes are the dashboard's own layered stylesheet.
- **Ad blockers.** The EasyPrivacy, AdGuard tracking and OISD DebugBear rules are anchored to DebugBear's domains (`||cdn.debugbear.com^`, `||data.debugbear.com^`) and cannot match our origin. Three events in a day also do not fit a deterministic block.
- **The Sentry filter from PR #8174.** The `beforeSend` rule in `src/bootstrap/sentry-init.ts:866-886` drops owned `Unable to preload CSS for /assets/*.css` events. It silences the report for clients on a current bundle. The 2026-09-15 08:56 UTC event came from a tab still running a pre-#8174 build. Affected users still got a dashboard that never booted, and nobody would see it.
- **Rejected: a `vite:preloadError` listener that calls `preventDefault()` for CSS-only failures.** Boot would survive, but whether the stylesheet was linked would still depend on an accidental chunk layout and on the Vite cache behavior.
- **Rejected: have `main.ts` await the deferred `<link>`'s `load` or `error` before booting.** If the link errors before `main.js` attaches its listener, the promise never settles and boot hangs.
- **Verification trap.** `node scripts/bundle-budgets.mjs` without `--check` rewrites `scripts/shared/bundle-budgets.json` from whatever `dist/` holds (`scripts/bundle-budgets.mjs:616-628`, default path at `:123`). Use `npm run bundle:check` (`package.json:59`).

## Solution

PR #8185 (unmerged as of 2026-09-15) gives the layered stylesheet its own CSS-only chunk. The rule sits first in `manualChunks` (`vite.config.ts:1225-1238`), ahead of the `node_modules` rules:

```ts
manualChunks(id) {
  // Give the layered dashboard stylesheet a CSS-only chunk. Vite folds a
  // CSS-only chunk into each importing entry's own CSS, so dashboard.html
  // links it. (Full comment explains WORLDMONITOR-XT.)
  if (id.endsWith('/src/styles/base-layer.css')) {
    return 'dashboard-styles';
  }
  if (id.includes('node_modules')) {
    // existing rules unchanged
```

The existing `deferDashboardStylesheetLinks` step from PR #4393 (`vite.config.ts:402-409`) then rewrites the restored link into its deferred form plus a `<noscript>` copy, and `activateDeferredDashboardStyles` (`src/main.ts:37-45`) flips `media` to `all` at startup. The built `dashboard.html` now carries:

```html
<link rel="stylesheet" crossorigin href="/assets/dashboard-styles-9hl8Iil4.css" nonce="wm-static-bootstrap" media="print" data-wm-deferred-style="dashboard">
```

The content hash matches the old `debugbear-rum-9hl8Iil4.css`, so the CSS bytes are identical. Only the chunk and the link changed.

The built-output section of `tests/dashboard-critical-css.test.mjs` now guards this in two places.

The first is a name check inside "keeps large dashboard CSS off the render-blocking stylesheet path" (`:387-432`). PR #8115's version accepted either a deferred link or a CSS entry in the App preload list (`deferredHrefs.length + deferredAppStylesheetHrefs().length > 0`), so a build that dropped the link still passed. The test now requires a deferred link and requires it to be the `dashboard-styles` chunk (`:408-418`):

```js
assert.ok(deferredHrefs.length > 0, /* deferred data-wm-deferred-style="dashboard" link required */);
assert.deepEqual(
  deferredHrefs.filter((href) => !/^\/assets\/dashboard-styles-[A-Za-z0-9_-]+\.css$/.test(href)),
  [],
  /* a debugbear-rum-*.css name means the CSS moved back into a shared JS chunk */
);
```

The second is a new test, "links every stylesheet the deferred App import preloads" (`:434-447`). It reads the CSS names in the App import's preload list through the test wrapper `deferredAppStylesheetHrefs` (`:163-171`). The wrapper calls `deferredDashboardAppDependencies` (`scripts/bundle-budgets.mjs:195-236`), so the test and the bundle gate share one parser. The test requires each name to be linked from `dashboard.html`:

```js
const linkedHrefs = new Set(stylesheetHrefs(stripNoscript(builtSrc('dist/dashboard.html'))));
const unlinkedHrefs = deferredAppStylesheetHrefs().filter((href) => !linkedHrefs.has(href));
assert.deepEqual(unlinkedHrefs, [], /* message lists the unlinked hrefs */);
```

The Sentry rule in `src/bootstrap/sentry-init.ts:866-886` stays. Lazy chunks with their own CSS, such as the maplibre stylesheet, still go through the preload helper. Only its comment changed.

Verification on the branch:

- Two consecutive `VITE_VARIANT=full vite build` runs both emitted the deferred `dashboard-styles-9hl8Iil4.css` link plus its `<noscript>` copy.
- Playwright on `vite preview` with the stylesheet loading normally: App constructed, one stylesheet link (the helper did not insert a second), rules applied, no errors.
- Playwright on `vite preview` with the stylesheet request aborted: App constructed and init started unstyled, with zero page errors.
- `tests/dashboard-critical-css.test.mjs` 10/10, sentry-beforesend 342, bundle-budgets 50, dashboard-eager-chunks 160. `npm run bundle:check` and `npm run bundle:check:embed` passed, and `tsc` passed.

## Why This Works

Vite treats a CSS-only chunk differently from a JavaScript chunk that happens to contain CSS. A chunk starts as a candidate only when it has no exports (`dep-Dm0c1Wj2.js:43300`) and stops being one when it holds a non-CSS module that renders code (`:43299`, `:43315-43316`). For each remaining pure CSS chunk, Vite copies its `importedCss` into every importing chunk's own `viteMetadata.importedCss` (`:43566-43571`) and deletes the chunk from the bundle (`:43586-43589`). With the manual chunk, the stylesheet is attached to the entry chunks that import `base-layer.css` directly, instead of to a shared chunk that the main entry imports.

The build-html cache loses CSS reached through imports, but it keeps a chunk's own CSS. On a cache miss, `getCssFilesForChunk` walks imports first (`:36684-36689`), stores the array (`:36690`), and then pushes the chunk's own `importedCss` entries that the current traversal has not seen (`:36691-36696`). The array is stored by reference, so those own entries end up in the cache too. The stylesheet can now drop out only in one case. The traversal that first analyzes the entry chunk, which may belong to another HTML entry, would have to visit an earlier chunk that already carries the same CSS file. None of the build runs after the fix hit that case, and the name check turns red if the CSS ever moves back into a shared JavaScript chunk.

With the link present, the preload helper skips the dependency. It checks `document.querySelector(link[href="${dep}"][rel="stylesheet"])` (`:45456`) before creating a link (`:45459-45477`). `import('./App')` no longer waits on the stylesheet, so a dropped download leaves the dashboard unstyled but running, instead of stuck on its skeleton.

## Prevention

- **Keep the built-output guard.** On the unfixed tree the new "links every stylesheet" test depends on build order: it passed on the build that happened to keep the link. The reliable red is "keeps large dashboard CSS off the render-blocking stylesheet path". Its `deferredHrefs.length > 0` assertion fails when the link is dropped, and its `dashboard-styles-*` name check fails when the link survives under the shared chunk's name.
- **Inspect `dist/*.html` whenever an entry's code moves behind a dynamic import.** Check the stylesheet links (`grep -o '<link[^>]*stylesheet[^>]*>' dist/dashboard.html`) and look for `.css` entries in the entry chunk's `__vite__mapDeps` list. Every CSS file in that preload list should already be linked from the HTML. One clean build proves little here, because the cache result depends on HTML processing order.
- **Put CSS shared by several HTML entries in a CSS-only manual chunk.** Match the stylesheet module ID in `manualChunks` before any other rule, so Rollup does not merge it into a shared JavaScript chunk and name it after an unrelated module.
- **Read an asset's size and first bytes before trusting a vendor-looking name.** Hashed asset names come from the chunk, and a chunk is named after one of its modules. A 642 KB `debugbear-rum-*.css` full of `@layer base` rules is ours.
- **Reproduce with Playwright.** Block service workers, abort the stylesheet route, and check the boot mark. `markLcpDebug` records marks only when LCP debugging is enabled (`src/utils/lcp-debug.ts:24-25`), which the `wm_lcp_debug` query parameter turns on (`src/bootstrap/lcp-attribution.ts:72`).

```js
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// Unfixed builds name the stylesheet debugbear-rum-*.css; fixed builds name it dashboard-styles-*.css.
await page.route(/\/assets\/(?:dashboard-styles|debugbear-rum)-[^/]+\.css$/, (route) => route.abort());
await page.goto(`${dashboardUrl}?wm_lcp_debug=1`);
await page.waitForTimeout(15_000);
const constructed = await page.evaluate(
  () => performance.getEntriesByName('wm:boot:app-construct').length > 0,
);
// Broken: constructed === false, errors include "Unable to preload CSS for ...".
// Fixed: constructed === true, errors is empty.
```

## Related Issues

- Sentry WORLDMONITOR-XT: `Unable to preload CSS for /assets/debugbear-rum-*.css`.
- PR #8185: this fix, unmerged as of 2026-09-15.
- PR #8115 (perf: defer dashboard application loading): moved the App behind the dynamic import, which made the missing link fatal, and shipped the permissive stylesheet assertion.
- PR #8174: added the `beforeSend` rule that hid WORLDMONITOR-XT. The rule stays for lazy chunks with their own CSS.
- PR #4393 (perf(dashboard): defer critical app stylesheet): added `deferDashboardStylesheetLinks` and the `media="print"` activation this fix relies on.
- [Local .env presence silently changes Vite bundle output shape](../workflow-issues/vite-bundle-budget-seed-requires-env-clean-build.md): the same build and bundle-budget tooling. Read it before reseeding budgets after a chunk change.
- [A check that can no longer see its target must fail loudly](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md): a `manualChunks` suffix rule can silently match nothing after a file move. The `dashboard-styles` name assertion is the fail-closed guard for this rule.
- [Vite's fourth trampoline rename was no name at all](../logic-errors/name-shaped-trampoline-allowlist-cannot-match-a-nameless-frame.md): another case where Vite/Rollup naming in build output misled a Sentry rule in `src/bootstrap/sentry-init.ts`.
- **Separate finding, not fixed in PR #8185.** `src/live-channels-main.ts:1-3` describes `live-channels.html` as the Tauri desktop entry for the channel management window. It imports only `main.css`, i18n and the live-channels window (`:5-7`), yet the branch build's `dist/live-channels.html` modulepreloads the dashboard `main-*.js` and `App-*.js` chunks. Opening the page, which also serves 200 on production, runs the full dashboard boot (App construct, layout, data load, map). This was verified on production and on the branch build.
