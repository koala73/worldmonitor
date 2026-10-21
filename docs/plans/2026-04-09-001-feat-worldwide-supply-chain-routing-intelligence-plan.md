---
title: "feat: Worldwide Supply Chain Routing Intelligence — UI + Scenario Engine"
type: feat
status: active
date: 2026-04-09
origin: docs/brainstorms/2026-04-09-worldwide-shipping-intelligence-requirements.md
---

## Sprint Status (updated 2026-04-10)

| Sprint | Scope | PR | Status |
|---|---|---|---|
| 0–2 | Backend: bypass corridors, exposure seeder, chokepoint index | — | ✅ Merged |
| A | Supply Chain Panel UI: bypass cards, sector exposure, war risk badges | #2896 | 🔁 Review |
| B | Map Arc Intelligence: disruption-score arc coloring + arc click popup | — | ⏳ Not started |
| C | Scenario Engine: templates, job API, Railway worker, map activation | #2890 | 🔁 Review — ready to merge |
| D | Sector Dependency RPC + Vendor API + Sprint C visual deferrals | — | ⏳ Not started |

### Sprint C — What shipped (PR #2890)
- `api/scenario/v1/run.ts` — PRO-gated edge function, RPUSH to `scenario-queue:pending`
- `api/scenario/v1/status.ts` — polling endpoint, `pending | processing | done | failed`
- `api/scenario/v1/templates.ts` — public discovery endpoint (no PRO gate)
- `scripts/scenario-worker.mjs` — always-on Railway worker, BLMOVE atomic FIFO dequeue, pipeline Redis reads, SIGTERM handler, startup orphan drain
- `server/worldmonitor/supply-chain/v1/scenario-templates.ts` — authoritative template registry
- `src/config/scenario-templates.ts` — type-only shim for src/ consumers
- `src/components/MapContainer.ts` — `activateScenario()` / `deactivateScenario()`
- `src/components/DeckGLMap.ts` — `setScenarioState()`, arc orange recolor for disrupted routes

### Sprint C — Deferred to Sprint D
- **Globe + SVG renderer scenario state** — `activateScenario()` only dispatches to DeckGL; globe and SVG overlays need country-highlight choropleth layer
- **Tariff-shock visual** (`us-tariff-escalation-electronics`) — `affectedChokepointIds: []` means no arc recoloring; correct visualization is a country-heat overlay; `affectedIso2s` is already in `ScenarioVisualState` for Sprint D to consume
- **Panel UI** (trigger button, scenario summary card, dismiss) — Sprint A/D will add the UI surface that calls `run.ts` and renders results
- **Scenario tests** — unit + integration tests for endpoints, worker, and map activation path

# feat: Worldwide Supply Chain Routing Intelligence — UI + Scenario Engine

## Overview

WorldMonitor's supply chain backend (Sprints 0–2) is complete: bypass corridors config, chokepoint exposure seeder, bypass RPC, cost-shock RPC, and chokepoint index RPC are all live and PRO-gated. What remains is the UI layer that surfaces this data in the panel and map, plus the async scenario engine.

This plan covers four implementation sprints in priority order:
- **Sprint A** — Supply Chain Panel UI: bypass cards + sector exposure + war risk badges
- **Sprint B** — Map Arc Intelligence: disruption-score arc coloring + arc click → breakdown
- **Sprint C** — Scenario Engine: templates config + async job API + Railway worker + map activation
- **Sprint D** — Sector Dependency RPC + Vendor API

Reference: `gcc-optimal-shipping-routes.vercel.app` was the product reference app (fully analyzed 2026-04-09). See `docs/internal/worldmonitor-global-shipping-intelligence-roadmap.md` for the full 5-sprint roadmap.

---

## Problem Statement

The backend intelligence (bypass corridors, cost shock, chokepoint exposure) exists in Redis but nothing surfaces it to users. The supply chain panel shows chokepoints with disruption scores but no bypass options, no sector exposure breakdown, and no war risk tier badge. The map arcs are static blue — no disruption coloring. The scenario engine doesn't exist.

Users cannot answer "if Hormuz closes, what are my options?" from the WorldMonitor UI today.

---

## Scope Boundaries (from origin doc)

