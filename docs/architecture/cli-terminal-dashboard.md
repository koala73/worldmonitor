# WorldMonitor TUI: design and implementation plan

Date: 2026-10-17, map/globe, brief and expand-everything added 2026-10-18. Status: implemented (PR pending). Owner: CLI (`cli/`).

## Intent

Make `worldmonitor` (the npm CLI) a full terminal dashboard. Running the bare
command in a terminal opens an interactive, mouse-aware TUI that shows the same
data the web dashboard shows, including the live news channels and webcams,
with a sci-fi visual language: colour themes, animations, tickers, radar
sweeps, a braille world map. The original web dashboard stays one command away
as `worldmonitor web`.

Why: the web app is the product, but operators, agents and terminal-first users
have only a JSON-printing client today. A TUI turns the existing public data
path into a product surface of its own and makes the CLI worth installing.

## Goals

- `worldmonitor` on a TTY launches the TUI. `worldmonitor tui` is the explicit
  form. All existing subcommands (`tools`, `world`, `risk`, `call`, ...) keep
  working unchanged; non-TTY bare invocation still prints help.
- `worldmonitor web` opens the original web dashboard: inside a repository
  checkout it starts the Vite dev server and opens the browser; anywhere else it
  opens the hosted dashboard in the default browser.
- Shows every bootstrap dataset the dashboard ships, grouped into views:
  Overview, News, Markets, Conflict, Cyber, Climate, Predictions, Live, Intel,
  System. Live view plays the real news channels and webcams in the terminal.
- Mouse: click tabs, panels, list rows, buttons; scroll wheel in lists; keyboard
  parity for everything.
- Themes (at least five), switchable at runtime and persisted. Animations: boot
  sequence, radar sweep, marquee ticker, pulse on critical rows, tab wipe,
  typewriter world brief. All animations can be disabled.
- Zero runtime dependencies, Node 18.17+, ESM, like the rest of `cli/`.

## Non-goals

- Replacing the web map or any premium feature. No new server endpoints.
- A general TUI framework. The engine is private to this package.
- Video decoding in JavaScript. Video playback delegates to `mpv` (with
  `yt-dlp` for YouTube). Without `mpv` the TUI offers to open the stream in the
  browser.

## Anti-goals

- Shipping credentials or reading them from `$HOME`. Only `WORLDMONITOR_API_KEY`
  / `--api-key` are honoured, exactly as today. Preferences (theme, animation
  toggle) live in a small JSON file under the XDG config dir and never hold keys.
- Hammering the API. One bootstrap load at start, then per-view `?keys=`
  refreshes on a timer; news comes from the public digest, not per-feed RSS.

## Data path (verified 2026-10-17 against production)

Base host: `https://api.worldmonitor.app` (the browser's `DEFAULT_WEB_API_URL`;
overridable with `--base-url` / `WORLDMONITOR_BASE_URL`). Every request sends a
descriptive User-Agent; `middleware.ts` rejects empty, short or bot-like UAs.

| Need | Request | Auth | Verified |
|---|---|---|---|
| Fast dashboard data (quotes, earthquakes, insights, predictions, theater posture, risk scores, outages, ...) | `GET /api/bootstrap?tier=fast&public=1` | none | 200, 22 keys, ~165 KB |
| Slow dashboard data (ucdp/unrest events, wildfires, climate, crypto, sanctions pressure, macro, ...) | `GET /api/bootstrap?tier=slow&public=1` | none | 200, 62 keys, ~227 KB |
| On-demand keys: `cyberThreats`, `liveVideoResolved`, `flightDelays`, `forecasts`, `correlationCards` | `GET /api/bootstrap?keys=<one>&public=1` (exactly one key per URL) | none | 200 |
| News by category, already ranked and classified | `GET /api/news/v1/list-feed-digest?variant=full&lang=en&public=1` | none | 200, 18 categories x 20 items |
| Military flights | `GET /api/military/v1/list-military-flights?ne_lat=85&ne_lon=180&sw_lat=-85&sw_lon=-180` | anonymous session | 200 |
| Vessel snapshot (density zones, chokepoints) | `GET /api/maritime/v1/get-vessel-snapshot` | anonymous session | 200 |
| Raw RSS for a specific feed (not used by the TUI; the digest covers news) | `GET /api/rss-proxy?url=<feed>` | anonymous session | 200 |
| Health | `GET /api/health?compact=1` | none | 200 |
| Platform version | `GET /api/version` | none | 200 |
| Anonymous session | `POST /api/wm-session` with `{}` | none | 200 `{ ok, exp, token: "wms_..." }`, 12 h, 30 mints/min/IP |

