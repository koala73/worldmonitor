# Sprint 2 — Intel Brief Panel Specification

## Overview

A persistent dashboard panel that synthesizes all live threat signals into a structured, AI-powered intelligence assessment. Three domain cards (Security, Economics, Infrastructure) with expandable AI-narrative analysis, a global threat score (0–100), and a 5-layer resilience stack ensuring the panel **always shows useful content** — even with no internet, no API keys, and no Ollama.

This is a survival-grade intelligence feature: it must be operational under the conditions it is most needed.

---

## Panel Identity

- **Panel key:** `intel-brief`
- **Panel name:** `Intel Brief`
- **Category:** `intelligence` (existing PANEL_CATEGORY_MAP key)
- **Default enabled:** `true`, priority `1`
- **Variant:** `full` only
- **Priority lists:** `WAR_PRIORITY` (after `'comms-health'`), `DISASTER_PRIORITY` (after `'comms-health'`)

---

## Visual Design

### Layout (approved Option 1 + score bar)

```
┌─────────────────────────────────────────────────────┐
│ ⚔ WAR MODE · Intel Brief          4 min ago  ↻      │
├─────────────────────────────────────────────────────┤
│  78  Global Threat Score   ████████░░░░  HIGH        │
├──────────────┬──────────────┬──────────────────────  │
│  SECURITY    │  ECONOMICS   │  INFRASTRUCTURE        │
│  CRITICAL    │  ELEVATED    │  NORMAL                │
│  14 hijacks  │  Stress 71   │  BGP degraded          │
│  ▲ collapse  │  ▼ expand    │  ▼ expand              │
├─────────────────────────────────────────────────────┤
│ SECURITY ANALYSIS ▲                                  │
│ Military pre-positioning in 3 theaters combined      │
│ with 14 BGP hijacks indicates coordinated infra      │
│ disruption ahead of kinetic action. Recommend        │
│ elevated cyber posture.▌                             │
├─────────────────────────────────────────────────────┤
│ ● Ollama · llama3.1:8b              Generated 4m ago │
└─────────────────────────────────────────────────────┘
```

### Domain Card States

Each of the three domain cards has:
- **Label** (small caps): Security / Economics / Infrastructure
- **Severity badge**: CRITICAL (red) / ELEVATED (amber) / NORMAL (green) / UNKNOWN (slate)
- **Headline** (1 line): short summary from AI or rule-based engine
- **Expand toggle**: ▼ expand / ▲ collapse

Only one domain may be expanded at a time. Expanded state shows the `analysis` field (2–3 sentences) with a CSS typewriter reveal animation (no real streaming needed).

### Global Threat Score Bar

- Integer 0–100, always computed locally (never from AI)
- Color thresholds: < 40 green, 40–69 amber, ≥ 70 red
- Bar is a CSS gradient (green → amber → red) with a marker needle at the score position
- Displayed as: `[score]  [label bar]  [severity text]`

### AI Source Indicator (panel footer)

Always visible. One of:
- `● Ollama · {model}` — blue dot
- `● Groq · llama3-70b` — purple dot
- `● OpenRouter` — purple dot
- `◌ Rule-based` — green dot (hollow)
- `◌ Cached · {N} min ago` — slate dot (hollow)

When source is `'cache'`, the panel also shows a secondary line: `"Refreshing…"` while background generation is in progress, or `"Data {N}m old"` once generation completes.

---

## Data Model

### IntelBriefSnapshot (input to AI + rule engine)