**In scope (v1):**
- HS2-sector granularity (not HS6 — that's v2)
- 6 Comtrade reporters: US, China, Russia, Iran, India, Taiwan
- 13 chokepoints
- ~40 bypass corridors (already in `bypass-corridors.ts`)
- Energy shock model for HS27 only; other sectors return `null` with explanation

**Out of scope (v2):**
- Full HS6 global coverage (195 × 5000+ products)
- AI Strategic Advisor sidebar
- HS6 product selector with 300+ items
- LOCODE port support in vendor API

---

## Technical Approach

### Architecture

```
Supply Chain Panel (SupplyChainPanel.ts)
  └─ Chokepoint card (expanded)
       ├─ PRO: Bypass Options section [NEW Sprint A]
       ├─ PRO: War Risk Tier badge    [NEW Sprint A]
       └─ PRO: HS2 Ring Chart        [NEW Sprint A — also in MapPopup]

Country Deep Dive Panel (CountryDeepDivePanel.ts)
  └─ Sector Exposure Card            [NEW Sprint A]
       ├─ Top 3 chokepoints by exposure %
       ├─ $ at risk per chokepoint
       └─ PRO gate (applyProGate)

DeckGLMap.ts
  └─ Trade Routes Arc Layer          [EXTEND Sprint B]
       ├─ Color bound to disruption score (green/yellow/red)
       └─ Arc click → popup breakdown (PRO-gated)

MapContainer.ts
  └─ activateScenario(scenarioId)    [NEW Sprint C]
       ├─ Dispatch state to all 3 renderers
       ├─ DeckGL: pulsing chokepoints + arc shift
       └─ SVG + Globe: visual state update

api/scenario/v1/run.ts               [NEW Sprint C]
api/scenario/v1/status.ts            [NEW Sprint C]
scripts/scenario-worker.mjs          [NEW Sprint C]
src/config/scenario-templates.ts     [NEW Sprint C]

server/.../get-sector-dependency.ts  [NEW Sprint D]
api/v2/shipping/route-intelligence.ts [NEW Sprint D]
api/shipping-webhook.ts              [NEW Sprint D]
```

### Key Patterns to Follow (from research)

1. **Section cards in CountryDeepDivePanel**: Use `sectionCard(title, helpText?)` → `[card, body]` tuple. Append to `bodyGrid`. PRO gate: `applyProGate()` + `subscribeAuthState()` + `trackGateHit('feature')`.

2. **TransitChart post-render mount**: Use `MutationObserver` observing `this.content` with `{ childList: true, subtree: true }`. 220ms `setTimeout` fallback. See `SupplyChainPanel.ts:134-158` for exact pattern.

3. **Arc layer coloring**: Extend existing `createTradeRoutesLayer()` in `DeckGLMap.ts:4959`. `colorFor(status)` already maps `'disrupted'/'high_risk'/'active'` to RGBA tuples. Bind to chokepoint disruption score: score > 70 → `'disrupted'`, 30–70 → `'high_risk'`, < 30 → `'active'`.

4. **MapContainer state dispatch**: Store callback refs like `cachedOnStateChanged`. Use `setLayers()` to broadcast across all 3 renderers. New `activateScenario()` follows the same pattern.

5. **PRO gate**: `isCallerPremium(ctx.request)` already in all server RPCs. Client-side: `hasPremiumAccess(getAuthState())` for immediate check, `subscribeAuthState(state => ...)` for reactive.

6. **Async jobs** (no prior pattern in repo): Redis queue via `RPUSH scenario-queue:pending` on enqueue, `BLMOVE scenario-queue:pending scenario-queue:processing LEFT RIGHT` on dequeue.

7. **country-port-clusters.json**: Referenced by `seed-hs2-chokepoint-exposure.mjs:54` but not yet created. Must exist before the seeder works correctly in prod.

---

## Implementation Units

### Sprint A — Supply Chain Panel UI

#### A1: country-port-clusters.json

**Goal:** Create the static config file `scripts/shared/country-port-clusters.json` that maps each iso2 to `{ nearestRouteIds, coastSide }`. Referenced by `seed-hs2-chokepoint-exposure.mjs` but not yet present.

**Files:**
- `scripts/shared/country-port-clusters.json` — new file, ~195 country entries

**Approach:**
- Map each country's ISO2 to the nearest named trade route IDs from `src/config/trade-routes.ts` and a coast side (`atlantic | pacific | indian | med | multi | landlocked`).
- Cover all 195 UN member states + major territories.
- Example entry:
  ```json
  {
    "US": { "nearestRouteIds": ["transpacific", "transatlantic"], "coastSide": "multi" },
    "JP": { "nearestRouteIds": ["far-east-europe", "transpacific"], "coastSide": "pacific" },
    "SA": { "nearestRouteIds": ["indian-ocean-gulf", "red-sea"], "coastSide": "indian" },
    "DE": { "nearestRouteIds": ["transatlantic", "northern-europe"], "coastSide": "atlantic" }
  }
  ```
- For landlocked countries: `{ "nearestRouteIds": [], "coastSide": "landlocked" }`.

**Patterns to follow:**
- `src/config/chokepoint-registry.ts` — static config shape
- `seed-hs2-chokepoint-exposure.mjs:54` — import usage site

**Verification:**
- All 195 countries present in the JSON with valid `nearestRouteIds` (array, may be empty for landlocked)
- `coastSide` is one of: `atlantic | pacific | indian | med | multi | landlocked`
- No duplicate entries
- `node -e "const d=require('./scripts/shared/country-port-clusters.json'); console.log(Object.keys(d).length)"` prints ≥ 195

---

#### A2: War Risk Tier Badge in SupplyChainPanel Chokepoint Cards

**Goal:** Each expanded chokepoint card in `SupplyChainPanel.ts` shows a war risk tier badge derived from `cp.warRiskTier`. This is **free** — uses existing data in `GetChokepointStatusResponse`.

**Files:**
- `src/components/SupplyChainPanel.ts` — add badge rendering in `renderChokepoints()`
- `src/styles/supply-chain-panel.css` — add `.sc-war-risk-badge` styles

**Approach:**
- In `renderChokepoints()`, after the disruption score line, add:
  ```ts
  const tier = cp.warRiskTier ?? 'WAR_RISK_TIER_NORMAL';
  const tierLabel: Record<string, string> = {
    WAR_RISK_TIER_WAR_ZONE: 'War Zone', WAR_RISK_TIER_CRITICAL: 'Critical',
    WAR_RISK_TIER_HIGH: 'High', WAR_RISK_TIER_ELEVATED: 'Elevated',
    WAR_RISK_TIER_NORMAL: 'Normal',
  };
  const tierClass: Record<string, string> = {
    WAR_RISK_TIER_WAR_ZONE: 'war', WAR_RISK_TIER_CRITICAL: 'critical',
    WAR_RISK_TIER_HIGH: 'high', WAR_RISK_TIER_ELEVATED: 'elevated',
    WAR_RISK_TIER_NORMAL: 'normal',
  };
  ```
- Badge: `<span class="sc-war-risk-badge sc-war-risk-badge--${tierClass[tier]}">${tierLabel[tier]}</span>`
- CSS: red for `war/critical`, orange for `high/elevated`, grey for `normal`.
- Free — no `isCallerPremium` check needed; `warRiskTier` is already in the public chokepoint response.

**Patterns to follow:**
- Existing disruption score badge in `SupplyChainPanel.ts`
- CSS from `src/styles/chokepoint-card.css`

**Verification:**
- Bab el-Mandeb card shows "War Zone" badge
- Normal chokepoints show "Normal" badge in muted grey
- Badge visible to free and PRO users alike

---

#### A3: Bypass Options Section in SupplyChainPanel Chokepoint Card

**Goal:** When a chokepoint card is expanded in `SupplyChainPanel.ts`, show top 3 bypass options. PRO-gated.

**Files:**
- `src/components/SupplyChainPanel.ts` — add bypass section to expanded chokepoint card
- `src/services/supply-chain/index.ts` — `fetchBypassOptions` already exists
- `src/styles/supply-chain-panel.css` — add `.sc-bypass-*` styles

**Approach:**
- In `renderChokepoints()`, for the expanded card, add a bypass section below the transit chart:
  ```ts
  const bypassSection = document.createElement('div');
  bypassSection.className = 'sc-bypass-section';
  ```
- Call `fetchBypassOptions(cp.id, 'container', 100)` when card expands (same trigger as TransitChart mount).
- Render a 3-row table: `Name | +Days | +$/ton | Risk`
- PRO gate: if `!hasPremiumAccess(getAuthState())`, render a locked placeholder:
  ```html
  <div class="sc-bypass-gate">
    <span class="lock-icon">🔒</span>
    <span>Bypass corridors available with PRO</span>
    <button class="upgrade-btn">Upgrade</button>
  </div>
  ```
- Subscribe auth state: `subscribeAuthState(state => applyProGate(hasPremiumAccess(state)))`.
- `trackGateHit('bypass-corridors')` on initial non-PRO impression.
- Loading state: show skeleton while fetching.
- Error state: "Bypass data unavailable" (don't crash).

**Patterns to follow:**
- `SupplyChainPanel.ts:134-158` — MutationObserver + 220ms fallback for TransitChart; same trigger for bypass fetch
- `src/app/event-handlers.ts:1027-1032` — `applyProGate` + `subscribeAuthState` pattern
- `fetchBypassOptions` signature at `src/services/supply-chain/index.ts:122-133`

**Verification:**
- PRO user expanding Suez card sees ≥ 1 bypass option ("Cape of Good Hope")
- Hormuz card shows ≥ 3 options
- Free user sees locked placeholder with upgrade CTA
- `trackGateHit('bypass-corridors')` fires on free user card expand (verify via analytics debug log)

---

#### A4: Sector Exposure Card in CountryDeepDivePanel

**Goal:** Add a "Trade Exposure" section card to `CountryDeepDivePanel.ts` showing the country's top 3 chokepoints by HS2 exposure %. PRO-gated.

**Files:**
- `src/components/CountryDeepDivePanel.ts` — new `updateTradeExposure(data)` method + section card
- `src/app/country-intel.ts` — new `getCountryChokepointIndex` call site
- `src/styles/cdp.css` — add `.cdp-trade-exposure-*` styles

**Approach:**
- In `CountryDeepDivePanel.ts`, add private field `private tradeExposureBody: HTMLElement | null = null`.
- In `buildLayout()`, create section card:
  ```ts
  const [tradeCard, tradeBody] = this.sectionCard(
    'Trade Exposure',
    'Chokepoints most critical to this country\'s imports by sector',
    'trade-exposure'
  );
  this.tradeExposureBody = tradeBody;
  bodyGrid.append(tradeCard);
  ```
- Public method `updateTradeExposure(data: GetCountryChokepointIndexResponse | null)`:
  - If not PRO or `data == null` or `data.exposures.length === 0`: `this.tradeExposureBody?.parentElement?.remove()`.
  - Otherwise, render 3-row exposure table:
    ```html
    <table class="cdp-trade-exposure-table">
      <tr>
        <td class="cdp-chokepoint-name">{chokepointName}</td>
        <td class="cdp-exposure-bar" style="width: {exposureScore}%"></td>
        <td class="cdp-exposure-pct">{exposureScore.toFixed(1)}%</td>
      </tr>
    </table>
    ```
  - Show `vulnerabilityIndex` as an overall score: `<div class="cdp-vuln-index">Vulnerability: {Math.round(data.vulnerabilityIndex)}/100</div>`.
  - For HS27 (energy): also show cost shock data via `fetchCountryCostShock(iso2, primaryChokepointId)` — `coverageDays` + `supplyDeficitPct`.
  - Footer: `<div class="cdp-card-footer">Source: Comtrade + PortWatch · HS2 sectors</div>`.
- Reset: `this.tradeExposureBody = null` in `resetPanelContent()`.
- PRO gate: render locked placeholder for free users; `trackGateHit('shipping-exposure')`.

**Call site in `country-intel.ts`:**
- After country resolves, call `fetchCountryChokepointIndex(code, '27')`.
- Stale guard: `if (this.getCode() !== code) return`.
- On success: `this.panel?.updateTradeExposure?.(result)`.
- On error: `this.panel?.updateTradeExposure?.(null)`.

**Patterns to follow:**
- `CountryDeepDivePanel.ts:1286-1327` — `bodyGrid.append(cards)` + private body field
- `updateMaritimeActivity` method — exact same pattern
- `src/app/country-intel.ts` — existing `getCountryPortActivity` call site as template

**Verification:**
- For US: section card shows top 3 chokepoints with exposure bars (US is seeded reporter)
- For DE: section card removes itself (DE not in v1 seeded reporters)
- For non-PRO user: locked placeholder shown, `trackGateHit('shipping-exposure')` fires
- `this.tradeExposureBody = null` in `resetPanelContent()` prevents stale renders

---

#### A5: HS2 Ring Chart in MapPopup Chokepoint Detail

**Goal:** In the chokepoint popup (`MapPopup.ts:renderWaterwayPopup()`), add an HS2 sector ring chart showing top sectors by exposure %. PRO-gated. Follows existing TransitChart post-render mount pattern.

**Files:**
- `src/components/MapPopup.ts` — extend `renderWaterwayPopup()` + add `HS2RingChart` mount
- `src/utils/hs2-ring-chart.ts` — new mini canvas chart (similar to `transit-chart.ts`)
- `src/styles/map-popup.css` — add `.popup-hs2-ring-*` styles

**Approach:**
- In `renderWaterwayPopup()`, after the transit chart element, add:
  ```html
  <div class="popup-section-title">Sector Exposure</div>
  <div data-hs2-ring="${waterway.chokepointId}" class="popup-hs2-ring-container"></div>
  ```
- Post-render: in the `setTimeout` that mounts TransitChart, also mount HS2RingChart:
  ```ts
  const ringEl = this.popup.querySelector<HTMLElement>(`[data-hs2-ring="${waterway.chokepointId}"]`);
  if (ringEl && isPro) {
    const country = getCurrentSelectedCountry(); // from app state
    if (country) {
      fetchCountryChokepointIndex(country, '27').then(data => {
        if (data.exposures.length) new HS2RingChart().mount(ringEl, data.exposures);
      });
    }
  }
  ```
- `HS2RingChart` (`src/utils/hs2-ring-chart.ts`): canvas-based donut chart. Input: `ChokepointExposureEntry[]`. Renders top 5 sectors as arc slices with `exposureScore` proportions. Labels outside with HS2 chapter names from `hs2-sectors.ts`.
- PRO gate: if not PRO, render a 2-line teaser (`<div class="popup-hs2-gate">Sector breakdown available with PRO</div>`).
- `trackGateHit('chokepoint-sector-ring')` for free users.

**Patterns to follow:**
- `MapPopup.ts:267-281` — TransitChart mount + PRO gate pattern
- `src/utils/transit-chart.ts` — `mount(el, data)` interface
- `src/config/hs2-sectors.ts` — HS2 label lookup

**Verification:**
- PRO user clicking Suez popup sees donut chart with top 5 HS2 sectors
- For countries without Comtrade data, chart renders empty state "Sector data unavailable for this country"
- Free user sees 2-line teaser, `trackGateHit('chokepoint-sector-ring')` fires

---

### Sprint B — Map Arc Intelligence

#### B1: Disruption-Score Arc Coloring

**Goal:** Trade route arcs in `DeckGLMap.ts` are colored by the chokepoint disruption score of routes they transit.

**Files:**
- `src/components/DeckGLMap.ts` — extend `createTradeRoutesLayer()` (line 4959)
- `src/services/supply-chain/index.ts` — read from chokepoint status cache

**Approach:**
- Each `TradeRouteSegment` already has a `status` field. The existing `colorFor(status)` maps `'disrupted'/'high_risk'/'active'` to RGBA tuples.
- Add a new step: when chokepoint status data updates (called from `setChokepointData()`), update each segment's `status`:
  ```ts
  private refreshTradeRouteStatus(chokepoints: ChokepointInfo[]): void {
    const scoreMap = new Map(chokepoints.map(cp => [cp.id, cp.disruptionScore ?? 0]));
    this.tradeRouteSegments = this.tradeRouteSegments.map(seg => ({
      ...seg,
      status: seg.waypointChokepointIds
        .map(id => scoreMap.get(id) ?? 0)
        .reduce((max, s) => Math.max(max, s), 0) > 70 ? 'disrupted'
          : seg.waypointChokepointIds
          .map(id => scoreMap.get(id) ?? 0)
          .reduce((max, s) => Math.max(max, s), 0) > 30 ? 'high_risk' : 'active',
    }));
    this.rerender(); // trigger DeckGL redraw
  }
  ```
- This is PRO-gated visually: add a check — if not PRO, all segments render as `'active'` (uncolored) regardless.
- PRO users see disruption-reactive arc colors; `trackGateHit('trade-arc-intel')` when free user inspects a colored arc.
- Call `refreshTradeRouteStatus()` inside `setChokepointData()` whenever chokepoint data refreshes.

**Patterns to follow:**
- `DeckGLMap.ts:4959-4979` — `createTradeRoutesLayer()` exact structure
- `colorFor(status)` pattern already exists — just feed it the right `status` string

**Verification:**
- With Bab el-Mandeb `disruptionScore > 70`, arcs transiting that chokepoint turn red
- Free user sees all arcs in the default blue/active color
- No arc layer rebuild — status update triggers `rerender()` only

---

#### B2: Arc Click → Sector Exposure Popup

**Goal:** PRO users clicking a trade route arc see a mini popup with sector exposure breakdown for the primary chokepoint on that route.

**Files:**
- `src/components/DeckGLMap.ts` — set `pickable: true` on `createTradeRoutesLayer()`; add `onHover`/`onClick` handlers
- `src/components/MapPopup.ts` — new `showRouteBreakdown(segment, chokepointData)` method

**Approach:**
- Set `pickable: true` on the arc layer.
- `onClick` handler:
  ```ts
  onClick: ({ object }) => {
    if (!object) return;
    const isPro = hasPremiumAccess(getAuthState());
    if (!isPro) { trackGateHit('trade-arc-intel'); return; }
    this.callbacks.onRouteArcClick?.(object); // new callback
  }
  ```
- `MapContainer.ts` wires `onRouteArcClick` to `MapPopup.showRouteBreakdown(segment, chokepointData)`.
- `showRouteBreakdown` renders a mini popup: route name, primary chokepoint, disruption score, war risk tier, top 2 HS2 sectors (from last cached `getCountryChokepointIndex` for the selected country).
- Popup closes on outside click (same as existing popup dismiss logic).

**Patterns to follow:**
- Existing `pickable` arc layers (displacement flows arc layer in `DeckGLMap.ts:4919-4935`)
- `MapPopup` existing `show/hide` and positioning methods

**Verification:**
- PRO user clicking a red arc over Hormuz sees popup: "Persian Gulf – Hormuz Strait, Disruption: 85, War Zone, Sectors: Energy 60%, Electronics 18%"
- Free user clicking arc — no popup, `trackGateHit('trade-arc-intel')` fires
- Popup dismissed on background click

---

### Sprint C — Scenario Engine

#### C1: Scenario Templates Config

**Goal:** Create `src/config/scenario-templates.ts` with 6 pre-built scenario definitions.

**Files:**
- `src/config/scenario-templates.ts` — new file

**Approach:**
```ts
// src/config/scenario-templates.ts
export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  type: 'conflict' | 'weather' | 'sanctions' | 'tariff_shock' | 'infrastructure' | 'pandemic';
  affectedChokepointIds: string[];  // from chokepoint-registry.ts
  disruptionPct: number;            // 0-100
  durationDays: number;
  affectedHs2?: string[];           // null = all sectors
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: 'taiwan-strait-full-closure',
    name: 'Taiwan Strait Full Closure',
    description: 'Complete closure of Taiwan Strait for 30 days — electronics and machinery supply chains',
    type: 'conflict',
    affectedChokepointIds: ['taiwan_strait'],
    disruptionPct: 100,
    durationDays: 30,
    affectedHs2: ['84', '85', '87'],
  },
  // ... 5 more
];
```

**Pre-built templates (6):**
1. Taiwan Strait full closure (conflict, 100%, 30d, HS 84/85/87)
2. Suez + Bab-el-Mandeb simultaneous disruption (conflict, 80%, 60d, all sectors)
3. Panama drought — 50% capacity (weather, 50%, 90d, all sectors)
4. Hormuz tanker blockade (conflict, 100%, 14d, HS 27 energy)
5. Russia Baltic grain suspension (sanctions, 100%, 180d, HS 10/12 food)
6. US tariff escalation on electronics (tariff_shock, 0% chokepoint but 30% cost shock, 365d, HS 85)

**Patterns to follow:** `src/config/bypass-corridors.ts` — same static typed array pattern

**Verification:** TypeScript compiles. `SCENARIO_TEMPLATES.length === 6`. Each template references valid `chokepointIds` from `chokepoint-registry.ts`.

---

#### C2: Scenario Job API (Vercel Edge Functions)

**Goal:** `POST /api/scenario/v1/run` + `GET /api/scenario/v1/status` for async scenario job dispatch.

**Files:**
- `api/scenario/v1/run.ts` — edge function: validate + PRO gate + enqueue + return jobId
- `api/scenario/v1/status.ts` — edge function: poll job result from Redis
- `server/worldmonitor/supply-chain/v1/scenario-compute.ts` — pure compute function (no I/O)

**Approach — `run.ts`:**
```ts
// api/scenario/v1/run.ts
import { validateApiKey } from '../_api-key';
import { isCallerPremium } from '../../server/_shared/premium-check';
import { getRedisCredentials } from '../../server/_shared/redis';

export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  await validateApiKey(req, { forceKey: false }); // browser auth OK
  const isPro = await isCallerPremium(req);
  if (!isPro) return new Response(JSON.stringify({ error: 'PRO required' }), { status: 403 });

  const body = await req.json();
  const { scenarioId, iso2 } = body; // optional iso2 to scope impact

  const jobId = `scenario:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ jobId, scenarioId, iso2: iso2 ?? null, enqueuedAt: Date.now() });

  const { url, token } = getRedisCredentials();
  await fetch(`${url}/rpush/scenario-queue:pending`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([payload]),
  });

  return new Response(JSON.stringify({ jobId, status: 'pending' }), { status: 202 });
}
```

**Approach — `status.ts`:**
```ts
export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  if (!jobId || !/^scenario:[0-9]+:[a-z0-9]+$/.test(jobId)) {
    return new Response(JSON.stringify({ error: 'invalid jobId' }), { status: 400 });
  }
  const result = await getCachedJson(`scenario-result:${jobId}`).catch(() => null);
  if (!result) return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
  return new Response(JSON.stringify(result), { status: 200 });
}
```

**Security:** `jobId` regex-validated to prevent Redis key injection. `forceKey: false` uses browser auth. `validateApiKey(req, { forceKey: true })` would be needed for server-to-server use.

**Patterns to follow:**
- `api/supply-chain/v1/[rpc].ts` — edge function export pattern
- `api/_api-key.js:49` — `validateApiKey` with `forceKey` option

**Verification:**
- `POST /api/scenario/v1/run` with PRO JWT returns `{ jobId, status: 'pending' }`, HTTP 202
- `POST /api/scenario/v1/run` without PRO returns HTTP 403
- `GET /api/scenario/v1/status?jobId=invalid` returns HTTP 400
- `GET /api/scenario/v1/status?jobId={valid but unknown}` returns `{ status: 'pending' }`

---

#### C3: Scenario Worker (Railway)

**Goal:** Railway worker `scripts/scenario-worker.mjs` that atomically dequeues jobs, runs the scenario compute, writes results to Redis.

**Files:**
- `scripts/scenario-worker.mjs` — new Railway worker

**Approach:**
```js
// scripts/scenario-worker.mjs
import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const QUEUE_KEY = 'scenario-queue:pending';
const PROCESSING_KEY = 'scenario-queue:processing';
const RESULT_TTL = 86400; // 24h

