---
title: "feat: MCP live airspace + maritime query tools"
type: feat
status: active
date: 2026-03-28
---

# MCP Live Airspace & Maritime Query Tools

## Overview

Add two new tools to the MCP endpoint that let AI assistants query **live** ADS-B flight data and AIS vessel activity for any country. Answering "how many planes are over the UAE right now?" or "what vessels are near the Strait of Hormuz?" will go from impossible to a single tool call.

## Problem Statement

The current MCP tool set only returns cached/seeded aggregate data (delays, disruptions, snapshots cached minutes-to-hours ago). There is no way to answer real-time positional queries like:

- "How many civilian planes are over Saudi Arabia right now?"
- "Are there military aircraft over Taiwan today?"
- "What's the vessel traffic density in the Persian Gulf?"

The underlying APIs already exist and accept bounding-box queries:

- `GET /api/aviation/v1/track-aircraft` — live ADS-B positions from OpenSky
- `GET /api/military/v1/list-military-flights` — military aircraft from OpenSky via callsign/hex identification
- `GET /api/maritime/v1/get-vessel-snapshot` — AIS density zones and disruptions

What's missing: a country-code → bounding-box mapping and MCP tool wrappers.

## Proposed Solution

1. **Generate `shared/country-bboxes.json`** — a static 5KB lookup table (169 countries) derived from the existing `public/data/countries.geojson`, keyed by ISO2 code → `[sw_lat, sw_lon, ne_lat, ne_lon]`.
2. **Add `get_airspace` MCP tool** — accepts `country_code` + optional `type` filter (all/civilian/military); calls the two aviation RPCs in parallel; returns merged counts + flight lists.
3. **Add `get_maritime_activity` MCP tool** — accepts `country_code`; calls the vessel snapshot RPC; returns density zones + disruption summary.

No new server-side code, no new protos, no buf generate step. The existing RPCs already support bbox queries.

## Files

### Create

- `scripts/generate-country-bboxes.cjs` — one-time generator (reads GeoJSON, writes JSON)
- `shared/country-bboxes.json` — generated static bbox map (auto-synced by existing test)
- `scripts/shared/country-bboxes.json` — required sync copy (test `scripts/shared/ stays in sync with shared/`)

### Modify

- `api/mcp.ts` — import bbox map, add `get_airspace` and `get_maritime_activity` tools

## Implementation

### Step 1 — Generate bbox table

**`scripts/generate-country-bboxes.cjs`:**
```js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const geojson = JSON.parse(fs.readFileSync(path.join(root, 'public/data/countries.geojson'), 'utf8'));

function coordsFromGeom(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates.flat(1);
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

const result = {};
for (const f of geojson.features) {
  const iso2 = f.properties['ISO3166-1-Alpha-2'];
  if (!iso2 || !f.geometry) continue;
  const coords = coordsFromGeom(f.geometry);
  if (!coords.length) continue;
  let minLat=Infinity, maxLat=-Infinity, minLon=Infinity, maxLon=-Infinity;
  for (const [lon, lat] of coords) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  // [sw_lat, sw_lon, ne_lat, ne_lon] — rounded to 2dp to keep file compact
  result[iso2] = [+(minLat.toFixed(2)), +(minLon.toFixed(2)), +(maxLat.toFixed(2)), +(maxLon.toFixed(2))];
}

const out = path.join(root, 'shared', 'country-bboxes.json');
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`Wrote ${Object.keys(result).length} entries to ${out}`);
```

Run: `node scripts/generate-country-bboxes.cjs`
Then: `cp shared/country-bboxes.json scripts/shared/country-bboxes.json`

### Step 2 — `get_airspace` tool in `api/mcp.ts`

Import at top of file:
```typescript
import COUNTRY_BBOXES from '../shared/country-bboxes.json' assert { type: 'json' };
```

Or via `createRequire` if the assert syntax isn't supported in the build target. Check existing imports in mcp.ts.

