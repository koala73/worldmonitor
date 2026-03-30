# FAA Weather Cameras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate FAA Aviation Weather Cameras into World Monitor as a panel, DeckGL map layer, disaster-mode tie-in, and AI-powered relevance/analysis feature.

**Architecture:** Sidecar proxies FAA camera metadata (cached 15 min); frontend service scores cameras against active NWS/GDACS alert proximity; panel and map layer both consume the service. AI image analysis and digest generation route through Ollama via two new sidecar endpoints, with Claude API as an optional fallback.

**Tech Stack:** TypeScript (frontend), Node.js ESM (sidecar), DeckGL ScatterplotLayer, Ollama vision API, FAA avcams.faa.gov public API

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/sidecar/local-api-server.mjs` | Modify | Add `/api/faa-cameras`, `/api/faa-cam-analyze`, `/api/faa-cam-digest` routes; extend `/api/nws-alerts` with centroid |
| `src/services/faa-cameras.ts` | Create | Types, fetch, haversine scoring, disaster-proximity helper |
| `src/components/FAAWeatherCamsPanel.ts` | Create | Panel UI: table, image viewer, analyze button, digest header |
| `src/types/index.ts` | Modify | Add `faaWeatherCams: boolean` to `MapLayers` |
| `src/config/panels.ts` | Modify | Register panel config, add layer to FULL_MAP_LAYERS, LAYER_TO_SOURCE |
| `src/components/DeckGLMap.ts` | Modify | Add `createFAACamerasLayer()`, `setFAACameras()`, layer toggle |
| `src/app/data-loader.ts` | Modify | Fetch and score FAA cameras on schedule; re-score on Disaster mode activate |
| `src/app/panel-layout.ts` | Modify | Instantiate FAAWeatherCamsPanel |
| `src/components/index.ts` | Modify | Export FAAWeatherCamsPanel |

---

## Phase 1 — Sidecar + Service + Panel

---

### Task 1: Extend `/api/nws-alerts` to include centroid

**Files:**
- Modify: `src-tauri/sidecar/local-api-server.mjs` (around line 1838–1852)

The NWS route fetches GeoJSON but currently strips all geometry. We need each alert's centroid so the service can compute camera proximity.

- [ ] **Step 1: Read the existing NWS route**

Open `src-tauri/sidecar/local-api-server.mjs` and find the block starting at `if (requestUrl.pathname === '/api/nws-alerts')`. The current map (around lines 1838–1852) constructs alert objects without geometry.

- [ ] **Step 2: Add centroid extraction helper before the dispatch function**

Add this function near the other helpers at the top of the file:

```js
function extractAlertCentroid(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return [geom.coordinates[0], geom.coordinates[1]];
  if (geom.type === 'Polygon' && geom.coordinates?.[0]?.length) {
    const ring = geom.coordinates[0];
    const lons = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    return [
      (Math.min(...lons) + Math.max(...lons)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
  }
  if (geom.type === 'MultiPolygon' && geom.coordinates?.[0]?.[0]?.length) {
    const ring = geom.coordinates[0][0];
    const lons = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    return [
      (Math.min(...lons) + Math.max(...lons)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2,
    ];
  }
  return null;
}
```

- [ ] **Step 3: Update the alert mapping to include centroid**

Replace the existing `features.slice(0, 100).map((f, i) => {` block's return object to add `centroid`:

```js
const alerts = features.slice(0, 100).map((f, i) => {
  const p = f.properties ?? {};
  return {
    id: p.id ?? `nws-${i}`,
    event: p.event ?? '',
    headline: p.headline ?? '',
    description: String(p.description ?? '').slice(0, 300),
    severity: p.severity ?? 'Unknown',
    urgency: p.urgency ?? 'Unknown',
    areaDesc: p.areaDesc ?? '',
    onset: p.onset ?? '',
    expires: p.expires ?? '',
    status: p.status ?? '',
    centroid: extractAlertCentroid(f),
  };
});
```

- [ ] **Step 4: Update the NWSAlert interface in the frontend service**

In `src/services/nws-alerts.ts`, add `centroid` to the `NWSAlert` interface:

```ts
export interface NWSAlert {
  id: string;
  event: string;
  headline: string;
  description: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  areaDesc: string;
  onset: string;
  expires: string;
  status: string;
  centroid: [number, number] | null;
}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/sidecar/local-api-server.mjs src/services/nws-alerts.ts
git commit -m "feat(nws): include alert centroid for geo-proximity scoring

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add `/api/faa-cameras` sidecar route

**Files:**
- Modify: `src-tauri/sidecar/local-api-server.mjs`

- [ ] **Step 1: Add the route after the existing `/api/nws-alerts` block**

```js
// ── FAA Aviation Weather Cameras (public, no auth) ───────────────────────────
if (requestUrl.pathname === '/api/faa-cameras') {
  const CACHE_KEY = 'faa-cameras';
  const CACHE_TTL = 15 * 60 * 1000;
  const cached = _sidecarCache.get(CACHE_KEY);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return json(cached.data);
  try {
    const resp = await fetchWithTimeout(
      'https://avcams.faa.gov/api/cameras',
      { headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0' } },
      15000,
    );
    if (!resp.ok) return json(cached?.data ?? [], 200);
    const raw = await resp.json();
    const cameras = (Array.isArray(raw) ? raw : raw?.cameras ?? []).map(c => ({
      id: String(c.id ?? c.cameraId ?? ''),
      name: String(c.name ?? c.cameraName ?? ''),
      lat: Number(c.lat ?? c.latitude ?? 0),
      lon: Number(c.lon ?? c.longitude ?? 0),
      state: String(c.state ?? ''),
      category: String(c.category ?? 'weather').toLowerCase(),
      imageUrl: String(c.imageUrl ?? c.image_url ?? ''),
      isOnline: Boolean(c.isOnline ?? c.active ?? true),
      lastUpdated: String(c.lastUpdated ?? c.last_updated ?? new Date().toISOString()),
    })).filter(c => c.id && c.lat !== 0 && c.lon !== 0);
    _sidecarCache.set(CACHE_KEY, { data: cameras, ts: Date.now() });
    return json(cameras);
  } catch (e) {
    return json(cached?.data ?? [], 200);
  }
}
```

- [ ] **Step 2: Verify the route responds**

```bash
cd src-tauri/sidecar
node local-api-server.mjs &
sleep 2
curl -s http://127.0.0.1:46123/api/faa-cameras | head -c 200
kill %1
```

Expected: JSON array (may be empty if FAA API unreachable, but no crash).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/sidecar/local-api-server.mjs
git commit -m "feat(sidecar): add /api/faa-cameras proxy with 15-min cache

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Create `src/services/faa-cameras.ts`

**Files:**
- Create: `src/services/faa-cameras.ts`

- [ ] **Step 1: Write the service file**

```ts
import { getApiBaseUrl } from '@/services/runtime';
import type { NWSAlert } from '@/services/nws-alerts';
import type { GDACSEvent } from '@/services/gdacs';

export interface FAACamera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: string;
  category: string;
  imageUrl: string;
  isOnline: boolean;
  lastUpdated: string;
}

export interface ScoredFAACamera extends FAACamera {
  alertProximityMi: number | null;
  alertLabel: string | null;
  relevanceScore: number;
  aiConditions: string | null;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { data: FAACamera[]; ts: number } | null = null;

export async function fetchFAACameras(): Promise<FAACamera[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/faa-cameras`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return cache?.data ?? [];
    const data = (await res.json()) as FAACamera[];
    cache = { data, ts: Date.now() };
    return data;
  } catch {
    return cache?.data ?? [];
  }
}

function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeScore(
  cam: FAACamera,
  closestMi: number | null,
): number {
  let score = 0;
  if (closestMi !== null && closestMi < 50) score += 40;
  else if (closestMi !== null && closestMi < 150) score += 20;
  if (cam.category === 'remote') score += 20;
  if (cam.isOnline) score += 10;
  const ageMs = Date.now() - new Date(cam.lastUpdated).getTime();
  if (ageMs < 20 * 60 * 1000) score += 10;
  return score;
}

export function scoreCamerasAgainstAlerts(
  cameras: FAACamera[],
  nwsAlerts: NWSAlert[],
  gdacsEvents: GDACSEvent[],
  radiusMi = 150,
): ScoredFAACamera[] {
  return cameras.map(cam => {
    let closestMi: number | null = null;
    let alertLabel: string | null = null;

    for (const alert of nwsAlerts) {
      if (!alert.centroid) continue;
      const mi = haversineMi(cam.lat, cam.lon, alert.centroid[1], alert.centroid[0]);
      if (mi < radiusMi && (closestMi === null || mi < closestMi)) {
        closestMi = mi;
        alertLabel = `NWS ${alert.event}`;
      }
    }

    for (const event of gdacsEvents) {
      if (event.alertLevel === 'Green') continue;
      const mi = haversineMi(cam.lat, cam.lon, event.coordinates[1], event.coordinates[0]);
      if (mi < radiusMi && (closestMi === null || mi < closestMi)) {
        closestMi = mi;
        alertLabel = `GDACS ${event.eventType} — ${event.name}`;
      }
    }

    return {
      ...cam,
      alertProximityMi: closestMi,
      alertLabel,
      relevanceScore: computeScore(cam, closestMi),
      aiConditions: null,
    };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

export function getDisasterProximateCameras(
  cameras: FAACamera[],
  nwsAlerts: NWSAlert[],
  gdacsEvents: GDACSEvent[],
): ScoredFAACamera[] {
  const severeNws = nwsAlerts.filter(a => a.severity === 'Extreme' || a.severity === 'Severe');
  const severeGdacs = gdacsEvents.filter(e => e.alertLevel === 'Orange' || e.alertLevel === 'Red');
  const scored = scoreCamerasAgainstAlerts(cameras, severeNws, severeGdacs, 200);
  return scored.filter(c => c.alertProximityMi !== null);
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/faa-cameras.ts
git commit -m "feat(faa-cameras): service with haversine alert-proximity scoring

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Create `FAAWeatherCamsPanel.ts`

**Files:**
- Create: `src/components/FAAWeatherCamsPanel.ts`
- Modify: `src/components/index.ts`

The panel builds all DOM via `createElement` + `textContent` (no raw HTML injection). The only exception is the map popup in Task 7, which uses the existing `showPopup` helper that already sanitizes content.

- [ ] **Step 1: Write the panel**

```ts
import { Panel } from './Panel';
import { fetchFAACameras, scoreCamerasAgainstAlerts } from '@/services/faa-cameras';
import type { ScoredFAACamera } from '@/services/faa-cameras';
import { fetchNWSAlerts } from '@/services/nws-alerts';
import { fetchGDACSEvents } from '@/services/gdacs';
import { getApiBaseUrl } from '@/services/runtime';

export class FAAWeatherCamsPanel extends Panel {
  private cameras: ScoredFAACamera[] = [];
  private alertOnly = false;
  private selectedCam: ScoredFAACamera | null = null;
  private digestText: string | null = null;

  constructor() {
    super({ id: 'faa-weather-cams', title: 'FAA Weather Cams', className: 'panel-wide' });
    this.load();
  }

  private async load(): Promise<void> {
    const [raw, nws, gdacs] = await Promise.all([
      fetchFAACameras(),
      fetchNWSAlerts(),
      fetchGDACSEvents(),
    ]);
    this.cameras = scoreCamerasAgainstAlerts(raw, nws, gdacs);
    this.render();
  }

  public refresh(): void {
    this.load();
  }

  private get displayed(): ScoredFAACamera[] {
    return this.alertOnly
      ? this.cameras.filter(c => c.alertProximityMi !== null)
      : this.cameras;
  }

  private render(): void {
    const el = this.getContentElement();
    while (el.firstChild) el.removeChild(el.firstChild);
    el.className = 'panel-content faa-cams-content';

    const alertCams = this.cameras.filter(c => c.alertProximityMi !== null);
    if (alertCams.length >= 2 && this.digestText) {
      const banner = document.createElement('div');
      banner.className = 'faa-digest-banner';
      banner.textContent = this.digestText;
      el.appendChild(banner);
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'faa-cams-toolbar';
    const label = document.createElement('label');
    label.className = 'faa-toggle-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.alertOnly;
    cb.addEventListener('change', () => { this.alertOnly = cb.checked; this.render(); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' Alert-proximate only'));
    const count = document.createElement('span');
    count.className = 'faa-cam-count';
    count.textContent = `${this.displayed.length} cameras`;
    toolbar.appendChild(label);
    toolbar.appendChild(count);
    el.appendChild(toolbar);

    if (this.selectedCam) el.appendChild(this._buildViewer(this.selectedCam));

    // Table
    const table = document.createElement('table');
    table.className = 'faa-cams-table eq-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Camera', 'Location', 'Alert', 'Score', 'Updated']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const cam of this.displayed) {
      const tr = document.createElement('tr');
      tr.className = `eq-row${cam.alertProximityMi !== null ? ' eq-moderate' : ''}`;
      if (this.selectedCam?.id === cam.id) tr.classList.add('faa-cam-selected');

      const tdName = document.createElement('td');
      tdName.textContent = cam.name;

      const tdLoc = document.createElement('td');
      tdLoc.textContent = cam.category !== 'weather'
        ? `${cam.state} · ${cam.category}`
        : cam.state;

      const tdAlert = document.createElement('td');
      if (cam.alertLabel) {
        const badge = document.createElement('span');
        badge.className = 'faa-alert-badge';
        badge.textContent = cam.alertLabel;
        tdAlert.appendChild(badge);
      } else {
        tdAlert.textContent = '—';
      }

      const tdScore = document.createElement('td');
      tdScore.textContent = String(cam.relevanceScore);

      const tdTime = document.createElement('td');
      tdTime.textContent = this._relativeTime(cam.lastUpdated);

      for (const td of [tdName, tdLoc, tdAlert, tdScore, tdTime]) tr.appendChild(td);

      tr.addEventListener('click', () => {
        this.selectedCam = this.selectedCam?.id === cam.id ? null : cam;
        this.render();
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);

    if (this.displayed.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'faa-empty';
      empty.textContent = this.alertOnly
        ? 'No cameras near active alerts.'
        : 'No camera data available.';
      el.appendChild(empty);
    }
  }

  private _buildViewer(cam: ScoredFAACamera): HTMLElement {
    const div = document.createElement('div');
    div.className = 'faa-cam-viewer';

    const header = document.createElement('div');
    header.className = 'faa-cam-viewer-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = cam.name;
    header.appendChild(nameEl);
    if (cam.alertLabel) {
      const badge = document.createElement('span');
      badge.className = 'faa-alert-badge';
      badge.textContent = cam.alertLabel;
      header.appendChild(badge);
    }
    const updatedEl = document.createElement('span');
    updatedEl.className = 'faa-cam-updated';
    updatedEl.textContent = this._relativeTime(cam.lastUpdated);
    header.appendChild(updatedEl);

    const img = document.createElement('img');
    img.className = 'faa-cam-image';
    img.src = cam.imageUrl;
    img.alt = cam.name;
    img.loading = 'lazy';

    const analyzeBtn = document.createElement('button');
    analyzeBtn.className = 'faa-analyze-btn';
    analyzeBtn.textContent = cam.aiConditions ?? 'Analyze conditions';
    analyzeBtn.disabled = !!cam.aiConditions;
    analyzeBtn.addEventListener('click', () => this._analyzeCamera(cam, analyzeBtn));

    div.appendChild(header);
    div.appendChild(img);
    div.appendChild(analyzeBtn);
    return div;
  }

  private async _analyzeCamera(cam: ScoredFAACamera, btn: HTMLButtonElement): Promise<void> {
    btn.textContent = 'Analyzing…';
    btn.disabled = true;
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/faa-cam-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: cam.imageUrl,
          cameraName: cam.name,
          alertLabel: cam.alertLabel,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json() as { conditions?: string; error?: string };
      const idx = this.cameras.findIndex(c => c.id === cam.id);
      if (idx !== -1) {
        this.cameras[idx]!.aiConditions = data.conditions ?? data.error ?? 'No response';
        if (this.selectedCam?.id === cam.id) this.selectedCam = this.cameras[idx] ?? null;
      }
    } catch {
      btn.textContent = 'Analysis unavailable';
      btn.disabled = false;
      return;
    }
    this.render();
  }

  private _relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  }

  public setDisasterMode(active: boolean, disasterCameras?: ScoredFAACamera[]): void {
    if (active && disasterCameras) {
      this.cameras = disasterCameras;
      this.alertOnly = true;
    } else if (!active) {
      this.alertOnly = false;
      this.load();
    }
    this.render();
  }

  public setDigest(text: string): void {
    this.digestText = text;
    this.render();
  }
}
```

- [ ] **Step 2: Export from index**

In `src/components/index.ts`, add:

```ts
export { FAAWeatherCamsPanel } from './FAAWeatherCamsPanel';
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/FAAWeatherCamsPanel.ts src/components/index.ts
git commit -m "feat(panel): FAA Weather Cams panel with alert-proximity filter and image viewer

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Register panel in config and layout

**Files:**
- Modify: `src/config/panels.ts`
- Modify: `src/app/panel-layout.ts`

- [ ] **Step 1: Add panel config to FULL_PANELS in panels.ts**

Find the block containing `'nws-alerts'` and add nearby:

```ts
'faa-weather-cams': { name: 'FAA Weather Cams', enabled: true, priority: 2 },
```

- [ ] **Step 2: Add to disaster category panelKeys**

Find `panelKeys: ['satellite-fires', 'earthquakes', 'gdacs-alerts', 'volcano-alerts', 'nws-alerts', ...]` and add `'faa-weather-cams'` after `'nws-alerts'`.

- [ ] **Step 3: Instantiate panel in panel-layout.ts**

Find where `NWSAlertsPanel` is imported and instantiated. Add the same pattern for FAA:

```ts
import { FAAWeatherCamsPanel } from '@/components/FAAWeatherCamsPanel';
// In the panel factory switch/if block:
case 'faa-weather-cams':
  return new FAAWeatherCamsPanel();
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/config/panels.ts src/app/panel-layout.ts
git commit -m "feat(panels): register FAA Weather Cams panel in disaster category

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 2 — DeckGL Map Layer

---

### Task 6: Add `faaWeatherCams` to MapLayers type and all configs

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/config/panels.ts`

- [ ] **Step 1: Add to MapLayers interface**

In `src/types/index.ts`, find the `MapLayers` interface closing brace and add before it:

```ts
  // FAA Weather Cameras layer
  faaWeatherCams: boolean;
```

- [ ] **Step 2: Add to FULL_MAP_LAYERS**

In `panels.ts` in `const FULL_MAP_LAYERS: MapLayers`, add:

```ts
  faaWeatherCams: true,
```

In ALL other layer config objects (`FULL_MOBILE_MAP_LAYERS`, `TECH_MAP_LAYERS`, `TECH_MOBILE_MAP_LAYERS`, `FINANCE_MAP_LAYERS`, `FINANCE_MOBILE_MAP_LAYERS`, `HAPPY_MAP_LAYERS`, `HAPPY_MOBILE_MAP_LAYERS`), add:

```ts
  faaWeatherCams: false,
```

- [ ] **Step 3: Add to LAYER_TO_SOURCE**

In the `LAYER_TO_SOURCE` export in `panels.ts`, add:

```ts
  faaWeatherCams: ['faa_weather_cams'],
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors. If TypeScript complains about missing `faaWeatherCams` in any config object, add `faaWeatherCams: false` to it.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/config/panels.ts
git commit -m "feat(map): add faaWeatherCams layer key to MapLayers and all config variants

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Add FAA camera layer to DeckGLMap

**Files:**
- Modify: `src/components/DeckGLMap.ts`

- [ ] **Step 1: Add import and private state**

Near where other service types are imported at the top:

```ts
import type { ScoredFAACamera } from '@/services/faa-cameras';
```

In the class body near `private flightDelays`:

```ts
private faaCameras: ScoredFAACamera[] = [];
```

- [ ] **Step 2: Add public setter**

Near the `setFlightDelays` method:

```ts
public setFAACameras(cameras: ScoredFAACamera[]): void {
  this.faaCameras = cameras;
  this.render();
}
```

- [ ] **Step 3: Add layer creation method**

Near `createFlightDelaysLayer`:

```ts
private createFAACamerasLayer(cameras: ScoredFAACamera[]): ScatterplotLayer {
  return new ScatterplotLayer<ScoredFAACamera>({
    id: 'faa-cameras',
    data: cameras,
    getPosition: d => [d.lon, d.lat],
    getRadius: d => (d.alertProximityMi !== null ? 8 : 4),
    getFillColor: d =>
      d.alertProximityMi !== null ? [255, 160, 60, 220] : [100, 180, 255, 80],
    radiusMinPixels: 4,
    radiusMaxPixels: 12,
    pickable: true,
    autoHighlight: true,
    onClick: ({ object }) => {
      if (object) this._showFAACameraPopup(object as ScoredFAACamera);
    },
  });
}

private _showFAACameraPopup(cam: ScoredFAACamera): void {
  // Build popup DOM safely — no raw HTML injection
  const wrapper = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'map-popup-title';
  title.textContent = cam.name;
  wrapper.appendChild(title);

  const loc = document.createElement('div');
  loc.className = 'map-popup-row';
  loc.textContent = `${cam.state} · ${cam.category}`;
  wrapper.appendChild(loc);

  if (cam.alertLabel) {
    const alertEl = document.createElement('div');
    alertEl.className = 'map-popup-alert';
    alertEl.textContent = cam.alertLabel;
    wrapper.appendChild(alertEl);
  }

  if (cam.imageUrl) {
    const img = document.createElement('img');
    img.src = cam.imageUrl;
    img.alt = cam.name;
    img.style.cssText = 'width:100%;max-width:220px;margin-top:6px;border-radius:4px;';
    img.loading = 'lazy';
    wrapper.appendChild(img);
  }

  const status = document.createElement('div');
  status.className = 'map-popup-row';
  status.style.cssText = 'font-size:11px;opacity:0.7';
  status.textContent = cam.isOnline ? 'Online' : 'Offline';
  wrapper.appendChild(status);

  this.showPopup([cam.lon, cam.lat], wrapper.outerHTML);
}
```

- [ ] **Step 4: Wire layer into getLayers**

Find where layers are assembled (where `createFlightDelaysLayer` is called). Add:

```ts
if (this.mapLayers.faaWeatherCams && this.faaCameras.length > 0) {
  layers.push(this.createFAACamerasLayer(this.faaCameras));
}
```

- [ ] **Step 5: Add layer to layer switcher**

Find where `{ key: 'flights', label: ..., icon: ... }` is defined and add after it:

```ts
{ key: 'faaWeatherCams', label: 'FAA Weather Cams', icon: '&#128247;' },
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/DeckGLMap.ts
git commit -m "feat(map): FAA camera ScatterplotLayer with alert-proximity coloring and popup

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Wire FAA cameras into data-loader

**Files:**
- Modify: `src/app/data-loader.ts`

- [ ] **Step 1: Add imports**

```ts
import { fetchFAACameras, scoreCamerasAgainstAlerts } from '@/services/faa-cameras';
```

- [ ] **Step 2: Add FAA camera refresh task**

Find where `scheduleRefresh` calls are made for other weather-related data and add:

```ts
scheduleRefresh('faa-cameras', 20 * 60 * 1000, async () => {
  const [raw, nws, gdacs] = await Promise.all([
    fetchFAACameras(),
    fetchNWSAlerts(),
    fetchGDACSEvents(),
  ]);
  const scored = scoreCamerasAgainstAlerts(raw, nws, gdacs);
  deckGLMap?.setFAACameras(scored);
  (panelInstances.get('faa-weather-cams') as FAAWeatherCamsPanel | undefined)?.refresh();
});
```

Note: Check how `data-loader.ts` accesses panel instances — use the same pattern already established (e.g. `panelInstances.get(...)`, a module-level reference, or an injected dependency).

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(data-loader): schedule FAA camera refresh every 20 minutes

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 3 — Disaster Mode Integration

---

### Task 9: Auto-surface cameras on Disaster mode activation

**Files:**
- Modify: `src/app/data-loader.ts`

- [ ] **Step 1: Add disaster-mode import**

```ts
import { getDisasterProximateCameras } from '@/services/faa-cameras';
```

- [ ] **Step 2: Handle mode transitions**

Find where `AppMode` changes are subscribed to in `data-loader.ts`. Add to the mode-change handler:

```ts
import type { FAAWeatherCamsPanel } from '@/components/FAAWeatherCamsPanel';

// In mode-change callback:
if (newMode === 'disaster') {
  const [raw, nws, gdacs] = await Promise.all([
    fetchFAACameras(),
    fetchNWSAlerts(),
    fetchGDACSEvents(),
  ]);
  const proximate = getDisasterProximateCameras(raw, nws, gdacs);
  deckGLMap?.setFAACameras(proximate);
  (panelInstances.get('faa-weather-cams') as FAAWeatherCamsPanel | undefined)
    ?.setDisasterMode(true, proximate);
} else if (prevMode === 'disaster') {
  (panelInstances.get('faa-weather-cams') as FAAWeatherCamsPanel | undefined)
    ?.setDisasterMode(false);
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(disaster): auto-surface FAA cameras near disaster alerts on mode activation

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 4 — AI Features

---

### Task 10: Add `/api/faa-cam-analyze` and `/api/faa-cam-digest` sidecar routes

**Files:**
- Modify: `src-tauri/sidecar/local-api-server.mjs`

**Important:** Before writing these routes, check how existing routes access secrets (e.g. `context.secrets?.OLLAMA_API_URL` vs a `getSecret()` helper). Use the same pattern.

- [ ] **Step 1: Read how secrets are accessed in the sidecar**

Search for `OLLAMA_API_URL` in the sidecar to find the secrets access pattern:

```bash
grep -n "OLLAMA_API_URL\|getSecret\|context.secrets" src-tauri/sidecar/local-api-server.mjs | head -10
```

Use whichever pattern you find for `ollamaUrl` and `ollamaModel` in the routes below.

- [ ] **Step 2: Add `/api/faa-cam-analyze` route**

Add after the `/api/faa-cameras` route:

```js
// ── FAA Camera AI Image Analysis (Ollama-primary, Claude fallback) ────────────
if (requestUrl.pathname === '/api/faa-cam-analyze' && req.method === 'POST') {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body' }, 400); }
  const { imageUrl, cameraName, alertLabel } = body ?? {};
  if (!imageUrl || typeof imageUrl !== 'string') return json({ error: 'imageUrl required' }, 400);

  // Fetch and base64-encode the camera image
  let imageB64;
  try {
    const imgResp = await fetchWithTimeout(imageUrl, { headers: { 'User-Agent': 'WorldMonitor/1.0' } }, 10000);
    if (!imgResp.ok) return json({ error: 'Could not fetch camera image' }, 502);
    const buf = await imgResp.arrayBuffer();
    imageB64 = Buffer.from(buf).toString('base64');
  } catch (e) {
    return json({ error: `Image fetch failed: ${String(e?.message ?? e)}` }, 502);
  }

  const ctxLabel = alertLabel ? ` Context: camera is near an active ${alertLabel}.` : '';
  const prompt = `Describe current weather conditions visible in this camera image in 1-2 sentences. Be concise and factual.${ctxLabel}`;

  // Try Ollama first (use secrets access pattern found in Step 1)
  const ollamaUrl = context.secrets?.OLLAMA_API_URL;
  const ollamaModel = context.secrets?.OLLAMA_MODEL;
  if (ollamaUrl && ollamaModel) {
    try {
      const ollamaResp = await fetchWithTimeout(
        new URL('/api/generate', ollamaUrl).toString(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ollamaModel, prompt, images: [imageB64], stream: false }),
        },
        25000,
      );
      if (ollamaResp.ok) {
        const data = await ollamaResp.json();
        if (data.response) return json({ conditions: String(data.response).trim() });
      }
    } catch { /* fall through to Claude */ }
  }

  // Claude API fallback
  const anthropicKey = context.secrets?.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const claudeResp = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
                { type: 'text', text: prompt },
              ],
            }],
          }),
        },
        25000,
      );
      if (claudeResp.ok) {
        const data = await claudeResp.json();
        const text = data?.content?.[0]?.text;
        if (text) return json({ conditions: String(text).trim() });
      }
    } catch { /* fall through */ }
  }

  return json({ error: 'Analysis unavailable — enable Ollama with a vision model (llava, moondream2) or add an Anthropic API key.' });
}
```

- [ ] **Step 3: Add `/api/faa-cam-digest` route**

```js
// ── FAA Camera Situational Digest ─────────────────────────────────────────────
if (requestUrl.pathname === '/api/faa-cam-digest' && req.method === 'POST') {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body' }, 400); }
  const cameras = Array.isArray(body?.cameras) ? body.cameras : [];
  if (cameras.length < 2) return json({ error: 'At least 2 cameras required' }, 400);

  const camList = cameras.slice(0, 6).map(c => {
    const alert = c.alertLabel ? `, near ${c.alertLabel}` : '';
    return `- ${c.name} (${c.location})${alert}`;
  }).join('\n');
  const prompt = `You are a situational awareness assistant. The following FAA weather cameras are near active weather or disaster alerts:\n${camList}\n\nWrite a 2-sentence situational summary for an emergency monitor. Be factual, concise, and avoid speculation.`;

  const ollamaUrl = context.secrets?.OLLAMA_API_URL;
  const ollamaModel = context.secrets?.OLLAMA_MODEL;
  if (ollamaUrl && ollamaModel) {
    try {
      const resp = await fetchWithTimeout(
        new URL('/api/generate', ollamaUrl).toString(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ollamaModel, prompt, stream: false }),
        },
        20000,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.response) return json({ digest: String(data.response).trim() });
      }
    } catch { /* fall through */ }
  }

  const anthropicKey = context.secrets?.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const resp = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        20000,
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.content?.[0]?.text;
        if (text) return json({ digest: String(text).trim() });
      }
    } catch { /* fall through */ }
  }

  return json({ error: 'Digest unavailable' });
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/sidecar/local-api-server.mjs
git commit -m "feat(sidecar): FAA camera AI analysis + digest routes (Ollama-primary, Claude fallback)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 11: Fetch digest from data-loader when cameras are alert-proximate

**Files:**
- Modify: `src/app/data-loader.ts`

- [ ] **Step 1: Add digest fetch after camera scoring**

In the FAA camera refresh task, after `const scored = scoreCamerasAgainstAlerts(...)`:

```ts
import type { FAAWeatherCamsPanel } from '@/components/FAAWeatherCamsPanel';

const alertCams = scored.filter(c => c.alertProximityMi !== null);
if (alertCams.length >= 2) {
  fetch(`${getApiBaseUrl()}/api/faa-cam-digest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cameras: alertCams.slice(0, 6).map(c => ({
        name: c.name,
        location: c.state,
        alertLabel: c.alertLabel,
      })),
    }),
    signal: AbortSignal.timeout(25000),
  })
    .then(r => r.ok ? r.json() : null)
    .then((data: { digest?: string } | null) => {
      if (data?.digest) {
        (panelInstances.get('faa-weather-cams') as FAAWeatherCamsPanel | undefined)
          ?.setDigest(data.digest);
      }
    })
    .catch(() => {});
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/data-loader.ts
git commit -m "feat(faa-cameras): fetch situational digest when alert-proximate cameras detected

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 12: CSP and final build check

**Files:**
- Verify: `src-tauri/tauri.conf.json` (img-src CSP)

- [ ] **Step 1: Check existing img-src CSP**

```bash
grep -n "img-src" src-tauri/tauri.conf.json src-tauri/src/main.rs 2>/dev/null
```

- [ ] **Step 2: Add FAA domain if not already covered**

If `img-src` doesn't include `https://avcams.faa.gov` or a broad `https:` wildcard, add it. Find the `csp` key in `src-tauri/tauri.conf.json` and extend `img-src`:

```json
"img-src": "'self' data: asset: https://asset.localhost https://avcams.faa.gov"
```

- [ ] **Step 3: Full typecheck**

```bash
npm run typecheck:all
```

Expected: zero errors.

- [ ] **Step 4: Commit if changed**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(csp): allow FAA avcams image domain for camera thumbnails

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Phase 1 panel: Tasks 1–5 ✓
- Phase 2 map layer: Tasks 6–8 ✓
- Phase 3 disaster mode: Task 9 ✓
- Phase 4 AI features: Tasks 10–12 ✓
- NWS centroid: Task 1 ✓
- Ollama-primary + Claude fallback: Task 10 ✓
- Alert digest with ≥2 camera threshold: Task 11 ✓
- CSP: Task 12 ✓

**Placeholder scan:** No TBDs. Task 7 popup uses `wrapper.outerHTML` — acceptable because all content is set via `textContent`/`src` (no user-controlled HTML injection). Task 8 panel access pattern marked with a note to match existing data-loader convention.

**Type consistency:** `ScoredFAACamera` defined in Task 3, used in Tasks 4, 7, 8, 9. `FAACamera` defined in Task 3, used in Tasks 2, 3. `NWSAlert.centroid` added in Task 1, consumed in Task 3. All setters (`setFAACameras`, `setDisasterMode`, `setDigest`) defined before they are called. ✓

**Known unknowns to resolve at implementation time:**
- Exact secrets access pattern in the sidecar (Task 10, Step 1 covers this)
- Exact pattern for panel instance access in `data-loader.ts` (Task 8, Step 2 note covers this)
- FAA API exact response shape (Task 2 defensively handles multiple field name variants)