async function redisCommand(cmd, args) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/${cmd}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await resp.json();
  return body.result;
}

async function runWorker() {
  console.log('[scenario-worker] listening...');
  while (true) {
    // Atomic FIFO dequeue+claim (Redis 6.2+)
    const raw = await redisCommand('blmove', [QUEUE_KEY, PROCESSING_KEY, 'LEFT', 'RIGHT', 30]);
    if (!raw) continue; // timeout, loop back

    let job;
    try { job = JSON.parse(raw); } catch { continue; }

    const { jobId, scenarioId, iso2 } = job;
    console.log(`[scenario-worker] processing ${jobId} (${scenarioId})`);

    // Check idempotency
    const existing = await redisCommand('get', [`scenario-result:${jobId}`]);
    if (existing) {
      await redisCommand('lrem', [PROCESSING_KEY, 1, raw]);
      continue;
    }

    try {
      const result = await computeScenario(scenarioId, iso2);
      await redisCommand('setex', [`scenario-result:${jobId}`, RESULT_TTL, JSON.stringify({ status: 'done', result, completedAt: Date.now() })]);
    } catch (err) {
      await redisCommand('setex', [`scenario-result:${jobId}`, RESULT_TTL, JSON.stringify({ status: 'failed', error: err.message })]);
    } finally {
      await redisCommand('lrem', [PROCESSING_KEY, 1, raw]);
    }
  }
}

