# Dashboard boot

A visitor opening WorldMonitor gets the live intelligence dashboard: a header with region, mission, search and settings controls; a world map with layer controls; and a grid of data panels. Until the app hydrates they see a pre-rendered skeleton, which must be gone by the time the dashboard is usable.

## Sub-features

- `boot-hydrate` replaces the `index.html` skeleton shell with the real dashboard.
- `boot-header` renders the header controls (`#searchBtn`, `#unifiedSettingsBtn`, `#regionSelect`, `#missionPresetBtn`).
- `boot-map` mounts one of the three map renderers into `#mapContainer` with its layer controls.
- `boot-panels` fills `#panelsGrid` with the variant's panels, each keyed by `data-panel`.
- `boot-status` shows the connectivity indicator (`LIVE` when data is flowing).
- `boot-no-broken-panels` boots no panel straight into an error or unavailable state.

## How to get to it (user POV)

- Open `/dashboard` (the production dashboard route).
- Open `/` on the dev server — Vite's SPA fallback serves the same document.
- Open a variant host's `/dashboard` (`tech`, `finance`, `commodity`, `energy`, `happy`); locally, launch with `WM_VERIFY_VARIANT=<name>`.

## Driving it with wm-verify

Preconditions:

- `wm-verify.sh doctor` reports OK.
- No profile assumptions beyond `steps/_profile.mjs`, which clears storage and dismisses the first-run overlays.

- **Cold visit.** Navigate to `/dashboard`. Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/dashboard-boot.mjs --name dashboard-boot`. Exit code `0`.
- **Hydration.** The step waits for `html[data-wm-event-handlers-ready="true"]` then `html[data-wm-initial-data-ready="true"]`. Both markers exist only because the instance runs with `VITE_E2E=1`.
- **Skeleton gone.** `.skeleton-shell` is absent from the DOM. Its presence means the bundle never took over.
- **Map mounted.** `waitForMap()` resolves to `deckgl`, `globe`, or `svg`, and at least 5 `.layer-toggle[data-layer]` controls exist. The renderer name is logged in the transcript — record which one this run got.
- **Panels populated.** `#panelsGrid .panel[data-panel]` has 3+ entries. A `full`-variant run on this checkout returns 40, starting `live-news, live-webcams, insights, threat-timeline, strategic-posture`.
- **No broken panels.** No panel contains `.panel-error` or `.panel-unavailable`. The step logs the offenders by key rather than only failing.
- **Proof.** `01-booted-dashboard.png` plus `transcript.txt` in the run's evidence directory show the header, map and grid together with the panel keys and renderer.

## Gotchas

- `#mapContainer` is present in the static shell from the first byte, so `expectVisible('#mapContainer')` proves nothing. Only `waitForMap()` proves a renderer mounted — an early DOM read reports `renderer: unknown, canvases: 0, layer control: none`.
- Panel count is variant-dependent. Asserting an exact number pins the test to `full`; assert a floor and log the list.
- A local run reports ~25-40 console errors and ~27 responses ≥400 from the dev server's missing `/api/*` runtime. That is the baseline, not a regression — see the map README.
- `statusText: "LIVE"` reflects the connectivity indicator, not that Edge APIs answered. It goes `LIVE` locally too.
- The service worker never registers locally (`sw.js` is served as `text/html`); that warning is expected.