```typescript
export interface IntelBriefSnapshot {
  mode: AppMode;
  security: {
    militaryFlightClusters: number;  // from intelligenceCache.military?.flightClusters.length
    protestEvents: number;           // from intelligenceCache.protests?.events.length
    orefAlertCount: number;          // from intelligenceCache.orefAlerts?.alertCount
    advisoryCount: number;           // from intelligenceCache.advisories?.length
    bgpHijacks: number;              // from CommsHealthData.bgp.hijacks
    bgpLeaks: number;                // from CommsHealthData.bgp.leaks
    commsOverall: 'normal' | 'warning' | 'critical' | 'unknown';
  };
  economics: {
    stressIndex: number;             // from EconomicStressData.stressIndex (0–100)
    stressTrend: 'rising' | 'stable' | 'falling';
    yieldCurveSeverity: string;      // e.g. 'INVERTED'
    vixSeverity: string;             // e.g. 'ELEVATED'
    foodSecuritySeverity: string;    // e.g. 'warning'
    fredKeyMissing: boolean;
  };
  infrastructure: {
    commsOverall: 'normal' | 'warning' | 'critical' | 'unknown';
    bgpSeverity: 'normal' | 'warning' | 'critical';
    ixpStatus: 'normal' | 'warning' | 'critical';
    degradedCables: string[];
    internetOutages: number;         // from intelligenceCache.outages?.length
  };
  dataAgeMs: {
    security: number;   // ms since last fetch; 0 = unknown
    economics: number;
    infrastructure: number;
  };
}
```

### IntelBriefResult (panel display state)

```typescript
export type BriefSeverity = 'normal' | 'warning' | 'critical' | 'unknown';
export type BriefSource = 'ollama' | 'groq' | 'openrouter' | 'rules' | 'cache';
// Note: 't5' is intentionally excluded — browser T5 is deferred to a future sprint.

export interface IntelBriefDomain {
  severity: BriefSeverity;
  headline: string;   // ≤ 10 words shown on collapsed card
  analysis: string;   // 2–3 sentences shown when expanded
}

export interface IntelBriefResult {
  globalScore: number;              // 0–100, always computed locally
  security: IntelBriefDomain;
  economics: IntelBriefDomain;
  infrastructure: IntelBriefDomain;
  generatedAt: string;              // ISO timestamp
  source: BriefSource;
  sourceModel?: string;             // e.g. 'llama3.1:8b'
  mode: AppMode;
  snapshotAgeMs?: number;           // worst-case data age at generation time
}
```

### LocalStorage Persistence

- **Key:** `worldmonitor-intel-brief-cache`
- **Value:** `{ result: IntelBriefResult, savedAt: number }`
- Load on panel init → show immediately as source `'cache'`
- Overwrite after each successful generation

---

## Global Threat Score Formula

Computed **client-side only** — never from AI output (prevents hallucinated scores).

```
securityScore (0–100):
  bgpScore     = clamp(bgpHijacks / 20 * 100, 0, 100)           × 0.35
  militaryScore = clamp(militaryFlightClusters / 5 * 100, 0, 100) × 0.40
  unrestScore  = clamp(protestEvents / 50 * 100, 0, 100)         × 0.25

economicsScore = stressIndex  (already 0–100)

infraScore (0–100):
  commsMap  = { normal: 0, warning: 50, critical: 100, unknown: 25 }[commsOverall]
  outageMap = clamp(internetOutages / 10 * 100, 0, 100)
  infraScore = commsMap × 0.7 + outageMap × 0.3

globalScore = round(securityScore × 0.40 + economicsScore × 0.35 + infraScore × 0.25)
```

---

## 5-Layer Resilience Stack

Layers are attempted in order. The panel renders Layer 5 (cache) immediately on load if present, otherwise Layer 4 (rule-based) synchronously — then upgrades silently when a higher layer succeeds.

| Layer | Source | Requires | Offline? | Panel indicator |
|---|---|---|---|---|
| 1 | Ollama (local LLM) | Ollama running | ✅ Yes | `● Ollama · {model}` |
| 2 | Groq API | GROQ_API_KEY + internet | ❌ No | `● Groq · llama3-70b` |
| 3 | OpenRouter API | OPENROUTER_API_KEY + internet | ❌ No | `● OpenRouter` |
| 4 | Rule-based synthesis | **Nothing** | ✅ Yes | `◌ Rule-based` |
| 5 | localStorage cache | Nothing | ✅ Yes | `◌ Cached · Xm ago` |

