# SVG map controls and country hit testing

Map controls must apply their own actions without selecting a country or
forcing an unrelated geometry read. An anonymous browser trace demonstrated
that SVG time-filter clicks also ran the country-click handler.

## Demonstrated defect

An anonymous production Chromium trace captured on 19 October at 15:21 UTC,
with fourfold CPU throttling, used the SVG renderer. A time-filter interaction
ran the slider handler and then the map container's country-click handler.
The latter took 28.3 ms, including 27.4 ms of forced style and layout work.
This is one trace sample, not a representative INP estimate.

The slider updates the DOM and renders the map. Its click then bubbles to
the map container, which reads the container geometry and performs a country
lookup. Mouse and touch gesture starts already exclude controls. Country
clicks did not use that exclusion.

`setupZoomHandlers` now applies the existing control exclusion before country
hit testing. Controls retain their own actions. Clicks on the map surface still
select countries.

PR review identified another control surface, `.layer-explanation-popup`,
that the existing selector omitted. The exclusion now covers its content too.
The added DOM case failed before the selector change and passes afterward.
The original map-surface positive control still passes.

The browser check opened the conflict-layer explanation with its information
button, clicked the purpose text, and closed the popup. Country-handler geometry
reads fell from one to zero for that text click. The popup stayed open after
the text click and its close button still worked. The local comparison is in
`.claude/verify-evidence/2026-10-19_16-22-23-svg-explanation-baseline/`
and `.claude/verify-evidence/2026-10-19_16-22-44-svg-explanation-fixed/`.

## Before and after proof

The focused DOM test ran against the original code first. All ten control
cases failed because they read map geometry. The map-surface positive control
passed. After the repair, all eleven cases pass.

```sh
npm run test:dom -- tests/dom/map-svg-country-click.test.mts tests/dom/map-svg-first-paint-deferral.test.mts
node --import tsx --test tests/map-country-drag-click.test.mjs tests/map-input-delay-interactions.test.mts
npm run typecheck
npm run lint:boundaries
```

The browser comparison used the real SVG component and time controls in the
existing map integration fixture. It counted `getBoundingClientRect` calls
inside the country-click listener. A country callback was registered, as on
the dashboard. The click ran after the initial 300 ms suppression window.

| Viewport | Country-handler layout reads per 1-hour click, before | After | Filter state after |
| --- | ---: | ---: | --- |
| 1440 x 900 | 1 | 0 | `1h`, button active |
| 390 x 844 | 1 | 0 | `1h`, button active |

Both browser runs had no console errors or failed HTTP responses. The fixture
controls its country topology and hotspot data. It does not reproduce the
dashboard's complete overlay or panel workload.

Local artifacts are under `.audit/debugbear-live-profile.{json,cpuprofile}`
and `.claude/verify-evidence/2026-10-19_15-27-34-svg-controls-baseline-settled/`
and `.claude/verify-evidence/2026-10-19_15-28-03-svg-controls-fixed/`.
The browser driver and instrumented fixture are `.audit/svg-controls-drive.mjs`
and `.audit/svg-controls.html`. These files remain local. PR screenshots show
the test fixture, not production data.

## Acceptance limits

The measured improvement is one unnecessary geometry read removed per control
click. No representative latency reduction or CWV pass-rate increase is claimed.
The repair covers SVG country-click routing. It does not measure MapLibre,
globe, mission-preset, or other interactions.

After deployment, compare dashboard INP by renderer and control target with a
similar traffic window. A field improvement requires new RUM observations.
