# Sprint 1A — Communications Health + Economic Stress Indicators

**Date:** 2026-03-16
**Status:** Approved for implementation
**Effort estimate:** 3-5 days
**Part of:** World Monitor Survival Roadmap (Sprint 1 of 7)

---

## Overview

Two new status-dashboard panels that give instant glanceable awareness of two critical survival signals:

1. **Communications Health** - BGP anomalies, IXP status, DDoS intensity, submarine cable degradation
2. **Economic Stress** - Composite 0-100 stress index from 6 FRED indicators + global food security

Both use the existing sidecar proxy pattern. Both introduce a reusable `StatusCard` component that all future sprints will build on.

---

## API Keys

**No new API keys.** Both required keys already exist in the app:

| Key | Already used by | Notes |
|-----|----------------|-------|
| `CLOUDFLARE_API_TOKEN` | Internet Outages panel | Reuse for Cloudflare Radar BGP/DDoS endpoints |
| `FRED_API_KEY` | Economic panel, shipping rates | Reuse for FRED series |

`SUPPORTED_SECRET_KEYS` count in `main.rs` stays at **25**. No changes to `runtime-config.ts`, `settings-constants.ts`, or `main.rs`.

Comms Health panel: if `CLOUDFLARE_API_TOKEN` is absent, renders partial data (RIPE NCC + IHR only) with an inline "Cloudflare token required" note on the DDoS cards. Does NOT block the entire panel.

Economic Stress: if `FRED_API_KEY` is absent, shows a full-panel "FRED key required" card since all 6 core indicators need it.

---

## DOM Safety

All HTML strings are built from trusted internal data (sidecar responses we control). No user input is interpolated into markup. As a belt-and-suspenders measure, all generated HTML is passed through `DOMPurify.sanitize()` before DOM insertion. This matches the existing pattern in GDACSAlertsPanel and VolcanoAlertsPanel.

---

## Sidecar Routes

### `GET /api/comms-health`

Aggregates three upstream sources in parallel. Each fetch uses `AbortController` with a 10s timeout so one slow source does not block the others. Returns `Content-Type: application/json`. Individual source failures return partial data, not a 500.

**Upstream calls:**
```
Cloudflare Radar (CLOUDFLARE_API_TOKEN — reuse existing env var):
  GET https://api.cloudflare.com/client/v4/radar/bgp/hijacks/events?limit=50
  GET https://api.cloudflare.com/client/v4/radar/bgp/leaks/events?limit=50
  GET https://api.cloudflare.com/client/v4/radar/attacks/layer7/summary

RIPE NCC Stat (no key):
  GET https://stat.ripe.net/data/routing-status/data.json?resource=0.0.0.0/0
  GET https://stat.ripe.net/data/bgpplay/data.json?resource=0.0.0.0/0&starttime=-1h

Internet Health Report (no key) — use network endpoint, NOT hegemony:
  GET https://ihr.iijlab.net/ihr/api/network/?format=json&search=&last=1
```

**Response shape:**
```json
{
  "overall": "warning",
  "bgp": { "hijacks": 14, "leaks": 2, "severity": "critical" },
  "ixp": { "status": "normal", "degraded": [] },
  "ddos": { "l7": "elevated", "l3": "normal", "cloudflareKeyMissing": false },
  "cables": { "degraded": ["APAC-1"], "normal": ["MAREA", "AAG"] },
  "updatedAt": "2026-03-16T04:00:00Z"
}
```

**Severity thresholds (bgp.hijacks):** less than 5 = normal, 5-15 = warning, greater than 15 = critical.
**Overall:** worst of all component severities. DDoS fields only contribute if `cloudflareKeyMissing` is false.
**Cable status:** derived from RIPE NCC BGP anomalies cross-referenced against known cable operator AS numbers. Defaults to "normal" for cables with no matching anomalies.

---

### `GET /api/economic-stress`

Fetches 6 FRED series + World Bank food security. FRED data is daily. Add a **15-minute in-process cache** using a `Map<string, {data: unknown, ts: number}>` with a TTL helper function. This is the **first route to use sidecar-level caching** — add a `// CACHE PATTERN: copy this for future cached routes` comment to document it.

**Upstream calls:**
```
FRED API (FRED_API_KEY — reuse existing env var) — latest observation for each series:
  T10Y2Y  - 10Y-2Y Treasury yield curve spread
  T10Y3M  - 10Y-3M Treasury spread
            NOTE: TEDRATE (TED Spread) was retired by FRED in 2023 — use T10Y3M instead
  VIXCLS  - CBOE Volatility Index
  STLFSI4 - St. Louis Fed Financial Stress Index
  GSCPI   - NY Fed Global Supply Chain Pressure Index (monthly, approx 6-week lag)
  ICSA    - Initial unemployment claims (weekly)

World Bank (no key):
  GET https://api.worldbank.org/v2/country/WLD/indicator/AG.PRD.FOOD.XD?format=json&mrv=1
  IMPORTANT: World Bank returns a 2-element array.
  Parse as: response[1][0].value  (element [0] = metadata, [1] = data array)
```

