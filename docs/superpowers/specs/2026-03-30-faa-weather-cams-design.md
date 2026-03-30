# FAA Weather Cameras — Design Spec

**Date:** 2026-03-30
**Status:** Approved

---

## Overview

Integrate the FAA Aviation Weather Camera network into World Monitor as a four-phase feature: a panel, a DeckGL map layer, disaster-mode auto-surfacing, and AI-powered relevance scoring + image analysis. The primary lens is alert context — cameras are ranked and filtered by proximity to active NWS/GDACS alerts rather than by geography.

---

## Architecture

All camera metadata is fetched and cached by the sidecar at `/api/faa-cameras`. The frontend service `faa-cameras.ts` pulls from the sidecar, scores cameras against active NWS/GDACS alerts using haversine distance, and exposes a ranked list. The panel and map layer both consume this service. AI features are routed through two new sidecar endpoints (`/api/faa-cam-analyze`, `/api/faa-cam-digest`) which fetch camera images, base64-encode them, and send to Ollama. Claude API is an optional fallback for users who have a key.

```
FAA avcams.faa.gov/api
        │
        ▼
sidecar /api/faa-cameras (cached 15 min)
        │
        ▼
src/services/faa-cameras.ts
  ├── scoreCamera(cam, alerts) → ScoredFAACamera[]
  ├── getAlertProximateCameras(alerts, radiusMi) → ScoredFAACamera[]
  └── getDisasterProximateCameras(gdacs, nws) → ScoredFAACamera[]
        │
   ┌────┴────┐
   │         │
Panel     DeckGLMap layer
(table +  (ScatterplotLayer,
 viewer)   pulse on alert overlap)
```

---

## Data Model

### FAA Camera (from avcams.faa.gov)
```ts
interface FAACamera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: string;           // "AK", "WY", etc.
  category: string;        // "weather", "runway", "remote"
  imageUrl: string;        // JPEG, updates every 10 min
  isOnline: boolean;
  lastUpdated: string;     // ISO timestamp
}
```

### Scored Camera (frontend)
```ts
interface ScoredFAACamera extends FAACamera {
  alertProximityMi: number | null;   // null = no nearby alert
  alertLabel: string | null;          // "NWS Ice Storm Warning", etc.
  relevanceScore: number;             // 0–100, higher = more relevant
  aiConditions: string | null;        // populated on-demand
}
```

---

## Phase 1 — FAA Weather Cams Panel

**New files:**
- `src-tauri/sidecar/local-api-server.mjs` — add `/api/faa-cameras` route
- `src/services/faa-cameras.ts` — fetch, score, cache
- `src/components/FAAWeatherCamsPanel.ts` — panel UI

**Sidecar route:** `GET /api/faa-cameras`
- Fetches `https://avcams.faa.gov/api/cameras`
- Cache TTL: 15 minutes (images refresh every 10 min)
- Returns `FAACamera[]`

**NWS route extension:** `GET /api/nws-alerts`
- Extend existing route to include `centroid: [lon, lat] | null` from GeoJSON feature geometry
- Point geometry → use directly; Polygon → bounding-box centroid; null if no geometry

**Panel UI:**
- Sortable table: Camera Name | Location | Alert Proximity | Score | Last Updated
- Default sort: relevanceScore descending
- Filters: state dropdown + category toggle + "Alert-proximate only" checkbox
- Row click → inline image viewer (img tag pointing to `imageUrl`, no iframe)
- Image viewer shows: camera name, location, last updated, alert label (if any)
- "Analyze" button per camera → calls `/api/faa-cam-analyze` (Phase 4)
- Panel header shows digest when ≥2 cameras are alert-proximate (Phase 4)

**Panel registration:**
- Key: `faa-weather-cams`
- Category: `weather`
- Default: `enabled: true`, priority 2
- Added to `disaster` panel key list in `panels.ts`

---

## Phase 2 — DeckGL Map Layer

**Modified files:**
- `src/types/index.ts` — add `faaWeatherCams: boolean` to `MapLayers`
- `src/config/panels.ts` — add `faaWeatherCams: true` to `FULL_MAP_LAYERS` (and false for tech/finance/happy)
- `src/components/DeckGLMap.ts` — new `createFAACamerasLayer()`, state + setter