runWorker().catch(err => { console.error(err); process.exit(1); });
```

**`computeScenario(scenarioId, iso2)`:**
- Loads scenario template from a lightweight copy of `SCENARIO_TEMPLATES` (no TS imports)
- Reads chokepoint status from Redis: `supply_chain:chokepoints:v4`
- For each affected country (all if `iso2 === null`, or just the specified country):
  - Reads `supply-chain:exposure:{iso2}:{hs2}:v1` from Redis
  - Computes disruption impact: `exposureScore × disruptionPct / 100`
  - Ranks by `importValue × adjustedExposure`
- Returns top-20 countries by impact + per-chokepoint bypass options

**Railway service setup (per `railway-seed-setup` skill):**
- `startCommand`: `node scenario-worker.mjs`
- `rootDirectory`: `scripts`
- `vCPUs: 1`, `memoryGB: 1`
- No cron schedule (always-on worker, not cron)

**BLMOVE note:** Upstash supports `LMOVE`/`BLMOVE` (Redis 6.2 commands). If unavailable, fallback: Lua script `RPOPLPUSH` equivalent. Test in staging first.

**Verification:**
- Worker logs "processing {jobId}" and writes `scenario-result:{jobId}` within 30s
- Idempotency: running same jobId twice only writes result once
- On `computeScenario` throw: result has `{ status: 'failed', error }` (no orphaned processing entry)
- Processing list is always cleaned up in `finally` block

---

#### C4: MapContainer.activateScenario() + Visual States

**Goal:** `MapContainer.activateScenario(scenarioId, result)` broadcasts scenario state to all 3 renderers, triggering visual changes.

**Files:**
- `src/components/MapContainer.ts` — new `activateScenario()` + `deactivateScenario()` methods
- `src/components/DeckGLMap.ts` — `setScenarioState(state: ScenarioVisualState | null)` method
- `src/components/SupplyChainPanel.ts` — scenario summary card pinned to top of panel

**Approach — `MapContainer.ts`:**
```ts
interface ScenarioVisualState {
  disruptedChokepointIds: string[];
  affectedIso2s: string[];        // countries with impact > threshold
  impactLevel: 'low' | 'med' | 'high'; // per country
}

