# Trade-animation profiling correction — 2026-09-06 (#7781)

**Decision: no layer-isolation change for the measured fixture.** Production-built
assets, visible facilities and trade routes, and three paired repetitions at
each CPU rate did not show a repeatable frame-budget or long-task regression
attributable to the remaining full layer rebuilds.

This replaces the dev-server measurement in merged PR #7803. It is a scoped
hardware-browser result, not field INP acceptance or a claim about every layer
combination, mobile GPU, map viewport or desktop/Tauri device.

## Measurement repairs

- `--start-server` now builds with the normal Vite production configuration,
  adds the map harness as an entry and serves built files with Vite preview.
  Captured script URLs must contain hashed assets and no Vite dev client.
  Sentry source-map uploads and runtime telemetry are disabled for this local run.
- The profiler times `LayerManager.updateLayers` on its prototype because the
  real deck.gl instance is sealed. It counts only the target instance and
  restores the original method after each run. Deferred matching, lifecycle and
  attribute updates are included; `setProps` alone is not a deck commit.
- Each sample records JS layer-building time, the full application update call,
  deferred deck processing, and their total. Build time is contained in the
  update-call bucket and is not added twice. The total is CPU work associated
  with an update, not necessarily one uninterrupted task.
- Hint scans are counted from the guard's actual return value. The profiler no
  longer calls the state-changing guard before the application does.
- The animation stops before two flush frames, so flushing pending deck work
  does not schedule extra animation rebuilds. On/off order alternates across
  repetitions, and CPU-throttle failure aborts rather than silently measuring
  at the wrong rate.
- Renderer-detected software GL and unknown hardware cannot supply hardware
  FPS evidence. Missed frames, over-budget updates and long tasks are compared
  against the trade-off baseline. A warning overlay makes a run invalid.

## Reproduce

Run each command sequentially. JSON on stdout is the report; build diagnostics
use stderr. Builds go to `tmp/trade-animation-production` and preview shuts down
after each command. The screenshot goes to `tmp/trade-animation-profile.png`.

```sh
node scripts/measure-trade-animation-rebuild.mjs --start-server --headed --cpu 1 --repeats 3 --json
node scripts/measure-trade-animation-rebuild.mjs --start-server --headed --cpu 4 --repeats 3 --json
node scripts/measure-trade-animation-rebuild.mjs --start-server --headed --cpu 6 --repeats 3 --json
```

[Raw per-update samples, rAF intervals, renderer and asset URLs](./trade-animation-rebuild-7781.results.json)
are committed. All three profiles were regenerated with reporter commit
`22efbd221bc3b7ac36a08f1bafa04cba7c8ae508` after its final classification change.
Every record now explicitly reports `hardwareGl: true` and `softwareGl: false`.
Recomputing each full report from its raw samples with that reporter exactly
matches the saved output (apart from the newly generated timestamp).
Earlier runs with the layer-warning overlay or the desert
viewport are excluded from this evidence.

Host: Apple M5 Max, Node 24.20.0, headed Playwright Chromium. The actual renderer
was `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)`.
The CPU rates use CDP and do not represent physical slower-device acceptance.

Fixture: 1280×720, zoom 5, longitude 15 / latitude 42 (Europe/Mediterranean),
250 nuclear facilities, 313 data centers, one non-pulsing news marker, 57 route
segments, 21 trips and 9 chokepoints. The camera shows facilities and shipping
routes. Trade-off uses the same camera and non-trade layers. Each window has
20 warmup frames and 61 display frames; native cadence produces about 31
application updates per window, rather than the original simulated fixed 30.

## Results

Milliseconds; update mean/p95 average the three window summaries. Max is the
largest update in any window. Missed intervals (>20 ms) sum all three windows.
The update budget is >16 ms and the long-task budget is >50 ms.

| CPU | On mean update | On p95 update | On max update | Over-budget updates | On long tasks | Missed intervals on / off |
|---|---:|---:|---:|---:|---:|---:|
| 1× | 0.6 | 0.8 | 0.9 | 0 | 0 | 0 / 0 |
| 4× | 2.5 | 4 | 5.8 | 0 | 0 | 0 / 0 |
| 6× | 3 | 4.2 | 5.6 | 0 | 0 | 2 / 1 |

At 6×, 2 missed intervals occurred with trade routes on and 1 with them off.
All update samples stayed below 16 ms and no long tasks were observed. The Wave 1
guard performed zero unchanged hint scans during the measured windows. Recreated non-trade layer objects remain
observable, but this workload does not justify adding layer-isolation state.

## Verification

```sh
node --test tests/map-trade-animation-rebuild.test.mjs tests/measure-trade-animation-rebuild.test.mjs
npm run typecheck
npm run lint:boundaries
```

The execution test uses a sealed manager, exercises real hint invalidation,
accounts for deferred commit time, checks flush-frame exclusion and verifies
method restoration. The browser capture verifies the built and rendered surface.
The production map rendering algorithm is unchanged.
