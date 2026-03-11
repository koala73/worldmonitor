---
title: "Orbital Surveillance"
description: "Real-time satellite orbital tracking on the 3D globe, powered by SGP4 propagation from CelesTrak TLE data."
---

# Orbital Surveillance

Real-time satellite orbital tracking on the 3D globe, powered by SGP4 propagation from CelesTrak TLE data.

---

## Overview

The Orbital Surveillance layer tracks ~80–120 intelligence-relevant satellites in real time. Satellites are rendered at their actual orbital altitude on the globe with country-coded colors, orbit trails, and ground footprint projections.

**Globe-only** — orbital mechanics don't translate meaningfully to a flat map projection.

### What It Shows

| Element | Description |
|---------|-------------|
| **Satellite marker** | 4px glowing dot at actual orbital altitude (LEO ~400km, SSO ~600–900km) |
| **Country color** | CN = red, RU = orange, US = blue, EU = green, KR = purple, OTHER = grey |
| **Orbit trail** | 15-minute historical trace rendered as a dashed path at orbital altitude |
| **Ground footprint** | Translucent circle projected on the surface below each satellite (nadir point) |
| **Tooltip** | Name, country, sensor type (SAR Imaging / Optical Imaging / Military / SIGINT), altitude |

---

## Architecture

### Data Flow

```
CelesTrak (free) ──2h──▶ Railway relay ──Redis──▶ Vercel edge ──CDN 1h──▶ Browser
                         (TLE parse,              (read-only,              (SGP4 propagation
                          filter,                  10min cache)             every 3 seconds)
                          classify)
```

### Cost Model

| Component | Cost | Notes |
|-----------|------|-------|
| CelesTrak API | Free | Public NORAD TLE data, 2h update cycle |
| Railway relay | ~$0 | Seed loop runs inside existing `ais-relay.cjs` process |
| Redis (Upstash) | Negligible | Single key, 4h TTL, ~50KB payload |
| Vercel edge | ~$0 | CDN caches 1h (`s-maxage=3600`), stale-while-revalidate 30min |
| Browser CPU | Client-side | SGP4 math runs locally every 3s — zero server cost for real-time movement |

**Key insight**: TLE data changes slowly (every 2h), but satellite positions change every second. By shipping TLEs to the browser and doing SGP4 propagation client-side, we get real-time movement with zero ongoing server cost.

---

## Satellite Selection

Two CelesTrak groups are fetched: `military` (~21 sats) and `resource` (~164 sats). After deduplication and name-pattern filtering, ~80–120 intelligence-relevant satellites remain.

### Filter Patterns

| Category | Patterns | Type Classification |
|----------|----------|---------------------|
| **Chinese recon** | YAOGAN, GAOFEN, JILIN | SAR (YAOGAN), Optical |
| **Russian recon** | COSMOS 24xx/25xx | Military |
| **Commercial SAR** | COSMO-SKYMED, TERRASAR, PAZ, SAR-LUPE, ICEYE | SAR |
| **Commercial optical** | WORLDVIEW, SKYSAT, PLEIADES, KOMPSAT | Optical |
| **Military** | SAPPHIRE, PRAETORIAN | Military |
| **EU/civil** | SENTINEL | SAR (Sentinel-1), Optical (Sentinel-2) |

### Country Classification

Satellites are classified by operator country: CN, RU, US, EU, IN, KR, JP, IL, or OTHER. Classification is name-based (e.g., YAOGAN → CN, COSMOS → RU, WORLDVIEW → US).

> **Note**: US KH-11 spy satellites (USA-224/245/290/314/338) are classified — no public TLEs exist. The tracked satellites are those with publicly available orbital elements.

---

## Technical Details

### SGP4 Propagation

