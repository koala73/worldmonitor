# God's Eye View — vendored upstream

A vendored copy of **God's Eye View** by Bilawal Sidhu, adapted to run
embedded inside AALICE:OpenEYE rather than as a standalone page.

| | |
|---|---|
| Upstream | https://github.com/bilawalsidhu/gods-eye-view |
| Commit | `880a672b5e16ad3e41d318801d3a5203f9201923` |
| Commit date | 2026-08-24T17:02:16-05:00 |
| Vendored on | 2026-08-25 |
| Licence | MIT — see `LICENSE` beside this file |

## Layout

**This directory mirrors upstream's repository root**, deliberately:

```
src/gev/
  style.css  index.html  vite.config.js  package.json   <- upstream root files
  scripts/  config/  docs/  public/                      <- upstream dirs
  src/                                                   <- upstream src/
```

The obvious alternative — flattening upstream's `src/` straight into
`src/gev/` — was tried and reverted. Upstream has ~40 self-consistency tests
that read `../style.css`, `../index.html`, `../vite.config.js`,
`../scripts/*` and `../docs/*` to assert that the JS, the CSS and the markup
stay in step. Flattening broke all of them (45 failures); mirroring the root
fixes them structurally, with no edits to upstream test code. It also makes
re-vendoring close to a straight copy.

Consequence: the app imports from `@/gev/src/...`, not `@/gev/...`.

## What was changed on the way in

Keep this list current — it is what makes a future re-vendor tractable.

1. **`main.js`'s `init()` → `export async function createGevViewer(container, options)`.**
   Upstream ran `init()` at module load and reached into `document` for
   every element. Now it takes its container, scopes all lookups to it,
   returns a handle with `destroy()`, and no longer self-invokes.
2. **`index.html`'s body → `src/chrome.html` + `src/chrome.js`.**
   `renderGevChrome(container)` mounts the markup and injects the Google
   Fonts links. The markup is kept as a separate `.html` imported with
   `?raw` so it stays diffable against upstream's `index.html`.
3. **The Cesium credit container** is appended to the GEV container instead
   of `document.body` — Google's ToS requires it stay visible, and the
   stylesheet targets it as `.gev-root #cesium-credits`.
4. **A missing `GOOGLE_MAPS_API_KEY` no longer throws.** Upstream aborted
   init, which is right for a standalone app but would take a dashboard panel
   down over an optional credential. It now warns and boots on the OSM map
   stack, which `MapStackController` already supports.
5. **`style.css` → `src/styles/gev.css`,** namespaced under `.gev-root` by
   `scripts/vendor-gev-css.mjs`. **Do not hand-edit the generated file** —
   edit `style.css` here and re-run the script. Namespacing is required:
   upstream declares `.panel-header`, `.panel-title` and
   `.panel-collapse-btn` as bare classes that World Monitor also declares,
   plus a `*` reset, an `html, body` rule, and five `:root` custom
   properties that collide with World Monitor's.
6. **`public/` is also copied to World Monitor's `public/` root.** Asset
   URLs are left at their upstream values (`/logo.svg`, `/models/*.glb`,
   …) because none of the 15 files collide with anything World Monitor
   serves. Prefixing them was tried and reverted — it broke
   `data/modelScale.test.mjs`, which derives disk paths from those URLs.
   **If World Monitor ever adds its own `public/logo.svg`, this is where
   the collision will bite.**
7. **The dev-server API proxies in `vite.config.js` are lifted, not copied.**
   `server/gev/gev-api-server.mjs` imports this config, calls its factory and
   replays each `*-proxy` plugin's `configureServer` hook against a plain
   Connect app — those plugins touch only `server.middlewares` and
   `server.httpServer`, and Vite's `middlewares` IS a Connect app, so the
   shim is faithful rather than approximate. Upstream's backend code stays
   byte-identical and a re-vendor picks up new routes for free.

   Routes are mounted under `/api/gev/*`: `/api/opensky` collides with World
   Monitor's own route, and one nginx `location` beats 24. The client half of
   that agreement is applied by `scripts/vendor-gev-api-base.mjs` (run
   `npm run vendor:gev-api` after a re-vendor) and guarded by
   `tests/gev-api-contract.test.mjs`.

   The same app is mounted in all four runtimes: dev and preview via the
   `gev-api` plugin in the root `vite.config.ts`; docker as its own
   supervisord program fed by `scripts/build-gev-api.mjs` (a self-contained
   0.33 MB bundle — `vite` and `vite-plugin-cesium` are aliased to shims in
   `server/gev/shims/` so neither reaches the runtime image); Tauri via
   `src-tauri/sidecar/local-api-server.mjs`.