> **Note:** Browser T5 (client-side bundled model) is architecturally supported but **deferred** — `summarization.ts` uses it for plain text, but wiring it for structured JSON domain output requires additional work outside Sprint 2 scope. Layer 4 rule-based synthesis provides equivalent offline coverage with zero dependencies.

**Layer 4 always succeeds.** It is the floor — if layers 1–3 all fail or are unavailable, rule-based synthesis generates a complete brief from threshold logic alone.

**Show-immediately pattern:** On panel init, render Layer 5 (cache) at once if it exists; otherwise render Layer 4 (rule-based) synchronously from `buildEmptySnapshot(mode)`. Initiate Layer 1–3 AI attempt in the background. On completion, replace panel content via `getContentElement().innerHTML`. No loading spinner blocks the panel.

---

## Rule-Based Synthesis Engine (`src/services/intel-brief-rules.ts`)

A pure function with no async operations, no imports from external services.

### Security domain rules

```
if militaryFlightClusters >= 3 AND bgpHijacks >= 10:
  severity: 'critical'
  headline: "{N} theaters active, {N} BGP hijacks"
  analysis: "Military flight clusters active across {N} theaters with {N} BGP hijack events indicating potential coordinated infrastructure disruption. {commsOverall === 'critical' ? 'Communications networks severely degraded.' : 'Recommend elevated cyber posture.'}"

else if militaryFlightClusters >= 1 OR bgpHijacks >= 5:
  severity: 'warning'
  headline: "Elevated military and network activity"
  analysis: "{militaryFlightClusters > 0 ? N + ' military flight cluster(s) active.' : ''} {bgpHijacks > 0 ? N + ' BGP anomalies detected.' : ''} Monitor for escalation."

else if orefAlertCount >= 5:
  severity: 'warning'
  headline: "{N} active sirens"
  analysis: "Active alert sirens in {N} zones. Potential kinetic activity."

else:
  severity: 'normal'
  headline: "No significant security anomalies"
  analysis: "Security indicators within normal parameters. No major military or network disruptions detected."
```

### Economics domain rules

```
if fredKeyMissing:
  severity: 'unknown'
  headline: "FRED key required"
  analysis: "Economic stress data unavailable. Add FRED_API_KEY in Settings → API Keys to enable economic monitoring."

else if stressIndex >= 85:
  severity: 'critical'
  headline: "Economic stress critical — {stressIndex}/100"
  analysis: "Economic stress index at {stressIndex}/100. Yield curve {yieldCurveSeverity}, VIX {vixSeverity}. Financial system under severe strain. Potential systemic risk."

else if stressIndex >= 70:
  severity: 'warning'
  headline: "Economic stress elevated — {stressIndex}/100"
  analysis: "Economic stress index at {stressIndex}/100 and {trend}. Key indicators: yield curve {yieldCurveSeverity}, financial stress index elevated. Monitor for continued deterioration."

else:
  severity: 'normal'
  headline: "Economic indicators stable — {stressIndex}/100"
  analysis: "Economic stress index at {stressIndex}/100. Markets functioning normally. {foodSecuritySeverity !== 'normal' ? 'Note: global food security showing pressure.' : ''}"
```

### Infrastructure domain rules

```
if commsOverall === 'critical':
  severity: 'critical'
  headline: "Critical infrastructure disruption"
  analysis: "{degradedCables.length > 0 ? degradedCables.join(', ') + ' submarine cable(s) degraded.' : ''} BGP routing {bgpSeverity}. {internetOutages > 0 ? N + ' internet outages active.' : ''} Critical communications impact."

else if commsOverall === 'warning' OR internetOutages >= 3:
  severity: 'warning'
  headline: "Infrastructure degradation detected"
  analysis: "Communications network degraded. BGP {bgpSeverity}, IXP {ixpStatus}. {internetOutages > 0 ? N + ' internet outages.' : 'No major outages.'}"

else:
  severity: 'normal'
  headline: "Infrastructure operating normally"
  analysis: "Communications and internet infrastructure within normal parameters. No significant disruptions detected."
```