public activateScenario(scenarioId: string, result: ScenarioResult): void {
  const isPro = hasPremiumAccess(getAuthState());
  if (!isPro) { trackGateHit('scenario'); return; }

  const state: ScenarioVisualState = {
    disruptedChokepointIds: result.affectedChokepointIds,
    affectedIso2s: result.topImpactCountries.map(c => c.iso2),
    impactLevel: 'high',
  };
  this.activeRenderer?.setScenarioState?.(state);  // DeckGL
  this.svgMap?.setScenarioState?.(state);           // SVG
  this.globeMap?.setScenarioState?.(state);         // Globe (optional, best-effort)
  this.panel?.showScenarioSummary?.(scenarioId, result); // panel card
}

public deactivateScenario(): void {
  this.activeRenderer?.setScenarioState?.(null);
  this.svgMap?.setScenarioState?.(null);
  this.globeMap?.setScenarioState?.(null);
  this.panel?.hideScenarioSummary?.();
}
```

**DeckGLMap visual state (`setScenarioState`):**
- For `disruptedChokepointIds`: add pulsing CSS class to chokepoint markers (via existing `setView` mechanism that triggers marker DOM updates, or via DeckGL `ScatterplotLayer` with pulsing `radiusScale` animation)
- For trade route arcs: `status = 'disrupted'` for routes transiting affected chokepoints (orange/red palette)
- For country choropleth fill: countries in `affectedIso2s` get a semi-transparent red tint overlay (new `ScatterplotLayer` or modify existing fill layer)

**SVG Map visual state:** simpler — country fills change to red tint for affected ISO2s.

**Scenario summary card in `SupplyChainPanel`:**
- Pinned card at top: "⚠️ Taiwan Strait Scenario · Top 5 Affected: DE (#1, 42%), FR (#2, 38%)..."
- Dismiss button calls `MapContainer.deactivateScenario()`.

**Patterns to follow:**
- `MapContainer.ts:756-785` — `setOnLayerChange()` broadcasts to all renderers
- `MapContainer.ts:401-405` — `setLayers()` broadcast pattern
- State dispatch uses `this.activeRenderer` for the currently visible renderer

**Verification:**
- `activateScenario('taiwan-strait-full-closure', result)` → Bashi/Miyako arcs turn orange, Taiwan Strait marker pulses
- Panel shows pinned scenario summary card
- `deactivateScenario()` restores all visual state to normal
- Free user calling `activateScenario` → no visual change, `trackGateHit('scenario')` fires

---

### Sprint D — Sector Dependency RPC + Vendor API + Sprint C Visual Deferrals

**Carries over from Sprint C:**
- Scenario panel UI: trigger button, scenario summary card with top-impact country list, dismiss
- Globe renderer: scenario state dispatch in `activateScenario()` → GlobeMap country highlight
- SVG renderer: same dispatch → choropleth overlay
- Tariff-shock visual: country-heat layer using `affectedIso2s` from `ScenarioVisualState`
- Free user PRO gate on scenario activation: `trackGateHit('scenario-engine')` + upgrade CTA
- Scenario integration tests: endpoints, worker mock, map activation path

#### D1: get-sector-dependency RPC

**Goal:** New RPC `GetSectorDependency` returns dependency flags (SINGLE_SOURCE_CRITICAL, etc.) for a country + HS2 sector.

**Files:**
- `server/worldmonitor/supply-chain/v1/get-sector-dependency.ts` — new handler
- `proto/worldmonitor/supply_chain/v1/get_sector_dependency.proto` — new proto
- `proto/worldmonitor/supply_chain/v1/service.proto` — register new RPC
- `server/worldmonitor/supply-chain/v1/handler.ts` — register handler
- `api/supply-chain/v1/[rpc].ts` — routed automatically
- `src/generated/...` — run `make generate` after proto changes
- `server/_shared/cache-keys.ts` — add `SECTOR_DEPENDENCY_KEY`
- `api/bootstrap.js` — NOT added (request-varying, excluded from bootstrap)

**Proto:**
```protobuf
message GetSectorDependencyRequest {
  string iso2 = 1;
  string hs2 = 2;
}