The session token goes in the `X-WorldMonitor-Key` header, exactly as the
browser sends it. A user API key (`--api-key` / `WORLDMONITOR_API_KEY`) is
sent instead when present. Bootstrap with a session is limited to 120/min/IP,
so refresh timers stay coarse: fast tier 60 s, slow tier 300 s, on-demand
keys 120 s, digest 120 s, flights and vessels 60 s only while their view is
open.

Live streams come from the `src/config/live-video-sources.ts` catalog (HLS
first, then YouTube) snapshotted into the CLI by `scripts/sync-tui-catalog.mjs`;
`youtube.com/channel/UC...` entries resolve through `liveVideoResolved` and
fall back to the channel's `/live` URL, which `yt-dlp` understands.

## Architecture

```
cli/src/tui/
  index.mjs             launch(): terminal setup, main loop, teardown, crash-safe restore
  app.mjs               App state, tabs, focus, routing of keys and clicks, status bar
  term/ansi.mjs         escape sequences, truecolor + 256 fallback, width helpers
  term/screen.mjs       cell buffer, clipping, diff flush, draw primitives
  term/input.mjs        key and SGR-mouse decoder, resize
  ui/theme.mjs          theme registry (neon, matrix, amber, redalert, ice, synthwave)
  ui/widgets.mjs        Panel, List, Table, Sparkline, Gauge, Ticker, Tabs, Button, Scrollbar, Map
  ui/fx.mjs             boot sequence, radar sweep, pulse, wipe, typewriter, marquee
  ui/layout.mjs         grid splitting helpers
  data/client.mjs       HTTP client: anonymous session mint, 401 re-mint, timeouts, close()
  data/store.mjs        source table, refresh schedule, retry backoff, lazy sources
  data/select.mjs       selectors that turn bootstrap and digest payloads into view models
  data/catalog.generated.json  live channels, webcams, world-map bitmap
  views/*.mjs           one module per tab (base.mjs holds shared pane behaviour)
  video.mjs             mpv / yt-dlp / browser fallback, http(s)-only link opener
  web.mjs               `worldmonitor web`: local dev server in a checkout, else hosted
  prefs.mjs             XDG prefs (theme, animations, last view)
scripts/sync-tui-catalog.mjs   generates data/catalog.generated.json from src/config and public/data
```

Engine rules: every frame renders into a `Screen` cell buffer; only changed
cells are flushed. Animations advance on a ticker (default 20 fps, idle 4 fps
when no animation is active). Input never blocks rendering. All terminal state
changes (alt screen, mouse, cursor) are undone in `finally` and on signals.

Boundary rules from `AGENTS.md` hold: `cli/` imports nothing from `src/` or
`server/`; the catalog is generated, not imported.

## Map engine (`cli/src/tui/map/`)

- `world.mjs` decodes the 50 m TopoJSON arcs packed into the catalog (zigzag
  varints, ~250 KB) and rasterizes land per country with an even-odd scanline
  fill in the flat projection, or by inverse-sampling a 1800x900 country mask
  on the globe. Arcs shared by two countries are borders, the rest coastline.
- `geo.mjs` holds the equirectangular and orthographic projections (zoom 1 =
  360° across the viewport; globe zoom scales the disc), zoom-at-cursor, pan
  clamping, great-circle helpers and the subsolar point for the terminator.
- `canvas.mjs` is a braille dot canvas with one colour per cell, a glyph /
  label layer with collision avoidance, and a compositor that paints over
  half-block satellite imagery and applies day/night shading.
- `png.mjs` + `imagery.mjs`: a minimal PNG decoder and a cache that asks NASA
  GIBS (WMS, EPSG:4326, keyless) for exactly the visible bounding box at cell
  resolution; newest request per slot wins (the superseded fetch is aborted),
  two in flight, LRU eviction.
- `backdrop.mjs`: which tiles a viewport needs (one per side when it crosses
  the antimeridian) and the sampler that turns ready tiles and the night-lights
  mosaic into half-block cell colours.
- `shapes.mjs`: segment distance, point-in-ring and polyline length for hit
  testing and the card's measurements.
- `orbit.mjs`: TLE parsing and a Kepler + J2 propagator for satellite
  sub-points and ground tracks.
- `layers.mjs`: the layer registry. Static registries (cables, pipelines,
  nuclear, bases, ports, airports, data centers, finance/tech/commodity sites…)
  come from the catalog; live layers read the store. Every feature carries
  name, position (or polyline / polygon), colour, size, `info` rows for the
  hover card and detail overlay, and optional heading/speed (dead reckoning)
  or TLE (propagation at draw time).