---

## Sidecar Endpoint — `POST /api/intel-brief`

Request body:
```json
{ "snapshot": { /* IntelBriefSnapshot */ } }
```

Response (success — AI generated):
```json
{
  "security":       { "severity": "critical", "headline": "...", "analysis": "..." },
  "economics":      { "severity": "warning",  "headline": "...", "analysis": "..." },
  "infrastructure": { "severity": "normal",   "headline": "...", "analysis": "..." },
  "source": "ollama",
  "sourceModel": "llama3.1:8b"
}
```

Response (AI unavailable):
```json
{ "aiAvailable": false }
```

### AI prompt template

```
You are a senior intelligence analyst giving a classified briefing. Current threat posture: {MODE}.

SIGNALS SNAPSHOT:
Security:       {N} military clusters | {N} protest events | {N} BGP hijacks | {N} advisories
Economics:      Stress {N}/100 ({trend}) | Yield {yieldLabel} | VIX {vixLabel} | Food security {fsLabel}
Infrastructure: Comms {overall} | {N} cables degraded | IXP {ixpStatus} | {N} internet outages

Respond with ONLY valid JSON — no prose, no markdown:
{
  "security":       { "severity": "normal|warning|critical", "headline": "<10 words>", "analysis": "<2-3 sentences>" },
  "economics":      { "severity": "normal|warning|critical", "headline": "<10 words>", "analysis": "<2-3 sentences>" },
  "infrastructure": { "severity": "normal|warning|critical", "headline": "<10 words>", "analysis": "<2-3 sentences>" }
}
```

### Provider chain with hard timeouts

1. `OLLAMA_API_URL` set → POST `/v1/chat/completions`, **10s hard timeout**
2. `GROQ_API_KEY` set → POST Groq API, **10s hard timeout**
3. `OPENROUTER_API_KEY` set → POST OpenRouter, **15s hard timeout**
4. All unavailable → return `{ aiAvailable: false }`

T5 (Browser layer, deferred) is not in scope for Sprint 2. The sidecar returns `{ aiAvailable: false }` when all providers are unavailable; the client falls back to rule-based synthesis.

JSON parse failure from any provider → treat as unavailable, try next provider.

---

## Refresh Schedule and Triggers

| Trigger | Interval / Action |
|---|---|
| App startup | Show cache (or rule-based) immediately, then generate in background |
| `wm:mode-changed` | Immediate re-generation via panel's mode-change listener |
| All modes | 15 min base interval via RefreshScheduler |
| Ghost Mode | RefreshScheduler auto-applies 5× multiplier (→ 75 min) |
| Hidden tab | RefreshScheduler auto-applies 10× multiplier (→ 150 min) |
| Manual ↻ | Immediate re-generation |

> **Note on War/Disaster urgency:** The `wm:mode-changed` listener fires `_generate()` immediately on every mode transition, providing instant re-analysis when conditions escalate. A separate 5-minute war/disaster scheduler interval is therefore unnecessary — the 15-minute base interval plus immediate mode-triggered regeneration is sufficient.

Registered in `App.ts`:
```typescript
this.refreshScheduler.scheduleRefresh(
  'intelBrief',
  () => this.dataLoader.loadIntelBrief(),
  15 * 60 * 1000,
  () => SITE_VARIANT === 'full'
);
```

Mode-change listener in `IntelBriefPanel` constructor:
```typescript
document.addEventListener('wm:mode-changed', () => void this._generate());
```

**Event listener lifecycle:** World Monitor panels are instantiated once at startup and never destroyed. The listener registered in the constructor persists for the lifetime of the application. This is consistent with how other panels (e.g. `EconomicStressPanel`) handle mode-change events and does not constitute a memory leak.

