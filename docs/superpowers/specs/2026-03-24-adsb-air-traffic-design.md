# ADS-B Air Traffic: Globe Layer + Sidebar Panel

**Date:** 2026-03-24
**Status:** Approved

## Overview

Add live ADS-B aircraft tracking to World Monitor: a new `adsb` DeckGL globe layer showing all aircraft as altitude-colored dots, and a new `air-traffic` sidebar panel with summary statistics and notable flights. Data source is OpenSky Network (anonymous works; authenticated gives higher rate limits and more aircraft).

## Context

- The existing `military` layer already tracks military aircraft via OpenSky but filters to military-only.
- The existing `flights` layer shows FAA airport delay alerts — not live aircraft positions.
- OpenSky is already proxied through the sidecar with optional credential support (`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`).
- This feature is fully isolated from both of those layers.

## Architecture

### Data Flow

```
OpenSky REST API
  → /api/adsb (new sidecar route, proxied with auth if configured)
    → src/services/adsb.ts (parse, cache 60s, circuit breaker)
      → AirTrafficPanel (stats + notable flights list)
      → DeckGLMap.createAdsbLayer() (ScatterplotLayer on globe)
```

### Components

#### 1. Sidecar route: `/api/adsb`

- New **inline route** in `local-api-server.mjs` (not in the `api/` directory — inline routes have access to `getCached`/`setCached` helpers; `api/` modules do not)
- Proxies `https://opensky-network.org/api/states/all` (all aircraft, worldwide)
- Adds `Authorization: Basic` header if `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET` are set in environment
- Returns the raw OpenSky `{ time, states }` JSON
- No bbox filtering — let the client decide what to render
- Cache response inline using the sidecar's existing `getCached`/`setCached` pattern with a 55s TTL (OpenSky rate limit is 10s for anon, 5s for authenticated; 55s gives safe headroom)
- Note: the existing `/api/opensky` route in `api/opensky.js` uses `Cache-Control` headers only and cannot share this in-process cache — the new inline route is intentionally a different, cacheable pattern

#### 2. Service: `src/services/adsb.ts`

```ts
export interface AdsbFlight {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  lon: number;
  lat: number;
  altitude: number | null;      // barometric, meters
  onGround: boolean;
  velocity: number | null;      // m/s
  heading: number | null;       // true track, degrees
  verticalRate: number | null;  // m/s
  squawk: string | null;
}

export interface AdsbSnapshot {
  flights: AdsbFlight[];
  fetchedAt: number;
  totalCount: number;
}
```

- Parses OpenSky state arrays (same format already used in `military-flights.ts`)
- Filters out `onGround === true` aircraft (reduces noise, ~30% of states)
- Circuit breaker: 3 failures → 5 min cooldown
- Client-side cache TTL: 60s
- Exports `fetchAdsbSnapshot(): Promise<AdsbSnapshot>`
- Exports `getAdsbStats(snapshot)` → top countries, altitude distribution, notable flights

#### 3. Panel: `src/components/AirTrafficPanel.ts`

- Panel ID: `air-traffic`, title: `Air Traffic`
- `priority: 2`, `enabled: true` in FULL_PANELS only
- Fetches via `getApiBaseUrl() + /api/adsb` (same pattern as FuelPricesPanel)
- Refresh: `fetchData()` called on mount; `App.ts` schedules 60s refresh
- Content sections:
  1. **Summary row** — total airborne count, timestamp
  2. **Top 5 countries** — bar-style list with aircraft count
  3. **Notable flights** — up to 8 aircraft matching: squawk 7700/7600/7500 (emergency/radio fail/hijack), altitude > 40,000ft, or callsign matching government/executive patterns (`AF1`, `SAM`, `EXEC`, `VIP`)
- `showCount: true` — panel badge shows current airborne count
- No API key required; shows degraded "limited data" note if OpenSky returns fewer than 1,000 aircraft (sign of rate limiting)

#### 4. Globe layer: `DeckGLMap.createAdsbLayer()`

- Layer ID: `adsb-layer`
- Type: `ScatterplotLayer`
- Data: `AdsbFlight[]` (airborne only, already filtered)
- `getPosition`: `[lon, lat]`
- `getRadius`: 25,000m at low zoom, scaling down
- `radiusMinPixels`: 2, `radiusMaxPixels`: 6
- `getFillColor`: altitude-based gradient:
  - `< 3,000m`: `[100, 200, 100, 180]` (green, low/approach)
  - `3,000–10,000m`: `[255, 200, 50, 180]` (amber, climb/descent)
  - `> 10,000m`: `[200, 220, 255, 200]` (blue-white, cruise)
  - emergency squawk: `[255, 50, 50, 255]` (red, pulsing)
- `pickable: true`; tooltip: callsign, origin country, altitude (ft), speed (kts)
- Wired into `setAdsbFlights()` / `getAdsbLayer()` like other async layers
- Layer key: `adsb` in `MapLayers`