- `views/map.mjs`: hover picking (points, then lines, then polygons, then the
  country under the cursor), pin, detail, search, drag/wheel, keyboard,
  auto-rotation, base-layer and imagery-cell caching per view, and the
  animations (sweep, pulses, quake rings, flowing packets on focused lines,
  terminator, imagery fade-in). `views/map-panels.mjs` draws its toolbar,
  footer, layer sidebar, search box and info card.

## Views

- Overview: braille world map with live blips (earthquakes, conflicts, unrest,
  wildfires, cyber C2), radar sweep, AI world brief (typewriter), top stories,
  market strip, theater posture, data freshness.
- Map: the engine above with every layer, flat/globe, satellite imagery,
  day/night, hover highlighting that dims every other layer, info cards,
  search, persistence of view and layer state.
- Brief: the AI world brief as a page: brief paragraph and numbered story
  lines on the left; on the right the sources a line cites (`[n]` →
  `worldBriefSources[n-1]`) and digest headlines ranked by keyword overlap,
  each expandable and openable.
- News: category tabs from the feed catalog; headline list with source, age and
  tier colour; detail pane with summary and link; `o` opens in browser.
- Markets: indices, commodities, FX, sector heatmap, crypto, Gulf markets,
  macro verdict, ETF flows, stablecoins. Sparklines for every quote.
- Conflict: UCDP events, unrest signals, theater posture, country instability
  (CII) ranking, escalation and military correlation cards, security advisories.
- Cyber: threat indicators by type, DDoS mix, traffic anomalies, outages,
  service statuses.
- Climate: earthquakes, natural events, wildfires, weather alerts, climate
  anomalies, CO2, ocean ice, climate news.
- Predictions: Polymarket style prediction markets by domain and scenario
  forecasts with confidence.
- Live: built-in news channels (by region) and webcams; `Enter` plays in the
  terminal through mpv (`--vo=kitty` on Kitty-protocol terminals, else
  `--vo=tct`); `w` opens an external mpv window; `b` opens in the browser.
- Intel: GDELT intel topics, insights top stories, sanctions pressure, cross
  source signals, spending awards, tech events.
- System: health compact summary, bootstrap freshness per key, theme picker,
  animation toggle, about.

## Controls

Tab / Shift+Tab, 1..9, 0 or Alt+1.. (views past the tenth) switch views; click a tab. Left / Right (h / l)
move between panes inside a view. Arrows, j/k, PgUp/PgDn, g/G move in lists;
wheel scrolls; click a row selects, click again (or Enter) expands it into the
detail overlay (`ui/detail.mjs` describes any record generically; views can
override `describe`). Map: drag pans, wheel zooms at the cursor, hover
highlights a layer, click pins, Enter opens details, `g` globe, `s` satellite,
`i` imagery, `d` day/night, `L` layers panel, `/` search, `z` reset, `p` pause
rotation. `[` `]`
change the News section or the Live region. `t` cycles theme, `T` opens the
theme picker, `a` toggles animations, `r` refreshes the current view, `o` opens
the selected link in the browser, `W` opens the web dashboard, `?` help, `q` /
Ctrl+C quit. Live view: Enter plays in the terminal, `w` in an mpv window, `b`
in the browser, `s` cycles stream sources.

## Verification

- Unit tests (node:test, `cli/test/tui-*.test.mjs`, run by `npm run test:data`):
  ANSI colour fallback, screen diff output, input decoding (keys, SGR mouse),
  client session mint and shutdown, theme contract, layout splitting, store
  scheduling and backoff, selectors with
  fixture bootstrap data, catalog generator `--check`.
- Headless App tests (`cli/test/tui-app.test.mjs`): render every view at
  160x45, 100x30 and 80x24 with fixture data, drive keys, tab clicks, row
  clicks, wheel, theme picker, help, lazy-source wanting, and Live fallbacks.
- Map tests (`cli/test/tui-map.test.mjs`): projection round trips, world
  decoding and antimeridian rendering, PNG decoding of a real GIBS tile,
  imagery cache ordering and errors, orbit propagation, feature building for
  every layer, hover picking, pinning, detail, drag/zoom, globe + satellite
  compositing, layer toggles and persistence, search, dead reckoning, themes,
  the detail overlay in other views and the brief view.
- Manual: run in tmux at 160x45, capture frames of every view, convert to
  HTML, screenshot for the PR.

## Out of scope for this change, noted for later

- Individual AIS vessel positions: the public vessel snapshot carries density
  zones, disruptions and (when present) tanker reports, not per-ship tracks.
- Webcam positions on the map (the catalog has no coordinates for them).
- Sixel / Kitty raster output for imagery instead of half blocks.

- MCP-backed country brief overlay when an API key is present.
- Variant presets (tech, finance, happy) as selectable data profiles.
- Sixel output for terminals without the Kitty protocol.