**Response shape:**
```json
{
  "stressIndex": 62,
  "trend": "rising",
  "indicators": {
    "yieldCurve":  { "value": -0.42,   "label": "INVERTED",  "severity": "critical" },
    "bankSpread":  { "value": 0.41,    "label": "NORMAL",    "severity": "normal"   },
    "vix":         { "value": 28.4,    "label": "ELEVATED",  "severity": "warning"  },
    "fsi":         { "value": 1.24,    "label": "ELEVATED",  "severity": "warning"  },
    "supplyChain": { "value": -0.3,    "label": "NORMAL",    "severity": "normal",  "lagWeeks": 6 },
    "jobClaims":   { "value": 247000,  "label": "RISING",    "severity": "critical" }
  },
  "foodSecurity": { "value": 61.4, "severity": "warning" },
  "updatedAt": "2026-03-16T04:00:00Z"
}
```

**Composite stress index — scoring functions and weights:**

| Indicator | FRED ID | Weight | Score formula (0-100, clamped) |
|-----------|---------|--------|-------------------------------|
| Yield curve | T10Y2Y | 20% | `clamp((0.5 - v) / (0.5 - (-1.5)) * 100)` — 0 at +0.5%, 100 at -1.5% |
| Bank spread | T10Y3M | 15% | `clamp((0.5 - v) / (0.5 - (-1.0)) * 100)` |
| VIX | VIXCLS | 20% | `clamp((v - 15) / (80 - 15) * 100)` — 0 at VIX 15, 100 at VIX 80 |
| FSI | STLFSI4 | 20% | `clamp((v - (-1)) / (5 - (-1)) * 100)` — 0 at -1, 100 at +5 |
| Supply chain | GSCPI | 15% | `clamp((v - (-2)) / (4 - (-2)) * 100)` — 0 at -2 sigma, 100 at +4 sigma |
| Job claims | ICSA | 10% | `clamp((v - 180000) / (500000 - 180000) * 100)` |

`clamp(x) = Math.min(100, Math.max(0, x))`

Composite = sum of (indicatorScore * weight) across all 6.
Notification thresholds: index >= 70 = warning, index >= 85 = critical.

---

## New Components

### `src/components/StatusCard.ts`

Reusable plain-TypeScript module (not a Panel subclass). Added to `src/components/index.ts` barrel export.

```typescript
export interface StatusCardConfig {
  label: string;
  value: string | number;
  unit?: string;
  severity: 'normal' | 'warning' | 'critical' | 'unknown';
  sublabel?: string;
  wide?: boolean;       // grid-column: 1 / -1
  inlineNote?: string;  // small inline text for partial-data states
}

// Returns a sanitized HTML string. All string values are escaped before use.
export function renderStatusCard(config: StatusCardConfig): string
```

Severity colors: normal = green, warning = amber, critical = red, unknown = neutral.

---

### `src/components/CommsHealthPanel.ts`

Extends `Panel`. Uses `getContentElement()` directly for DOM updates — same pattern as GDACSAlertsPanel and VolcanoAlertsPanel, avoids the `setContent()` 150ms debounce.

Layout:

1. Overall status banner — colored pill, pulsing dot, summary text
2. 2-column StatusCard grid: BGP Hijacks, BGP Leaks, IXP Status, DDoS L7 (inline note if Cloudflare token missing)
3. Full-width cable status card with individual cable badges

Refresh: every 5 minutes via `scheduleRefresh()`.
Error state: neutral "Data unavailable" card with last-known timestamp.
Instance property: `_previousOverall: string = 'normal'` for transition detection.

---

### `src/components/EconomicStressPanel.ts`

Extends `Panel`. Uses `getContentElement()` directly for DOM updates.

Layout:

1. Composite stress index bar — 0-100 gradient bar with needle, numeric score, trend arrow
2. 3-column StatusCard grid: Yield Curve, Bank Spread, VIX, FSI, Supply Chain, Job Claims
3. Full-width food security footnote row

Refresh: every 15 minutes.
Supply chain card ALWAYS shows "~6wk lag" sublabel.
Instance property: `_previousStressIndex: number = 0` for transition detection.

---

## New Services

### `src/services/comms-health.ts`

```typescript
export interface CommsHealthData {
  overall: 'normal' | 'warning' | 'critical';
  bgp: { hijacks: number; leaks: number; severity: 'normal' | 'warning' | 'critical' };
  ixp: { status: 'normal' | 'warning' | 'critical'; degraded: string[] };
  ddos: { l7: 'normal' | 'elevated' | 'critical'; l3: 'normal' | 'elevated' | 'critical'; cloudflareKeyMissing: boolean };
  cables: { degraded: string[]; normal: string[] };
  updatedAt: string;
}
export async function fetchCommsHealth(): Promise<CommsHealthData>
```