message GetSectorDependencyResponse {
  string iso2 = 1;
  string hs2 = 2;
  string hs2_label = 3;
  repeated DependencyFlag flags = 4;
  string primary_exporter_iso2 = 5;
  double primary_exporter_share = 6;   // 0-1
  string primary_chokepoint_id = 7;
  double primary_chokepoint_exposure = 8; // 0-100
  bool has_viable_bypass = 9;
  string fetched_at = 10;
}

enum DependencyFlag {
  DEPENDENCY_FLAG_UNSPECIFIED = 0;
  DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL = 1;   // >80% from 1 exporter
  DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL = 2; // >80% via 1 chokepoint, no bypass
  DEPENDENCY_FLAG_COMPOUND_RISK = 3;            // both of the above
  DEPENDENCY_FLAG_DIVERSIFIABLE = 4;            // bypass exists + multiple exporters
}
```

**Server logic:**
1. `isCallerPremium` guard
2. Read `supply-chain:exposure:{iso2}:{hs2}:v1` from Redis (seeded by `seed-hs2-chokepoint-exposure.mjs`)
3. Read top exporter from Comtrade data (`comtrade:flows:{numericCode}:2709` pattern)
4. Read bypass options for primary chokepoint via `BYPASS_CORRIDORS_BY_CHOKEPOINT`
5. Compute flags: `primaryExporterShare > 0.8` → `SINGLE_SOURCE_CRITICAL`, `primaryChokepointExposure > 80 && !hasViableBypass` → `SINGLE_CORRIDOR_CRITICAL`, both → `COMPOUND_RISK`, has bypass + exporters → `DIVERSIFIABLE`

**Cache:** `supply-chain:sector-dep:{iso2}:{hs2}:v1` with TTL 86400 (24h).

**Verification:**
- Japan HS2=85 (electronics): flags `SINGLE_CORRIDOR_CRITICAL` (Taiwan Strait)
- US HS2=27 (energy): flags `DIVERSIFIABLE` (IEA stocks + multiple suppliers)
- 4-file checklist: `cache-keys.ts` ✓, handler registration ✓, health.js ✓ (not bootstrap)
- `make generate` runs cleanly

---

#### D2: Vendor REST API (Route Intelligence)

**Goal:** `GET /api/v2/shipping/route-intelligence` — authenticated endpoint returning route + disruption + bypass for a given country pair.

**Files:**
- `api/v2/shipping/route-intelligence.ts` — new edge function
- `api/v2/shipping/webhooks.ts` — new HMAC webhook registration endpoint

**Route Intelligence API:**
```
GET /api/v2/shipping/route-intelligence
  X-WorldMonitor-Key: <api_key>
  ?fromIso2=US&toIso2=JP&cargoType=container&hs2=85