Tool definition (add after `get_country_brief`):
```typescript
{
  name: 'get_airspace',
  description: 'Live ADS-B aircraft over a country. Returns civilian flights (OpenSky) and identified military aircraft with callsigns, positions, altitudes, headings. Answers questions like "how many planes are over the UAE right now?" or "are there military aircraft over Taiwan?"',
  inputSchema: {
    type: 'object',
    properties: {
      country_code: {
        type: 'string',
        description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "US", "GB", "JP")',
      },
      type: {
        type: 'string',
        enum: ['all', 'civilian', 'military'],
        description: 'Filter: all flights (default), civilian only, or military only',
      },
    },
    required: ['country_code'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  _execute: async (params, base, apiKey) => {
    const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
    const bbox = (COUNTRY_BBOXES as Record<string, [number,number,number,number]>)[code];
    if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2.` };
    const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
    const type = String(params.type ?? 'all');
    const UA = 'worldmonitor-mcp-edge/1.0';
    const headers = { 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA };
    const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

    type CivilianResp = { positions?: { callsign:string; icao24:string; lat:number; lon:number; altitude_m:number; ground_speed_kts:number; track_deg:number; on_ground:boolean }[]; source?: string; updated_at?: number };
    type MilResp = { flights?: { callsign:string; hex_code:string; aircraft_type:string; aircraft_model:string; operator:string; operator_country:string; location?:{latitude:number;longitude:number}; altitude:number; heading:number; speed:number; is_interesting:boolean; note:string }[]; pagination?:{total_count?:number} };

    const [civResult, milResult] = await Promise.allSettled([
      type === 'military' ? Promise.resolve(null) :
        fetch(`${base}/api/aviation/v1/track-aircraft?${bboxQ}`, { headers, signal: AbortSignal.timeout(8_000) })
          .then(r => r.ok ? r.json() as Promise<CivilianResp> : null),
      type === 'civilian' ? Promise.resolve(null) :
        fetch(`${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`, { headers, signal: AbortSignal.timeout(8_000) })
          .then(r => r.ok ? r.json() as Promise<MilResp> : null),
    ]);

    const civ = civResult.status === 'fulfilled' ? civResult.value : null;
    const mil = milResult.status === 'fulfilled' ? milResult.value : null;

    const civilianFlights = (civ?.positions ?? []).slice(0, 100).map(p => ({
      callsign: p.callsign, icao24: p.icao24,
      lat: p.lat, lon: p.lon,
      altitude_m: p.altitude_m, speed_kts: p.ground_speed_kts,
      heading_deg: p.track_deg, on_ground: p.on_ground,
    }));
    const militaryFlights = (mil?.flights ?? []).slice(0, 100).map(f => ({
      callsign: f.callsign, hex_code: f.hex_code,
      aircraft_type: f.aircraft_type, aircraft_model: f.aircraft_model,
      operator: f.operator, operator_country: f.operator_country,
      lat: f.location?.latitude, lon: f.location?.longitude,
      altitude: f.altitude, heading: f.heading, speed: f.speed,
      is_interesting: f.is_interesting, note: f.note || undefined,
    }));

    return {
      country_code: code,
      bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
      civilian_count: civilianFlights.length,
      military_count: militaryFlights.length,
      ...(type !== 'military' && { civilian_flights: civilianFlights }),
      ...(type !== 'civilian' && { military_flights: militaryFlights }),
      source: civ?.source ?? 'opensky',
      updated_at: civ?.updated_at ? new Date(civ.updated_at).toISOString() : new Date().toISOString(),
    };
  },
},
```

### Step 3 — `get_maritime_activity` tool

```typescript
{
  name: 'get_maritime_activity',
  description: "Live vessel traffic and maritime disruptions for a country's waters. Returns AIS density zones (ships-per-day, intensity score), dark ship events, and chokepoint congestion. Covers major shipping lanes adjacent to the country.",
  inputSchema: {
    type: 'object',
    properties: {
      country_code: {
        type: 'string',
        description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "SA", "JP", "EG")',
      },
    },
    required: ['country_code'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  _execute: async (params, base, apiKey) => {
    const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
    const bbox = (COUNTRY_BBOXES as Record<string, [number,number,number,number]>)[code];
    if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2.` };
    const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
    const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;
    const headers = { 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' };

    type VesselResp = { snapshot?: { snapshot_at?: number; density_zones?: {name:string;intensity:number;ships_per_day:number;delta_pct:number;note:string}[]; disruptions?: {name:string;type:string;severity:string;dark_ships:number;vessel_count:number;region:string;description:string}[] } };

    const res = await fetch(`${base}/api/maritime/v1/get-vessel-snapshot?${bboxQ}`, {
      headers, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`get-vessel-snapshot HTTP ${res.status}`);
    const data = await res.json() as VesselResp;
    const snap = data.snapshot ?? {};

    return {
      country_code: code,
      bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
      snapshot_at: snap.snapshot_at ? new Date(snap.snapshot_at).toISOString() : new Date().toISOString(),
      total_zones: (snap.density_zones ?? []).length,
      total_disruptions: (snap.disruptions ?? []).length,
      density_zones: (snap.density_zones ?? []).map(z => ({
        name: z.name, intensity: z.intensity, ships_per_day: z.ships_per_day,
        delta_pct: z.delta_pct, note: z.note || undefined,
      })),
      disruptions: (snap.disruptions ?? []).map(d => ({
        name: d.name, type: d.type, severity: d.severity,
        dark_ships: d.dark_ships, vessel_count: d.vessel_count,
        region: d.region, description: d.description,
      })),
    };
  },
},
```

### Step 4 — JSON import in mcp.ts

The MCP file uses `import` ESM syntax. The `country-bboxes.json` import must be compatible with Vercel edge bundling. Check how other JSON is currently imported — if there are no existing JSON imports, use the inline-require pattern to avoid bundler issues:

```typescript
// At top of _execute, not module-level:
// If JSON import assertions aren't supported, embed as a const inline
// OR import using createRequire pattern
```

**Safest pattern for Vercel edge:**
Import the JSON inline as a TypeScript `const`:
```typescript
// shared/country-bboxes.json is committed to the repo
// Import via TS resolveJsonModule
import COUNTRY_BBOXES from '../shared/country-bboxes.json';
```
Ensure `tsconfig.api.json` has `"resolveJsonModule": true`. Check and add if missing.

## Sample Responses

### get_airspace example

```json
{
  "country_code": "AE",
  "bounding_box": { "sw_lat": 22.62, "sw_lon": 51.57, "ne_lat": 26.06, "ne_lon": 56.38 },
  "civilian_count": 47,
  "military_count": 3,
  "civilian_flights": [
    { "callsign": "UAE123", "icao24": "894ab2", "lat": 24.5, "lon": 54.3, "altitude_m": 11000, "speed_kts": 480, "heading_deg": 270, "on_ground": false }
  ],
  "military_flights": [
    { "callsign": "UAE-AF1", "aircraft_type": "TRANSPORT", "lat": 24.4, "lon": 54.6, "altitude": 5000, "heading": 180 }
  ],
  "source": "opensky",
  "updated_at": "2026-03-28T10:15:00Z"
}
```

### get_maritime_activity example

```json
{
  "country_code": "AE",
  "bounding_box": { "sw_lat": 22.62, "sw_lon": 51.57, "ne_lat": 26.06, "ne_lon": 56.38 },
  "snapshot_at": "2026-03-28T10:15:00Z",
  "total_zones": 2,
  "total_disruptions": 1,
  "density_zones": [
    { "name": "Strait of Hormuz", "intensity": 82, "ships_per_day": 45, "delta_pct": 3.2 }
  ],
  "disruptions": [
    { "name": "Gulf AIS Gap", "type": "AIS_DISRUPTION_TYPE_GAP_SPIKE", "severity": "AIS_DISRUPTION_SEVERITY_ELEVATED", "dark_ships": 3, "vessel_count": 12, "region": "Persian Gulf", "description": "..." }
  ]
}
```

## Edge Cases

| Case | Handling |
|------|----------|
| Unknown country code | Return `{ error: "Unknown country code: XX" }` |
| API timeout/failure | `get_airspace`: parallel `Promise.allSettled` — partial data returned; `get_maritime_activity`: throw to MCP error handler |
| No flights found | Return empty arrays + count 0 |
| Large countries (RU, US, CA) | bbox spans wide area, results capped at 100 per category |
| Antimeridian crossing (RU, US-AK, NZ) | OpenSky handles this correctly with min/max lon |
| Country code not in bbox map (small territories) | ~89 features have null geometry in GeoJSON; return error with suggestion |

## Verification

1. `npm run typecheck:api` — no TS errors
2. `node --test tests/edge-functions.test.mjs` — 130+ tests pass (bbox sync test auto-added)
3. Manual test:
   ```bash
   # Test airspace
   curl "https://api.worldmonitor.app/mcp" \
     -H "Authorization: Bearer <key>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_airspace","arguments":{"country_code":"AE"}}}'

   # Test maritime
   curl "https://api.worldmonitor.app/mcp" \
     -H "Authorization: Bearer <key>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_maritime_activity","arguments":{"country_code":"AE"}}}'
   ```
4. Via claude.ai Connectors: ask "How many planes are over the UAE right now?" — should return live count from `get_airspace`

## What's NOT in scope

- Vessel position lists (no vessel-by-vessel coords from current snapshot API)
- Historical queries (no time-travel support)
- Port-level maritime detail (handled by dedicated maritime panels in UI)
- Vessels by specific country flag (not filterable by flag state in current API)