### `src/services/economic-stress.ts`

```typescript
export type Severity = 'normal' | 'warning' | 'critical' | 'unknown';
export interface IndicatorValue { value: number; label: string; severity: Severity; lagWeeks?: number }
export interface EconomicStressData {
  stressIndex: number;
  trend: 'rising' | 'stable' | 'falling';
  indicators: {
    yieldCurve: IndicatorValue; bankSpread: IndicatorValue; vix: IndicatorValue;
    fsi: IndicatorValue; supplyChain: IndicatorValue; jobClaims: IndicatorValue;
  };
  foodSecurity: { value: number; severity: Severity };
  updatedAt: string;
}
export async function fetchEconomicStress(): Promise<EconomicStressData>
```

Both call `getApiBaseUrl() + '/api/<route>'`. Return typed data or throw.

---

## Files to Create / Modify

**New:**

- `src/components/StatusCard.ts`
- `src/components/CommsHealthPanel.ts`
- `src/components/EconomicStressPanel.ts`
- `src/services/comms-health.ts`
- `src/services/economic-stress.ts`

**Modified:**

- `src/components/index.ts` — add `export * from './StatusCard'`
- `src-tauri/sidecar/local-api-server.mjs` — 2 new routes
- `src/config/panels.ts` — 2 new panel entries + PANEL_CATEGORY_MAP
- `src/app/panel-layout.ts` — priority lists + `_createPanels()`
- `src/app/data-loader.ts` — 2 new scheduleRefresh calls

**Not modified:** `runtime-config.ts`, `settings-constants.ts`, `main.rs` (no new keys).

---

## Panel Registration

### `src/config/panels.ts`

```typescript
'comms-health':    { name: 'Communications Health', enabled: true, priority: 1 },
'economic-stress': { name: 'Economic Stress',        enabled: true, priority: 1 },
```

PANEL_CATEGORY_MAP: `comms-health` to `'infrastructure'`, `economic-stress` to `'finance'`.

### `src/app/panel-layout.ts`

A panel key can appear in multiple priority lists — `_applyModePanelOrder` uses `currentKeys.includes(k)` per list independently.

Priority list updates:

- `WAR_PRIORITY`: add `'comms-health'` after `'space-weather'`
- `DISASTER_PRIORITY`: add `'comms-health'` after `'air-quality'`, `'economic-stress'` after `'comms-health'`
- `FINANCE_PRIORITY`: add `'economic-stress'` after `'economic'`

Also fix two stale panel IDs already in DISASTER_PRIORITY (done in same commit):

- `'natural-disasters'` removed (no such panel ID)
- `'gdacs'` replaced with `'gdacs-alerts'` (correct registered key)

Instantiate both panel classes in `_createPanels()`.

### `src/app/data-loader.ts`

```typescript
scheduleRefresh('comms-health',    fetchCommsHealth,    5 * 60 * 1000);
scheduleRefresh('economic-stress', fetchEconomicStress, 15 * 60 * 1000);
```

---

## Desktop Notifications

Fire on state transitions only (store previous state in panel instance property):

- **Comms Health:** `_previousOverall` transitions to `'warning'` or `'critical'`
- **Economic Stress:** `_previousStressIndex` crosses 70 or 85 from below

No notification on recovery. Ghost Mode suppresses all notifications.

---

## Success Criteria

- [ ] `GET /api/comms-health` returns valid JSON with all required fields
- [ ] `GET /api/economic-stress` returns valid JSON with stressIndex and all 6 indicators
- [ ] Missing Cloudflare token: Comms panel renders partial data with inline note (not blocked)
- [ ] Missing FRED key: Economic panel shows full-panel "key required" card
- [ ] StatusCard exported from `src/components/index.ts`
- [ ] Composite stress formula matches spec weights and clamp functions
- [ ] Supply chain card always shows "~6wk lag" sublabel
- [ ] `comms-health` surfaces in War + Disaster modes
- [ ] `economic-stress` surfaces in Finance + Disaster modes
- [ ] DISASTER_PRIORITY no longer contains `'natural-disasters'` or `'gdacs'`
- [ ] Notifications fire on transitions only; Ghost Mode suppresses them
- [ ] `npm run typecheck:all` passes with zero errors
- [ ] `SUPPORTED_SECRET_KEYS` count in main.rs remains 25

---

## Out of Scope

- Map layers for BGP anomaly visualization
- Historical stress index chart (Sprint 3 handles trend visualization)
- Bank-specific CDS spreads (paid data)
- Port congestion / Baltic Dry Index