```

```ts
export const config = { runtime: 'edge' };
export default async function handler(req: Request) {
  await validateApiKey(req, { forceKey: true }); // vendor MUST send key
  // ... build response from chokepoint status + bypass options
}
```

Response shape:
```json
{
  "fromIso2": "US",
  "toIso2": "JP",
  "primaryRouteId": "transpacific",
  "chokepointExposures": [{ "chokepointId": "taiwan_strait", "exposurePct": 60 }],
  "bypassOptions": [...],
  "warRiskTier": "WAR_RISK_TIER_ELEVATED",
  "disruptionScore": 45,
  "fetchedAt": "2026-04-09T..."
}
```

**Webhook registration (`api/v2/shipping/webhooks.ts`):**
- `POST`: register `{ callbackUrl, chokepointIds[], alertThreshold }` → returns `{ subscriberId, secret }`
- `GET /{subscriberId}`: status check
- `POST /{subscriberId}/rotate-secret`: secret rotation (old valid 10min)
- `POST /{subscriberId}/reactivate`: re-enable after suspension

**SSRF prevention (mandatory, from roadmap):**
- Resolve `callbackUrl` hostname before each webhook delivery
- Reject private IPs: `127.x`, `10.x`, `192.168.x`, `172.16.0.0/12`, `169.254.x.x`
- Reject metadata: `169.254.169.254`, `fd00:ec2::254`
- No redirects to blocked targets

**HMAC signature:** `X-WM-Signature: sha256=<HMAC-SHA256(JSON.stringify(payload), secret)>`

**Verification:**
- `GET /api/v2/shipping/route-intelligence` without key returns HTTP 401
- `GET /api/v2/shipping/route-intelligence?fromIso2=US&toIso2=JP&hs2=85` with valid key returns non-empty response
- Webhook registration with `callbackUrl: http://169.254.169.254/` is rejected with 400

---

## System-Wide Impact

### Interaction Graph

```
user expands chokepoint card (SupplyChainPanel)
  → fetchBypassOptions(chokepointId) → /api/supply-chain/v1/get-bypass-options → Redis
  → isCallerPremium(request) → Convex auth check
  → BYPASS_CORRIDORS_BY_CHOKEPOINT config → getCachedJson('supply_chain:chokepoints:v4')

user opens country panel (CountryDeepDivePanel)
  → country-intel.ts fetchCountryChokepointIndex(iso2, '27')
  → /api/supply-chain/v1/get-country-chokepoint-index → Redis seed key
  → if result: updateTradeExposure(result) → DOM render
  → if HS27 + PRO: fetchCountryCostShock(iso2, primaryCp) → /api/supply-chain/v1/get-country-cost-shock

user clicks arc (DeckGLMap, PRO)
  → MapContainer.onRouteArcClick(segment)
  → MapPopup.showRouteBreakdown(segment, chokepointData)
  → reads last cached fetchCountryChokepointIndex (in-memory, no new fetch)

scenario run (PRO user)
  → POST /api/scenario/v1/run → RPUSH scenario-queue:pending
  → scenario-worker.mjs (Railway) → BLMOVE → computeScenario()
  → SETEX scenario-result:{jobId}
  → client polls GET /api/scenario/v1/status?jobId=X (every 2s, max 30s)
  → on done: MapContainer.activateScenario(id, result) → all 3 renderers update
```

### Error Propagation

- `fetchBypassOptions` fails → bypass section shows "Bypass data unavailable" (no crash, no empty white space)
- `fetchCountryChokepointIndex` fails → `updateTradeExposure(null)` removes card from DOM
- Scenario worker crash → `finally` block removes job from processing queue; `scenario-result:{jobId}` never written; poll returns `{ status: 'pending' }` forever (add stale detection in status endpoint: if `enqueuedAt > 10min ago` → `{ status: 'failed', error: 'timeout' }`)
- Redis unavailable → all RPC handlers return graceful empty responses (existing pattern)

### State Lifecycle Risks

- Bypass fetch fires on card expand; result is not cached in component state — if user collapses+reopens, another fetch fires. Add a per-chokepoint in-memory cache (`Map<string, BypassOption[]>`) in `SupplyChainPanel`.
- `tradeExposureBody = null` in `resetPanelContent()` is critical — without it, updating a closed panel will crash.
- Scenario result TTL is 24h. Stale scenarios are fine (user can re-run). No cleanup needed.

### API Surface Parity

