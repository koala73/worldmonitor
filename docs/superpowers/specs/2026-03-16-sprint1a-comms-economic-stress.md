# Sprint 1A — Communications Health + Economic Stress Indicators

**Date:** 2026-03-16
**Status:** Approved for implementation
**Effort estimate:** 3–5 days
**Part of:** World Monitor Survival Roadmap (Sprint 1 of 7)

---

## Overview

Two new status-dashboard panels that give instant glanceable awareness of two critical survival signals:

1. **Communications Health** — BGP anomalies, IXP status, DDoS intensity, submarine cable degradation
2. **Economic Stress** — Composite 0–100 stress index from 6 FRED indicators + global food security

Both use the existing sidecar proxy pattern. Both introduce a reusable `StatusCard` component that all future sprints will build on.

---

## New API Keys Required

Both are free, instant signup:

| Key | Source | Where entered |
|-----|--------|--------------|
| `CLOUDFLARE_RADAR_KEY` | developers.cloudflare.com → Radar API | Settings → API Keys |
| `FRED_API_KEY` | fred.stlouisfed.org/docs/api/api_key.html | Settings → API Keys |

Both panels display a "key required" card when their key is absent rather than failing silently.

---

## Sidecar Routes

### `GET /api/comms-health`

Aggregates three upstream sources in parallel. Times out each fetch independently (10s) so one slow source doesn't block the others.

**Upstream calls:**
```
Cloudflare Radar (CLOUDFLARE_RADAR_KEY):
  GET https://api.cloudflare.com/client/v4/radar/bgp/hijacks/events?limit=50
  GET https://api.cloudflare.com/client/v4/radar/bgp/leaks/events?limit=50
  GET https://api.cloudflare.com/client/v4/radar/attacks/layer7/summary

RIPE NCC Stat (no key):
  GET https://stat.ripe.net/data/routing-status/data.json?resource=0.0.0.0/0

Internet Health Report (no key):
  GET https://ihr.iijlab.net/ihr/api/hegemony/?af=4&timebin=latest&format=json
```

**Response shape:**
```json
{
  "overall": "warning",
  "bgp": { "hijacks": 14, "leaks": 2, "severity": "critical" },
  "ixp": { "status": "normal", "degraded": [] },
  "ddos": { "l7": "elevated", "l3": "normal" },
  "cables": { "degraded": ["APAC-1"], "normal": ["MAREA", "AAG"] },
  "updatedAt": "2026-03-16T04:00:00Z"
}
```

**Severity thresholds (bgp.hijacks):** `< 5` = normal, `5–15` = warning, `> 15` = critical

**Overall field:** worst of all component severities.

---

### `GET /api/economic-stress`

Fetches 6 FRED series + World Bank food security. FRED data is daily — cache response for 15 minutes server-side to avoid hammering the API.

**Upstream calls:**
```
FRED API (FRED_API_KEY) — 6 series, latest observation each:
  T10Y2Y  — 10Y-2Y yield curve spread
  TEDRATE — TED spread (banking stress)
  VIXCLS  — CBOE Volatility Index
  STLFSI4 — St. Louis Fed Financial Stress Index
  GSCPI   — NY Fed Global Supply Chain Pressure Index
  ICSA    — Initial unemployment claims (weekly)

World Bank (no key):
  GET https://api.worldbank.org/v2/country/all/indicator/AG.PRD.FOOD.XD?format=json&mrv=1
```

**Response shape:**
```json
{
  "stressIndex": 62,
  "trend": "rising",
  "indicators": {
    "yieldCurve": { "value": -0.42, "label": "INVERTED", "severity": "critical" },
    "tedSpread":  { "value": 0.31,  "label": "NORMAL",   "severity": "normal" },
    "vix":        { "value": 28.4,  "label": "ELEVATED", "severity": "warning" },
    "fsi":        { "value": 1.24,  "label": "ELEVATED", "severity": "warning" },
    "supplyChain":{ "value": -0.3,  "label": "NORMAL",   "severity": "normal" },
    "jobClaims":  { "value": 247000,"label": "RISING",   "severity": "critical" }
  },
  "foodSecurity": { "value": 61.4, "severity": "warning" },
  "updatedAt": "2026-03-16T04:00:00Z"
}
```

**Composite stress index formula:**
Each indicator is scored 0–100 (0 = no stress, 100 = extreme stress) using fixed thresholds derived from historical crisis levels. The composite is the weighted mean:

| Indicator | Weight | Normal threshold | Critical threshold |
|-----------|--------|-----------------|-------------------|
| Yield curve | 20% | > 0% | < -0.5% |
| TED spread | 15% | < 0.5% | > 1.5% |
| VIX | 20% | < 20 | > 35 |
| FSI | 20% | < 0.5 | > 2.0 |
| Supply chain | 15% | ±1σ | > 2σ |
| Job claims | 10% | < 220K | > 300K |

---

## New Components

### `src/components/StatusCard.ts`

Reusable component used by both panels and all future sprint panels.

```typescript
interface StatusCardConfig {
  label: string;
  value: string | number;
  unit?: string;
  severity: 'normal' | 'warning' | 'critical' | 'unknown';
  sublabel?: string;
  wide?: boolean; // spans full row
}
```

