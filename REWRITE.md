# World Monitor → Live + Dashboard

**Upstream:** [koala73/worldmonitor](https://github.com/koala73/worldmonitor) (AGPL-3.0), pin target **v2.10.0**  
**Surfaces on :3010:**

| Path | Role |
|------|------|
| `/dashboard` | **1:1 World Monitor SPA** — Next redirects to Vite `:3030` (top-level, not iframe). Edit `apps/worldmonitor`. Sparse NPC chrome only with `?npcChrome=1`. |
| `/live` | NPC Live Progress — WM MCP → density charts + geo (not the upstream chrome). |
| `/` | Forecast |

## Run

```bash
pnpm dev              # :3010 + WM dashboard :3030
pnpm dev:web          # Next only
pnpm dev:dashboard    # WM Vite only (http://127.0.0.1:3030/)
pnpm dev:wm           # React rewrite only (:3020) — needs :3030 for /api
pnpm dev:wm:stack     # vanilla :3030 + React :3020 on 127.0.0.1 (IPv4)
```

Open **http://localhost:3010/dashboard** (redirects to `:3030`) or **http://127.0.0.1:3030/** / **http://127.0.0.1:3020/** directly.

Both Vite servers pin **`DEV_HOST=127.0.0.1`** so the React `/api` proxy never dual-stack-misses Windows `[::1]`-only binds. Override with `DEV_HOST=0.0.0.0` only when you need LAN access.

### Production `/api` (React rewrite)

Browser code always uses **same-origin** `/api/*` on loopback (CORS). In production deploy:

1. Reverse-proxy `/api` to `https://api.worldmonitor.app` (same pattern as `apps/worldmonitor/docker/nginx.conf.template`), **or**
2. Set `WM_API_PROXY` / `WM_PROD_API_PROXY` for `vite preview` (defaults to `https://api.worldmonitor.app`).

Do not point loopback pages at the remote API from the client — production CORS rejects bare localhost origins.

Panels use the upstream layout by default (empty **framework** bodies — no feeds). Restore live panel feeds with `?feeds=1` or `localStorage.npcFeeds=1`. Sparse NPC chrome (`?npcChrome=1`) is separate and collapses the rail.

**Design system:** vanilla `:3030` loads [`@npc/astryx-css`](../../packages/astryx-css) v0.2 — semantic `.astryx-*` aligned to `@astryxdesign/core` `theming.targets` (not StyleX pixels). Gallery: `packages/astryx-css/gallery/index.html`. Regenerate: `node packages/astryx-css/scripts/generate-parity.mjs`.

Optional override:

```bash
# apps/web/.env.local
NEXT_PUBLIC_WM_DASHBOARD_URL=http://127.0.0.1:3030/
WORLDMONITOR_API_KEY=wm_xxx
```

## Status — React rewrite `:3020` (2026-09-21)

App: `apps/worldmonitor/react` (`@npc/worldmonitor-react`). Shell is Astryx + Carbon icons; map stack still comes from vanilla `:3030` (DeckGLMap / GlobeMap via `/api` proxy).

**Verdict:** Map chrome is in good shape for day-to-day exploration. Core layout, overlays, time scrubbing, and AI Footprint are usable. Not a full 1:1 of `:3030` yet — feeds, missions depth, and panel parity still lag.

### Working now

| Area | What shipped |
|------|----------------|
| Shell | Astryx `Site` / side nav — Map · Forecast · Status rails |
| Map | `MonitorMap` → DeckGL 2D / Globe 3D; URL state (`lat`/`lon`/`zoom`/`view`/`timeRange`/`timeFocus`/`layers`) |
| Chrome row | MAP title · UTC clock · **2D / 3D / fullscreen** clustered left of **Feeds** (black fill when collapsed) |
| Map tools | Floating toolbar: AI Footprint + Missions / Location / Time / Overlays |
| AI Footprint | Drawer: A–D pillars + E density layers; era accordion seeks TimeNav; closes when a filter menu opens |
| Zoom / recenter | Carbon IconButtons, white squares, vertical stack on the **map canvas** (right edge under chrome) |
| Time scrubber | TimelineJS TimeNav + Astryx/Carbon chrome; map sits above scrubber; overlays stop above it |
| AI boom landmark | Named TimeNav point at **2022-11-30** (ChatGPT) when product layers are on; Time · `all` window starts at earliest active landmark (DC growth → earliest Epoch join date, currently **2010-11-15**) |
| AI DC growth scrub | TimeNav from **earliest Epoch First Operational Date** in the joined catalog (**2010-11-15**, mostly anonymized CN systems), then one marker per year at that year’s first cited opening through 2025. Datacenters layer only. Newest cohort brighter/larger |
| AI era snapshots | **A Product** → ChatGPT…Claude eras (Tech HQs + **Convo Hotspots**) + **AI use · H1/H2/Q** OWID/WildChat waves (**AI Usage**). **C Infrastructure** → Epoch DC · year growth. Seek sets `timeFocus` only; DC density filters by `firstOperationalMs` on **2D and 3D** (Live = existing + planned) |
| AI Usage (OWID + WildChat) | **Country-area choropleth**: OWID population usage share (H1 2025 · H2 2025 · Q1 2026) + **WildChat-1M** country×quarter conversation share for boom-era before H1 2025 (`aggregate_wildchat_ai_usage.py` → join). Metrics labeled separately in tooltips (corpus % ≠ adult adoption %). OpenAI Signals remains an optional population-metric upgrade |
| Convo Hotspots | Product-era attention: wiki (Wikimedia) + Trends (exports) + **GDELT news** (`scrape_gdelt_ai_convo.py` → `join-gdelt-ai-convo-hotspots.mjs`). Social geotags still required. Missing channel ≠ invent |
| AI DC growth | Epoch First Operational Date joined onto `AI_DATA_CENTERS.firstOperationalMs` (`scripts/join-epoch-operational-dates.mjs`). Historical paint strict: dated DCs + accelerator `founded` + techEvent `startDate`; undated out. HQs / startups / cloud **Live only** (no cited open dates) |
| Feeds | Collapsible / resizable right rail (`FeedBento`); collapsed = black Feeds control in chrome-right cluster |
| Layers bridge | `layer-data-bridge` + mission presets; MCP feed meta when configured |
| AI overlay paint | Soft density — A tech HQs + Convo Hotspots (points) + AI Usage (wave markers on globe; hex columns on 2D) · B startups/accelerators · C datacenters/cloud · D AI Policy country polygons on 2D + 3D · E = those layers. Usage/Convo catalogs stay empty until joins (missing ≠ invent); Live Convo may still paint AI-keyword news with hub geo |
| Overlays menu | Includes AI A–E layers alongside core geo overlays |

### Layout rules (chrome)

```
[ MAP ············· UTC clock ············· 2D | 3D | ⛶ | FEEDS ]
[ AI Footprint · Missions · Location · Time · Overlays     ⊕ ⊖ ⊙ ]
[ map canvas …                                              … ]
[ TimelineJS TimeNav ········· AI boom ········ Live ········ ]
```

- **2D / 3D / fullscreen** live in `.wm-map-end-controls` with Feeds — not under the map.
- **Zoom / recenter** stay portaled into `.wm-react-map-canvas`.
- Drawer / dropdowns must not steal scrubber clicks (overlay clips to map height above TimeNav).

### Key files

| Path | Role |
|------|------|
| `react/src/components/MonitorApp.tsx` | Site shell + map / forecast / status |
| `react/src/components/FeedSidebar.tsx` | Layout, toolbar portal, drawer, chrome-end cluster |
| `react/src/components/MapChrome.tsx` | Title + clock; `MapChromeActions` = 2D/3D/FS |
| `react/src/components/MapTimeScrubber.tsx` | TimelineJS host + step / live / zoom chrome |
| `react/src/lib/time-scrubber.ts` | Window spans, ticks, Product + DC growth landmarks |
| `src/config/ai-dc-growth-landmarks.ts` | Epoch-derived DC · year scrub points |
| `src/config/ai-product-growth-landmarks.ts` | Product / frontier TimeNav eras (A) |
| `src/config/ai-era-landmarks.ts` | Shared era defs + merged `AI_TIMELINE_LANDMARKS` |
| `react/src/components/MapNavControls.tsx` | Zoom in / out / recenter |
| `react/src/styles/monitor.css` | Map chrome, drawer, scrubber, nav, feeds |
| `src/config/ai-era-visibility.ts` | Shared Live vs historical visibility (DC / accelerator / techEvent) |
| `react/src/lib/ai-stack-aliases.ts` | A–E aliases + `layersForEraSeek` (replace overlays on era seek). Policy = `aiPolicy` (legislation + discussion), not cyber IOCs |
| `src/config/ai-regulations.ts` | Cited regulation profiles; `listAiPolicyCountryFills()` (+ EU27 expand) for Policy choropleth |
| `src/services/convo-live-news.ts` | Live Convo news channel: tech digest → hub/article geo |
| `src/services/research/index.ts` | `fetchTechEvents` for E density |
| `scripts/join-epoch-operational-dates.mjs` | Regenerate Epoch dates onto `ai-datacenters.ts` |

### Still open / next

- Feeds content is mostly placeholder (“Awaiting port”) — wire live MCP / catalog rows.
- AI Footprint drawer still exposes a Hide control in some states; trim leftover chrome if unwanted.
- Cited open-date joins for tech HQs / startup hubs / cloud regions (historical frames stay empty until then).
- OpenAI Signals country×time population metrics (optional upgrade over WildChat corpus share for boom-era).
- Convo Hotspots: Live merges AI-keyword tech digest items with article lat/lon or title→tech-hub inference (`convo-live-news.ts`). Historical GDELT news via `python scripts/scrape_gdelt_ai_convo.py` then Node join; social geotag corpus still required.
- Policy pillar (`aiPolicy`): country fills from cited `ai-regulations` profiles (implemented vs discussion); EU expands to EU27. Cyber Threats remain a separate overlay.
- Tech Events density: React bridge calls `list-tech-events` when the layer is on.
- Full `:3030` panel / mission / search parity not started in React.
- Screenshot / e2e coverage for chrome + scrubber + drawer.
- Confirm 2D/3D trackpad zoom stays healthy after chrome moves (smoke on both dimensions).

### Regenerate Epoch DC dates

```bash
node scripts/join-epoch-operational-dates.mjs
```

Downloads Epoch’s public GPU-cluster CSV, matches onto `AI_DATA_CENTERS` by name (+ owner/country fallback), writes `firstOperationalMs`. Unmatched / planned-without-date stay `null` (excluded from historical frames).

### AI Usage hexagon overlay

AI Usage paints extruded hex columns (`ColumnLayer` `diskResolution: 6`) at country-centroid share points (OWID / WildChat) — same visual language as [HexagonLayer](https://deck.gl/examples/hexagon-layer). Native `HexagonLayer` GPU shaders fail to compile under MapboxOverlay interleaved MapLibre, so we use ColumnLayer instead. Color + height = `sharePct`.

### Regenerate AI Usage (OWID + WildChat)

```bash
# Boom-era quarters (before OWID H1 2025) — downloads WildChat-1M parquet (~3 GB, HF cache)
python scripts/aggregate_wildchat_ai_usage.py

# Merge WildChat CSV + OWID CSV → src/config/ai-conversation-growth.ts
node scripts/join-owid-ai-conversation-growth.mjs
```

Needs `scripts/_iso3166.csv`, `_country-centroids.csv`. OWID downloads to `_owid-ai-raw.csv` if missing. WildChat writes `_wildchat-usage-by-country-quarter.csv`. Points carry `source: 'owid' | 'wildchat'` — do not treat WildChat corpus % as OWID adult adoption %.

### Regenerate Convo Hotspots (wiki + optional Trends/news)

```bash
node scripts/join-wiki-country-ai-convo-hotspots.mjs
# optional language-edition fallback:
node scripts/join-wiki-ai-convo-hotspots.mjs
```

Wiki channel scrapes Wikimedia **top-per-country** pageviews (`views_ceil`) for AI article titles in each product-era 7-day window — real ISO2 locations + amounts. Countries where the article is outside the daily top list are omitted (missing ≠ invent).

**GDELT news channel (publisher-country article counts):**

```bash
# Prefer the .cmd — Windows `python` often hits the Store stub, not 3.12
scripts\scrape-gdelt.cmd
# or explicitly:
#   "%LocalAppData%\Programs\Python\Python312\python.exe" scripts\scrape_gdelt_ai_convo.py --sleep 20
#   node scripts\join-gdelt-ai-convo-hotspots.mjs --cache-only
```

Join defaults to **cache-only** (no live GDELT). Pass `--fetch` only if you want Node to hit the API. `sourcecountry` is publisher country, not story geotag. If DOC rate-limits, increase `--sleep` or retry later — do not invent counts.

**Google Trends (this repo):**
- Time series + by-region exports: `scripts/_trends-ai-convo/time_series_Worldwide_*.csv` + `by_region_Worldwide_*.csv` → `node scripts/join-google-trends-exports-ai-convo.mjs`. Query: artificial intelligence, worldwide.
- Region ranks are **period-average** (export window); map pins reuse that geo on each product era, **scaled** by monthly global interest. ChatGPT (2022-11) uses Dec-2022 global row when Nov is absent.
- Older single-column global export still supported via `join-google-trends-global-ai-convo.mjs`.

**Live AI news feed:** when Convo is on Live and `newsLocations` already have hub-inferred lat/lon + timestamp, AI-keyword headlines merge into the Convo `news` channel (DeckGL). Geo is title→hub, not publisher geotag; React map does not yet load the AI RSS digest into `newsLocations` (vanilla tech variant does via data-loader).

**Social tags / result counts:** Reddit social-velocity has time + scores but **no lat/lon** — cannot map without inventing geography.

### Invariants

- Missing is not 0 — do not invent needs, capital, NEET, capability, or uncited AI layers.
- `:3020` needs `:3030` (or a proxied API) for `/api` in dev (`pnpm dev:wm:stack`).

## Contract

| Surface | Role |
|---------|------|
| `apps/worldmonitor/` | Upstream AGPL SPA — source of truth for `/dashboard` |
| `apps/worldmonitor/react/` | Astryx React rewrite on **`:3020`** — map-first shell above |
| `packages/astryx-css` (`@npc/astryx-css`) | **Parallel CSS DS** — full Astryx docs catalog as semantic `.astryx-*` classes for vanilla `:3030` |
| `packages/npc-astryx` | Astryx Live chrome + density charts for `/live` (React `@astryxdesign/core`) |
| `GET /api/live/worldmonitor` | MCP → aggregates for `/live` only |
| `GET /api/feeds` | Legacy feed JSON for Forecast |

`/live` treats WM output as **signal density**, never as needs, capital, NEET, or capability.

## Pin vendor tree (optional)

```powershell
cd apps/worldmonitor
git fetch upstream tag v2.10.0
git checkout -f v2.10.0
git clean -fd
```

Hard reset may need local approval if the tree is dirty.