8. **The opening camera and the first-run launcher are opt-out.**
   `createGevViewer` takes `firstRun` and `initialCamera`, both defaulting to
   `true` so a standalone run is unchanged. World Monitor passes `false` to
   both: it owns onboarding (the mission picker), and `MapContainer`'s region
   view is the opening shot.

   `initialCamera` exists because `flyToAustin` schedules its descent inside
   a `setTimeout(…, 500)`. A host that positions the camera the moment
   `createGevViewer` resolves therefore loses it half a second later, with no
   error and no way to tell from the call site — the map simply opens on
   downtown Austin whatever region was asked for. A share link still takes
   precedence over both.

9. **The viewer can be unmounted, and mounted again.**
   Upstream's `init()` ran once per page load and never tore down, so
   `createGevViewer`'s `destroy()` is entirely fork code. Getting it right
   needed two things upstream had no reason to provide:

   - Each collaborator spells teardown differently — `StyleManager.dispose()`
     (async), the voice controller's `stop({removeUi})`, the annotation
     engine's `clear()`, `DataLayerManager.destroyAll()` (async),
     `IntelHUD.destroy()`. Calling `x?.destroy?.()` on all of them throws
     nothing and tears down nothing; `tests/gev-viewer-lifecycle.test.mjs`
     ties each call site to the method it names so a rename fails loudly.
   - `renderGovernor.js` gained `uninstallRenderGovernor()`. It is a module
     singleton, and a destroyed viewer left in it makes the NEXT mount throw
     inside `initDetection` — the globe could be opened once per page load.
     This restores the contract `installRenderGovernor` already documented:
     before install, render requests are safe no-ops.

   `StyleManager.dispose()` also does not touch the `IntelHUD` it constructs,
   so that is torn down from `main.js` rather than by editing `ui.js`, which
   stays byte-identical.

10. **The loading screen wears OpenEye's identity.**
    `src/chrome.html`'s `#loading-screen` block swaps upstream's logo and
    "GOD'S EYE VIEW" wordmark for the OpenEye eye and "AALICE: OpenEYE" —
    inside OpenEye, a second product announcing itself mid-launch reads as a
    bug rather than a brand. The presentation (palette, glow, rotation
    easing) is overridden in `src/styles/gev-embed.css` so it matches the
    boot ceremony in `src/boot/`, and it lives there rather than in
    `src/styles/gev.css` because that file is generated by
    `scripts/vendor-gev-css.mjs` and loses any edit on the next re-vendor.

    Upstream's `.loader-status` line is untouched: it reports real progress
    ("Flying to Austin…", "Restoring shared view…"), and swapping honest
    status text for a spinner would be a downgrade dressed as a re-skin.

## Environment variables

Upstream reads `GOOGLE_MAPS_API_KEY` and `TOMTOM_API_KEY`. This deployment
carries them as `GEV_GOOGLE_API_KEY` and `GEV_TOMTOM_API_KEY` (the fork's
`.env` already used prefixed names); the mapping is done in the root
`vite.config.ts` `define` block, so the vendored tree stays untouched.
`CESIUM_ION_TOKEN` keeps its upstream name.

Still missing for full functionality: `OPENAI_API_KEY` (voice control only).

## Running upstream's tests

```
npm run test:gev            # upstream's own suite
npm run vendor:gev-css      # regenerate the namespaced stylesheet
npm run vendor:gev-api      # re-apply the /api/gev client prefix
npm run build:gev-api       # bundle the standalone API server
npm run gev:serve           # run that server directly
```

2587 pass / 0 fail / 14 skipped. The skips are allocation-budget tests that
upstream gates to Node 24; this machine runs Node 22.