Renders a bordered card with color-coded background/border/text matching severity:
- `normal` → green palette
- `warning` → amber palette
- `critical` → red palette
- `unknown` → neutral (data unavailable or key missing)

No debounce issue — `StatusCard` uses direct `innerHTML` assignment, not `Panel.setContent()`.

---

### `src/components/CommsHealthPanel.ts`

Extends `Panel`. Layout:
1. Overall status banner (full width) — colored pill with dot indicator + summary text
2. 2-column StatusCard grid: BGP Hijacks, BGP Leaks, IXP Status, DDoS L7
3. Full-width cable status card with individual cable badges

Refresh: every 5 minutes via `data-loader.ts` `scheduleRefresh()`.
Error state: shows "Data unavailable" card with last-known timestamp.
No-key state: shows "CLOUDFLARE_RADAR_KEY required" card with Settings link.

---

### `src/components/EconomicStressPanel.ts`

Extends `Panel`. Layout:
1. Composite stress index bar (0–100 gradient bar with needle + numeric score + trend arrow)
2. 3-column StatusCard grid: Yield Curve, TED Spread, VIX, FSI, Supply Chain, Job Claims
3. Full-width food security footnote row

Refresh: every 15 minutes (FRED data is daily; more frequent is wasteful).
Error/no-key state: same pattern as CommsHealthPanel using `FRED_API_KEY`.

---

## New Services

### `src/services/comms-health.ts`

```typescript
export interface CommsHealthData { ... }
export async function fetchCommsHealth(): Promise<CommsHealthData>
```

Calls `${getApiBaseUrl()}/api/comms-health`. Returns typed data or throws.

### `src/services/economic-stress.ts`

```typescript
export interface EconomicStressData { ... }
export async function fetchEconomicStress(): Promise<EconomicStressData>
```

Calls `${getApiBaseUrl()}/api/economic-stress`. Returns typed data or throws.

---

## Panels Registration

### `src/config/panels.ts`

Add to `FULL_PANELS`:
```typescript
'comms-health':    { name: 'Communications Health', enabled: true, priority: 1 },
'economic-stress': { name: 'Economic Stress',        enabled: true, priority: 1 },
```

Add to `PANEL_CATEGORY_MAP`:
- `comms-health` → `'infrastructure'`
- `economic-stress` → `'finance'`

### `src/app/panel-layout.ts`

Add to `WAR_PRIORITY` (after `displacement`): `'comms-health'`
Add to `DISASTER_PRIORITY` (after `weather`): `'comms-health'`
Add to `FINANCE_PRIORITY` (after `economic`): `'economic-stress'`
Add to `DISASTER_PRIORITY` (after `comms-health`): `'economic-stress'`

### `src/app/panel-layout.ts` — `_createPanels()`

Import and instantiate both panel classes.

### `src/app/data-loader.ts`

```typescript
scheduleRefresh('comms-health',    fetchCommsHealth,    5 * 60 * 1000);
scheduleRefresh('economic-stress', fetchEconomicStress, 15 * 60 * 1000);
```

---

## Settings / API Key Integration

### `src/services/runtime-config.ts`
Add `CLOUDFLARE_RADAR_KEY` and `FRED_API_KEY` key definitions.

### `src/services/settings-constants.ts`
```typescript
CLOUDFLARE_RADAR_KEY: 'Cloudflare Radar API',
FRED_API_KEY: 'FRED (Federal Reserve Economic Data)',
```

With `SIGNUP_URLS` pointing to the free signup pages.

### `src-tauri/src/main.rs`
Increment `SUPPORTED_SECRET_KEYS` count: 27 → 29. Add both key names to the array.

---

## Desktop Notifications

Fire a desktop notification (respecting Ghost Mode suppression) when:
- Comms Health overall status transitions from `normal` → `warning` or `critical`
- Economic Stress index crosses 70 (warning threshold) or 85 (critical threshold)

Do NOT fire on every refresh — only on state transitions. Store previous state in panel instance.

---

## Success Criteria

- [ ] `GET /api/comms-health` returns valid JSON with `overall`, `bgp`, `ixp`, `ddos`, `cables` fields
- [ ] `GET /api/economic-stress` returns valid JSON with `stressIndex` and all 6 `indicators`
- [ ] Both panels render with correct severity colors
- [ ] Missing API key shows actionable "key required" card, not an error
- [ ] Panels surface in correct modes (War/Disaster for comms; Finance/Disaster for economic)
- [ ] Desktop notifications fire on status transitions, not on every refresh
- [ ] `npm run typecheck:all` passes with zero errors
- [ ] Both refresh intervals work correctly through `scheduleRefresh()`
- [ ] Ghost Mode suppresses notifications from both panels

---

## Out of Scope (future sprints)

- Map layers for BGP anomaly visualization (Sprint 3 candidate)
- Historical stress index chart (Sprint 3 Cascade Failure panel will handle trend visualization)
- Bank-specific CDS spreads (paid data, deferred)
- Port congestion / Baltic Dry Index (Sprint 2 Economic Collapse extension)