The browser uses [`satellite.js`](https://github.com/shashwatak/satellite-js) (v6) for SGP4/SDP4 orbital propagation:

1. **`initSatRecs()`** — Parse TLEs into `SatRec` objects once (expensive, cached until TLEs refresh)
2. **`propagatePositions()`** — For each satellite: `propagate()` → `eciToGeodetic()` → lat/lng/alt. Also computes 15-point trail (1 per minute, looking back 15 minutes)
3. **`startPropagationLoop()`** — Runs every 3 seconds via `setInterval`. LEO satellites move ~23km in 3 seconds, producing visible motion on the globe

### Globe Rendering

| Property | Value |
|----------|-------|
| `htmlAltitude` | `altitude_km / 6371` (Earth radius = 6371km, globe.gl uses normalized units) |
| Marker size | 4px with 6px glow |
| Trail rendering | `pathsData` with `pathPointAlt` for 3D orbit paths |
| Footprint | Surface-level marker (`htmlAltitude = 0`) with 12px translucent ring |

### Lifecycle

| Event | Action |
|-------|--------|
| Layer enabled | `loadSatellites()` → fetch TLEs → init satrecs → start 3s propagation loop |
| Layer disabled | `stopSatellitePropagation()` → clear interval |
| Globe → flat map | Propagation stops (globe-only layer) |
| Page load (cold start) | If `satellites` enabled and globe mode: loads alongside other intelligence signals |
| Page unload | Cleanup in `destroy()` |

### Circuit Breaker

Client-side fetch uses a circuit breaker: 3 consecutive failures trigger a 10-minute cooldown. Cached data continues to be used during cooldown.

---

## Redis Keys

| Key | TTL | Writer | Shape |
|-----|-----|--------|-------|
| `intelligence:satellites:tle:v1` | 4h | Railway relay (2h cycle) | `{ satellites: SatelliteTLE[], fetchedAt: number }` |
| `seed-meta:intelligence:satellites` | 7d | Railway relay | `{ fetchedAt: number, recordCount: number }` |

### Health Monitoring

- `api/health.js` checks `intelligence:satellites:tle:v1` as a standalone key
- Seed metadata checked with `maxStaleMin: 180` (3h — survives 1 missed cycle)

---

## Files

| File | Purpose |
|------|---------|
| `scripts/ais-relay.cjs` | `seedSatelliteTLEs()` + `startSatelliteSeedLoop()` |
| `api/satellites.js` | Vercel edge handler (Redis read, CDN cache) |
| `src/services/satellites.ts` | Frontend service: fetch, parse, propagate, loop |
| `src/components/GlobeMap.ts` | Marker rendering, trails, footprints, tooltips |
| `src/components/MapContainer.ts` | Adapter with cache + rehydration |
| `src/app/data-loader.ts` | Lifecycle: load, loop, stop, cleanup |
| `src/config/map-layer-definitions.ts` | Layer registry entry (globe-only) |

---

## Tier Availability

| Feature | Free | Pro | Enterprise |
|---------|------|-----|------------|
| Live satellite positions on globe | Yes | Yes | Yes |
| Orbit trails (15-min trace) | Yes | Yes | Yes |
| Ground footprint markers | Yes | Yes | Yes |
| Overhead pass predictions | — | Yes | Yes |
| Revisit frequency analysis | — | Yes | Yes |
| Imaging window alerts | — | Yes | Yes |
| Cross-layer correlation (sat + GPS jam, sat + conflict) | — | Yes | Yes |
| Satellite intel summary panel | — | Yes | Yes |
| Sensor swath / FOV visualization | — | Yes | — |
| Historical pass log (24h) | — | Yes | 30-day archive |
| Actual satellite imagery (SAR/optical) | — | — | Yes |

---

## Roadmap (Phase 2)

### Overhead Pass Prediction

Compute next pass times over user-selected locations (hotspots, conflict zones, bases). Example: _"GAOFEN-12 will be overhead Tartus in 14 min."_

### Revisit Time Analysis

Calculate how often a location is observed by hostile or friendly satellites. Useful for operational security and intelligence gap analysis.

### Imaging Window Alerts

Push notifications when SAR or optical satellites are overhead a user's watched regions. Integrates with Pro delivery channels (Slack, Telegram, WhatsApp, Email).

### Sensor Swath Visualization

Replace nadir-point footprints with actual field-of-view cones based on satellite sensor specs and orbital altitude.

### Cross-Layer Correlation

Detect intelligence-relevant patterns by combining satellite positions with other layers:

- **Satellite + GPS jamming zone** → electronic warfare context
- **Satellite + conflict zone** → battlefield ISR detection
- **Satellite + AIS gap** → maritime reconnaissance indicator

### Satellite Intel Summary Panel

Dedicated Pro panel with a table of tracked satellites: operator, sensor capability, orbit type, current position, and next pass over user-defined points of interest.

### Historical Pass Log

Which satellites passed over a given location in the last 24h (Pro) or 30 days (Enterprise). Useful for post-event analysis: _"What imaging assets were overhead during the incident?"_