Disaster/War mode fast refresh: the panel calls `_generate()` directly on `wm:mode-changed`. The scheduler continues at its base interval; no separate 5-min scheduler needed.

---

## Cold-Start Behavior (No Cache)

On first launch (no `worldmonitor-intel-brief-cache` in localStorage), the panel must not be blank. Behavior:

```typescript
// In IntelBriefPanel constructor (or init()):
const cached = loadIntelBriefCache();
if (cached) {
  this._render(cached, 'cache');
} else {
  // Cold start — render rule-based from empty snapshot synchronously
  const emptySnap = buildEmptySnapshot(getMode());
  const initial = generateRuleBasedBrief(emptySnap);
  initial.globalScore = computeGlobalScore(emptySnap);
  this._render(initial, 'rules');
}
// Background AI generation proceeds regardless
void this._generate();
```

`buildEmptySnapshot(mode)` returns an `IntelBriefSnapshot` with all numeric fields set to `0`, all severities `'unknown'`, arrays empty. Rule-based synthesis on an empty snapshot always returns `'normal'`/`'unknown'` domain results with "Awaiting data" headlines — a valid low-severity brief that upgrades as data loads.

---

## Data Staleness Tracking

`IntelligenceCache` has no timestamps. `IntelBriefPanel` maintains its own:

```typescript
private _dataFetchTimes: { security: number; economics: number; infrastructure: number } = {
  security: 0, economics: 0, infrastructure: 0
};
```

Updated whenever `updateSnapshot()` is called with new data from each source. Displayed in panel footer as "Data Xm old" when any domain age exceeds 30 minutes.

---

## Data Flow — How buildSnapshot() Accesses Service Data

`data-loader.ts` currently pushes fetched data directly to each panel's `update()` method and discards it. `buildSnapshot()` needs access to the last-fetched `CommsHealthData` and `EconomicStressData`.

**Solution:** Add module-level last-result variables to each service file, updated by `data-loader.ts` after every successful fetch:

```typescript
// In src/services/comms-health.ts — add:
let _lastCommsHealth: CommsHealthData | null = null;
export function setLastCommsHealth(data: CommsHealthData): void { _lastCommsHealth = data; }
export function getLastCommsHealth(): CommsHealthData | null { return _lastCommsHealth; }

// In src/services/economic-stress.ts — add:
let _lastEconomicStress: EconomicStressData | null = null;
export function setLastEconomicStress(data: EconomicStressData): void { _lastEconomicStress = data; }
export function getLastEconomicStress(): EconomicStressData | null { return _lastEconomicStress; }
```

`data-loader.ts` `loadCommsHealth()`:
```typescript
async loadCommsHealth(): Promise<void> {
  try {
    const data = await fetchCommsHealth();
    setLastCommsHealth(data);               // <-- store for buildSnapshot()
    (this.ctx.panels['comms-health'] as CommsHealthPanel)?.update(data);
  } catch { (this.ctx.panels['comms-health'] as CommsHealthPanel)?.update(null); }
}
```

Same pattern for `loadEconomicStress()`.

`buildSnapshot()` in `intel-brief.ts` reads these via `getLastCommsHealth()` / `getLastEconomicStress()`, defaulting to null-safe zero values when either is not yet loaded.

---

## loadIntelBrief() Call Sequence

Complete sequence executed by `data-loader.ts`:

