# Map layers

The layer controls under the map decide what a user sees on it — conflicts, hotspots, sanctions, military activity, weather and the rest. Toggling one must change the map, update the shareable URL, and be remembered next visit.

## Sub-features

- `layer-toggle` turns a layer on or off from the map's own control.
- `layer-url` reflects the active set in `?layers=` so the view is shareable.
- `layer-persist` stores the set under `worldmonitor-layers`.
- `layer-explain` opens the per-layer explanation from `.layer-explain-btn[data-layer="…"]`.
- `layer-svg-cap` disables further layers at 9 active in the SVG renderer (`limit-reached`).
- `layer-dimension` switches renderer between 2D and 3D from `#mapDimensionToggle`.
- `aircraft-emergencies` enables the separate 7500/7600/7700 layer on SVG and DeckGL, opens aircraft details, and checks conflict, missing position, unavailable, expiry, and successful empty states. The globe does not offer this layer.

- `notam-airspace` enables the Aviation layer, proves the on-demand `notamAirspace` key (FAA NMS airspace areas) is fetched only once Aviation is on and only on deck.gl, hovers a drawn restriction for its tooltip, and checks there is no separate NOTAM toggle.

Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/notam-airspace.mjs --name notam-airspace` with `WM_VERIFY_HEADED=1` for deck.gl. It replays rows built from `tests/fixtures/nms-notam-geojson.json` by the seeder's own functions, plus one labelled synthetic polygon, because NMS staging ships polygons only on runway NOTAMs. Set `WM_VERIFY_NOTAM_FIXTURE=<payload.json>`, `WM_VERIFY_CENTER=lon,lat` and `WM_VERIFY_ZOOM` for a density view of a larger payload. The step re-serves the basemap with a CORS header because the tile hosts reject localhost origins. It does not prove live NMS data.

Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/aircraft-emergencies.mjs --name aircraft-emergencies`. Set `WM_VERIFY_MOBILE=1` for 390px mobile, or `WM_VERIFY_HEADED=1` for a real GPU desktop map. The step explicitly uses synthetic responses and a controlled clock. It does not prove live provider detection.
Set `WM_VERIFY_HEADED=1 WM_VERIFY_CURRENT_ONLY=1` for a separate current-signal visual check with native animation timers. It waits for the DeckGL overlay to mount and selects the synthetic Washington marker at the fixed desktop viewport.

## How to get to it (user POV)

- Choose a layer chip under the map on the dashboard.
- Open a link whose `?layers=` list differs from the default.
- Apply a mission preset, which sets a layer set in one action.

## Driving it with wm-verify

Preconditions:

- `wm-verify.sh doctor` reports OK.
- The step calls `waitForMap()` first and picks its handles from the renderer it reports.

- **Boot state.** Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/map-layers.mjs --name map-layers`. `conflicts` must start enabled.
- **Turn it off.** Choose the `conflicts` chip. `.layer-toggle[data-layer="conflicts"]` click. The control turns off, `?layers=` loses `conflicts`, and `localStorage['worldmonitor-layers'].conflicts === false`.
- **Turn it back on.** Choose it again. All three observables return to on.
- **Renderer coverage.** Headless runs drive the `svg` renderer; add `WM_VERIFY_HEADED=1` to drive `deckgl`. Both were exercised on this checkout and both pass. A run that covers only one renderer has covered only one DOM.
- **Proof.** `01-layer-on.png`, `02-layer-off.png`, `03-layer-restored.png`, plus the transcript's three state triples.

## Gotchas

- **The control is a different element per renderer.** In the SVG renderer it is `button.layer-toggle[data-layer="…"]` and its state is the `active` class. In the deck.gl / globe renderers it is a label wrapping a checkbox, and the state is `.layer-toggle[data-layer="…"] input:checked`. Reading `input.checked` under SVG returns `null` and reading the `active` class under deck.gl is always false.
- **Which renderer you get is decided by WebGL, and headless has none.** `MapContainer.hasWebGLSupport()` explicitly rejects a `swiftshader` / `llvmpipe` / `software rasterizer` renderer string, so headless Chromium always lands on the SVG map — with or without `--use-gl=swiftshader`, and with or without `--enable-unsafe-swiftshader`. Only a headed run with real GPU GL mounts deck.gl. The repo's own `playwright.config.ts` forces swiftshader, so its dashboard specs also run against the SVG map.
- `?layers=` is written on a 250 ms debounce; it can be absent from the URL entirely until the first map-state sync fires. Poll for the parameter.
- `limit-reached` on a chip is the SVG renderer's 9-layer cap (`MAX_SVG_LAYERS`), not a premium gate. Turning one layer off frees a slot.
- Turning a layer on starts real data work (AIS opens a stream, flights flip the airline panel to live). Leave the layer set as you found it.
- Pick another layer with `WM_VERIFY_LAYER=<key>`. Valid keys on this checkout: `conflicts, hotspots, sanctions, protests, bases, nuclear, irradiators, military, cables, pipelines, outages, datacenters, ais, flights, gpsJamming, natural, weather, economic, waterways`.