### Type Changes

`src/types/index.ts` — add `adsb` to `MapLayers` interface:
```ts
adsb: boolean;
```

### Config Changes

`src/config/panels.ts`:
- Add `'air-traffic': { name: 'Air Traffic', enabled: true, priority: 2 }` to `FULL_PANELS`
- Add `adsb: false` to **all 8** `MapLayers` objects: `FULL_MAP_LAYERS`, `FULL_MOBILE_MAP_LAYERS`, `TECH_MAP_LAYERS`, `TECH_MOBILE_MAP_LAYERS`, `FINANCE_MAP_LAYERS`, `FINANCE_MOBILE_MAP_LAYERS`, `HAPPY_MAP_LAYERS`, `HAPPY_MOBILE_MAP_LAYERS` — all default `false`
- Add `adsb` to `LAYER_TO_SOURCE`: `adsb: ['adsb']`
- Add `air-traffic` to `PANEL_CATEGORY_MAP` `dataTracking.panelKeys` array (full variant)

`src/services/data-freshness.ts`:
- Add `'adsb'` to the `DataSourceId` string union
- Add a corresponding entry to `SOURCE_METADATA` (e.g., `{ label: 'ADS-B', url: 'https://opensky-network.org' }`)
- Add a corresponding entry to `INTELLIGENCE_GAP_MESSAGES` (e.g., `'ADS-B flight data unavailable'`)
  (Both `SOURCE_METADATA` and `INTELLIGENCE_GAP_MESSAGES` are `Record<DataSourceId, ...>` — omitting `adsb` will fail typecheck)

`src/config/commands.ts`:
- Add `{ id: 'layer:adsb', keywords: ['adsb', 'aircraft', 'planes', 'air traffic'], label: 'Toggle ADS-B aircraft', icon: '✈️', category: 'layers' }`

`src/utils/urlState.ts`:
- Add `'adsb'` to the `LAYER_KEYS` array

`src/locales/en.json` (and all other locale files):
- Add `"components.deckgl.layers.adsbAircraft": "ADS-B Aircraft"` (transport group layer label)
- Add help-text i18n key `components.deckgl.layers.transportAdsb` (following the `transportShipping` / `transportDelays` naming pattern) with value e.g. `"Live aircraft positions from OpenSky Network. Updates every 60 seconds."`

### DeckGLMap layer menu

`src/components/DeckGLMap.ts`:
- Add `{ key: 'adsb', label: t('components.deckgl.layers.adsbAircraft'), icon: '&#9992;' }` to the transport/interference group (alongside `ais` and `flights`)

### App Context

`src/app/app-context.ts`:
- Add `airTrafficPanel?: AirTrafficPanel` to the `AppContext` interface

### Panel Layout

`src/app/panel-layout.ts`:
- Instantiate `AirTrafficPanel` and assign to `ctx.airTrafficPanel` when `air-traffic` is enabled

### Data Loader

`src/app/data-loader.ts`:
- Add `loadAdsb()` method: calls `fetchAdsbSnapshot()`, pushes to `map.setAdsbFlights()`, updates panel via `ctx.airTrafficPanel?.update(snapshot)`
- Add to `loadLayerData()` switch: `case 'adsb': await this.loadAdsb(); break;`
- Add to initial load tasks: `if (this.ctx.mapLayers.adsb) tasks.push({ name: 'adsb', task: ... })`

### App.ts Refresh

`scheduleRefresh` takes positional args, not an object literal:
```ts
this.refreshScheduler.scheduleRefresh(
  'adsb',
  () => this.dataLoader.loadAdsb(),
  60 * 1000,
  () => this.state.mapLayers.adsb || this.panelVisible('air-traffic')
);
```

## Error Handling

- Circuit breaker prevents hammering OpenSky on repeated failures
- Panel shows "OpenSky unavailable" with retry button on error
- Globe layer silently shows stale data (labeled with age) rather than clearing on error
- Anonymous rate limiting (HTTP 429) is handled gracefully — panel shows "Rate limited, retrying in Xm"

## Testing

- Add `air-traffic` to `panel-wiring.test.mjs` panel registration check
- Add a new `VisualScenario` entry to `src/e2e/map-harness.ts` with `enabledLayers: ['adsb']` and `expectedDeckLayers: ['adsb-layer']`
- Add `adsb: false` to the base `MapLayers` objects in `src/e2e/map-harness.ts` and `src/e2e/mobile-map-integration-harness.ts` (TypeScript will enforce this once the type is updated)

## What This Is Not

- Does not replace or modify the `military` layer
- Does not replace the `flights` (FAA delay) layer
- Does not add aircraft trails/history (that's the military layer's feature)
- Does not add AIS (maritime) tracking (separate `ais` layer already exists)