```typescript
async loadIntelBrief(): Promise<void> {
  // 1. Build snapshot from all available data sources
  //    Add `getMode` to the existing mode-manager import in data-loader.ts:
  //    import { evaluateWarThreat, ..., getMode } from '@/services/mode-manager';
  const snapshot = buildSnapshot(this.ctx.intelligenceCache, getMode());

  // 2. Attempt AI generation via sidecar (Ollama → Groq → OpenRouter)
  let result: IntelBriefResult | null = null;
  try {
    result = await fetchIntelBrief(snapshot);   // POST /api/intel-brief; returns null if all AI unavailable
  } catch { /* sidecar unreachable — fall through */ }

  // 3. Fall back to rule-based synthesis if AI unavailable
  if (!result) {
    result = generateRuleBasedBrief(snapshot);  // always succeeds
  }

  // 4. Compute global score client-side, attach to result
  result.globalScore = computeGlobalScore(snapshot);

  // 5. Push to panel — matches the accessor pattern used throughout data-loader.ts
  (this.ctx.panels['intel-brief'] as IntelBriefPanel)?.update(result);

  // 6. Persist to localStorage
  saveIntelBriefCache(result);
}

// Required imports added to data-loader.ts:
//   import { getMode } from '@/services/mode-manager';  (already present in data-loader.ts)
//   import { buildSnapshot, fetchIntelBrief, computeGlobalScore, saveIntelBriefCache } from '@/services/intel-brief';
//   import { generateRuleBasedBrief } from '@/services/intel-brief-rules';
//   import type { IntelBriefPanel } from '@/components/IntelBriefPanel';
```

`fetchIntelBrief()` returns `null` when the sidecar responds `{ aiAvailable: false }` or on network error.

---

## New Files

| File | Responsibility |
|---|---|
| `src/services/intel-brief.ts` | Types + `buildSnapshot()` + `fetchIntelBrief()` + `computeGlobalScore()` + `saveIntelBriefCache()` / `loadIntelBriefCache()` |
| `src/services/intel-brief-rules.ts` | Pure rule-based synthesis — `generateRuleBasedBrief(snapshot): IntelBriefResult` + `buildEmptySnapshot(mode): IntelBriefSnapshot` |
| `src/components/IntelBriefPanel.ts` | Panel component — renders score bar, domain cards, expand/collapse, source indicator |

## Modified Files

| File | Changes |
|---|---|
| `src-tauri/sidecar/local-api-server.mjs` | Add `POST /api/intel-brief` with 3-provider AI chain |
| `src/services/comms-health.ts` | Add `_lastCommsHealth`, `setLastCommsHealth()`, `getLastCommsHealth()` |
| `src/services/economic-stress.ts` | Add `_lastEconomicStress`, `setLastEconomicStress()`, `getLastEconomicStress()` |
| `src/config/panels.ts` | Add `'intel-brief'` to `FULL_PANELS`; add `'intel-brief'` to `PANEL_CATEGORY_MAP['intelligence'].panelKeys` array |
| `src/app/panel-layout.ts` | Import, WAR_PRIORITY, DISASTER_PRIORITY, `_createPanels()` |
| `src/app/data-loader.ts` | Call `setLastCommsHealth`/`setLastEconomicStress` in load methods; add `loadIntelBrief()` |
| `src/App.ts` | `scheduleRefresh('intelBrief', ...)` |

---

## Acceptance Criteria

- [ ] Panel renders immediately on app load (shows cache or rule-based — never blank)
- [ ] Global threat score is computed client-side and never taken from AI output
- [ ] Three domain cards visible at all times; exactly one may be expanded
- [ ] Expanded card shows AI analysis with CSS typewriter reveal animation
- [ ] AI source indicator in footer shows which layer generated the brief
- [ ] With Ollama running: brief generated via Ollama with model name shown
- [ ] With no Ollama, no API keys: rule-based brief generated (green `◌ Rule-based` indicator)
- [ ] With all services down AND no cache: rule-based brief still renders
- [ ] `wm:mode-changed` → immediate brief regeneration
- [ ] localStorage cache survives app restart; shown on next load with "Xm ago" timestamp
- [ ] Data staleness warning shown when any domain data > 30 min old
- [ ] `npm run typecheck:all` zero errors
- [ ] SUPPORTED_SECRET_KEYS count unchanged (25) — no new keys added