- `fetchBypassOptions` already exists in `src/services/supply-chain/index.ts` — UI just needs to call it
- `fetchCountryChokepointIndex` already exists — same
- New: `fetchSectorDependency` (Sprint D) must be added to `src/services/supply-chain/index.ts`
- Vendor API (`/api/v2/shipping/*`) is separate surface — no frontend consumption

---

## Acceptance Criteria

### Sprint A

- [ ] Chokepoint card (expanded) shows war risk tier badge (free, no PRO gate)
- [ ] Chokepoint card (expanded, PRO) shows top 3 bypass options with added days + $/ton
- [ ] Free user expanding chokepoint card sees bypass gate + upgrade CTA; `trackGateHit('bypass-corridors')` fires
- [ ] CountryDeepDivePanel for US shows "Trade Exposure" card with ≥ 1 chokepoint + exposure bar
- [ ] CountryDeepDivePanel for DE: Trade Exposure card removes itself (not seeded in v1)
- [ ] MapPopup Suez → HS2 ring chart visible for PRO user
- [ ] `resetPanelContent()` sets `tradeExposureBody = null`

### Sprint B

- [ ] DeckGLMap arcs for routes through Bab el-Mandeb are red when `disruptionScore > 70`
- [ ] Arc colors update within 2s of chokepoint data refresh (no page reload)
- [ ] Free users see uncolored (default blue) arcs
- [ ] PRO user clicking arc over disrupted chokepoint → mini popup shown
- [ ] `trackGateHit('trade-arc-intel')` fires when free user clicks arc

### Sprint C

- [x] `POST /api/scenario/v1/run` (PRO) → HTTP 202 with `jobId` _(PR #2890)_
- [x] Worker processes job within 30s _(pipeline: ~300ms for targeted scenarios)_
- [x] `GET /api/scenario/v1/status?jobId=X` returns `{ status: 'done', result }` after completion _(PR #2890)_
- [x] `MapContainer.activateScenario()` triggers visual changes on DeckGL renderer _(arc orange recolor for physical chokepoint scenarios)_
- [ ] Panel shows scenario summary card with dismiss button — **deferred to Sprint A**
- [ ] Free user activating scenario → no visual change, gate fires — **deferred to Sprint A**
- [ ] Tariff-shock + globe/SVG choropleth visual — **deferred to Sprint D**

### Sprint D

- [ ] `GetSectorDependency` for Japan HS85 returns `SINGLE_CORRIDOR_CRITICAL`
- [ ] `GET /api/v2/shipping/route-intelligence` without key → HTTP 401
- [ ] Webhook `callbackUrl: 169.254.169.254` rejected with HTTP 400

---

## Quality Gates

- [ ] `npm run typecheck` + `npm run typecheck:api` pass with zero errors
- [ ] `npm run test:data` passes for any new RPC
- [ ] `npm run lint` (Biome) passes
- [ ] No `console.error` in browser for normal operation
- [ ] All new PRO gates have corresponding `trackGateHit` call
- [ ] `scripts/shared/country-port-clusters.json` validated: 195+ entries, valid `coastSide` enum

---

## Dependencies

- `scripts/shared/country-port-clusters.json` (A1) must exist before `seed-hs2-chokepoint-exposure.mjs` can run correctly in production (currently uses fallback empty array)
- Sprint B arc coloring depends on `tradeRouteSegments` having `waypointChokepointIds` populated — verify this field exists in the segment type
- Sprint C `BLMOVE` depends on Upstash Redis supporting Redis 6.2+ commands — test before deploying worker
- Sprint D proto changes require `make generate` to regenerate TypeScript types before any handler code compiles

---

## Post-Deploy Monitoring & Validation

- **Log queries**: `[scenario-worker]` prefix in Railway logs; `trackGateHit` events in analytics
- **Redis**: check `LLEN scenario-queue:pending` and `LLEN scenario-queue:processing` — both should stay near 0 in steady state
- **Health**: `api/health.js` already monitors `seed-meta:supply_chain:chokepoint-exposure`; add `seed-meta:supply_chain:sector-dep` for D1
- **Validation window**: Deploy Sprint A first (pure UI, no new RPCs) → monitor for JS errors → deploy Sprints B/C/D sequentially with 48h observation each
- **Failure signal**: Scenario processing queue grows without shrinking → worker crashed; restart Railway worker service

---

## Sources & References

### Origin

- **Origin document**: `docs/brainstorms/2026-04-09-worldwide-shipping-intelligence-requirements.md` — Key decisions carried forward: (1) HS2 granularity for v1, not HS6; (2) All new analytics PRO-only; (3) Async Railway worker for scenario engine

### Full Roadmap

- `docs/internal/worldmonitor-global-shipping-intelligence-roadmap.md` — complete 5-sprint roadmap with all technical specs

### Existing Implementations (Backend — All Done)

- `server/worldmonitor/supply-chain/v1/get-bypass-options.ts` — PRO-gated bypass scoring
- `server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts` — energy shock RPC
- `server/worldmonitor/supply-chain/v1/get-country-chokepoint-index.ts` — exposure index RPC
- `scripts/seed-hs2-chokepoint-exposure.mjs` — Redis seeder (needs `country-port-clusters.json`)
- `src/config/bypass-corridors.ts` — 40 corridors for 13 chokepoints
- `src/config/chokepoint-registry.ts` — canonical 13-ID registry

### UI Pattern References

- `src/components/SupplyChainPanel.ts:134-158` — MutationObserver + TransitChart mount pattern
- `src/components/CountryDeepDivePanel.ts:1550-1562` — `sectionCard()` helper
- `src/components/MapPopup.ts:267-281` — PRO-gated TransitChart mount
- `src/components/DeckGLMap.ts:4959-4979` — `createTradeRoutesLayer()` arc coloring
- `src/app/event-handlers.ts:1027-1032` — `applyProGate` + `subscribeAuthState` pattern
- `src/services/supply-chain/index.ts:111-151` — existing RPC client calls

### Related PRs

- PR #2805 — PortWatch maritime activity (PR C — all done)
- PR #2841 — chokepoint popup TransitChart post-render mount pattern
- PR #2890 — Sprint C: scenario engine (templates, job API, Railway worker, DeckGL activation) — **ready to merge**