**Layer behavior:**
- `ScatterplotLayer` at camera lat/lon
- Peace mode: radius 4px, opacity 0.3, color `[100, 180, 255]`
- Alert-proximate: radius 8px, opacity 0.85, color `[255, 160, 60]`
- Disaster mode: radius 10px, pulsing via CSS animation class on the DeckGL canvas overlay
- Click → `MapPopup` with camera thumbnail + name + alert label
- Layer label: "FAA Weather Cams" with camera icon in layer switcher

**Implementation note:** Camera data is passed to the map via `deckGLMap.setFAACameras(cameras: ScoredFAACamera[])`, following the same pattern as `setFlightDelays`.

---

## Phase 3 — Disaster Mode Integration

**Modified files:**
- `src/services/faa-cameras.ts` — add `getDisasterProximateCameras()`
- `src/app/data-loader.ts` — call FAA camera scoring when Disaster mode activates
- `src/components/FAAWeatherCamsPanel.ts` — auto-apply alert filter in Disaster mode

**Behavior:**
- When `AppMode` transitions to `'disaster'`, `data-loader.ts` calls `getDisasterProximateCameras()` with current GDACS events (Orange+Red) and NWS alerts (Extreme/Severe)
- Panel auto-enables "Alert-proximate only" filter
- Panel header shows: "N cameras near [Alert Name]"
- Map layer markers near disaster footprint pulse (CSS class `faa-cam-pulse` toggled by DeckGLMap)
- On mode exit, filters reset to user's previous state

---

## Phase 4 — AI Features

**AI tier:**
1. **Relevance scoring** — deterministic metadata scoring in `faa-cameras.ts`, no model needed
2. **On-demand image analysis** — user clicks "Analyze" → sidecar fetches JPEG, base64-encodes, sends to Ollama `/api/generate` with vision model prompt
3. **Alert digest** — when ≥2 alert-proximate cameras exist, sidecar generates a 2-sentence situational summary

**New sidecar routes:**

`POST /api/faa-cam-analyze`
- Body: `{ imageUrl: string, cameraName: string, alertLabel: string | null }`
- Fetches image, base64-encodes, sends to Ollama with prompt:
  `"Describe current weather conditions visible in this camera image in 1-2 sentences. Be concise and factual."`
- Falls back to Claude API if `ANTHROPIC_API_KEY` is set and Ollama fails/unavailable
- Returns: `{ conditions: string } | { error: string }`

`POST /api/faa-cam-digest`
- Body: `{ cameras: Array<{ name: string, location: string, alertLabel: string }> }`
- Uses Ollama text model (no vision) with structured prompt
- Returns: `{ digest: string }` — 2-sentence situational summary
- Falls back to Claude API if available

**Scoring algorithm (deterministic, Phase 1):**
```
relevanceScore = 0
+ 40  if alertProximityMi !== null && alertProximityMi < 50
+ 20  if alertProximityMi !== null && alertProximityMi < 150
+ 20  if category === 'remote'    // remote cameras are rarer and more valuable
+ 10  if isOnline
+ 10  if lastUpdated within 20 minutes
```

**Model requirements for Ollama:**
- Vision analysis: any model with `vision` capability (LLaVA, moondream2, llava-phi3)
- Digest: any text model (llama3, mistral, etc.)
- Detection: sidecar checks `/api/tags` at Ollama URL, returns `ollamaAvailable: bool, hasVision: bool` in `/api/faa-cam-analyze` error payload so the panel can show appropriate UI

---

## Constraints & Notes

- FAA camera coverage is densest in Alaska; CONUS coverage is sparse outside major airports. The alert-proximity primary lens makes this irrelevant — only cameras near active alerts surface.
- NWS alert `centroid` extraction: the GeoJSON feature geometry is sometimes `null` for multi-county text alerts. These alerts still display in the panel but cannot participate in geo-proximity scoring.
- Camera images are served directly from FAA CDN; the sidecar only proxies metadata (and images for AI analysis). The panel's `<img>` tag points directly to `imageUrl`.
- CSP: FAA image URLs (`https://avcams.faa.gov`) must be added to `img-src` in the Tauri CSP config.
- No new API keys required for Phases 1–3. Phase 4 reuses existing `OLLAMA_API_URL` + `OLLAMA_MODEL`.
- `LAYER_TO_SOURCE` in `panels.ts` should map `faaWeatherCams` to `['faa_weather_cams']`.
