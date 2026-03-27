---
title: feat: Intelligence Analytical Frameworks
type: feat
status: completed
date: 2026-03-27
origin: docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md
---

# feat: Intelligence Analytical Frameworks

## Overview

Add a per-panel analytical framework selector to AI intelligence panels. Premium users can pick a structured analytical lens (Ray Dalio, Buffett, Geopolitical Equilibrium, etc.) that reshapes how that panel's LLM analysis is framed. The framework's instructions are injected into the server-side system prompt for that panel's LLM call. Built-in curated library + import from agentskills.io. Auto re-runs analysis on switch. Persists per-panel in localStorage.

See origin: `docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md`

---

## Problem Statement

WorldMonitor's AI intelligence panels (InsightsPanel/WorldBrief, CountryDeepDivePanel, DailyMarketBriefPanel, DeductionPanel) generate analysis through a fixed neutral LLM system prompt. There is no mechanism for users to apply structured analytical lenses — e.g. Ray Dalio's macroeconomic cycle model, Buffett's risk framework, adversarial geopolitical equilibrium models. Every user gets identical neutral framing regardless of their decision-making context.

This is a premium differentiation gap. Analytical frameworks are a high-value, low-carrying-cost feature that increases time-on-site for sophisticated users and justifies Pro upgrade.

---

## Proposed Solution

1. A new **analysis framework store** (`src/services/analysis-framework-store.ts`) manages the library of built-in and user-imported frameworks, and per-panel active selection.
2. Each supported panel renders a **framework selector** in its header toolbar. Premium-gated: locked + upgrade CTA for free users.
3. On framework switch, the panel cancels any in-flight LLM call and immediately re-triggers analysis with the selected framework.
4. The framework's `systemPromptAppend` string is passed to the relevant server RPC handler as an additional field. Each handler appends it to its system prompt. The cache key is extended to include a hash of the framework instructions.
5. A new **Settings section** ("Analysis Frameworks") lists the skill library and hosts the import flow (agentskills.io URL/ID or paste). A Vercel edge proxy route handles the agentskills.io fetch (browser-direct is blocked by CORS).

---

## Technical Approach

### Architecture Decisions

**Framework injection is server-side, not client-side.**
The framework must be injected into the server-side system prompt to ensure the LLM output is actually shaped by it. Client-side injection via `geoContext` lands in the *user* prompt, which is lower-priority than the system prompt and more easily ignored by the LLM. Server-side injection is correct for quality, but requires two additions: (a) cache key update and (b) a framework instructions length cap to avoid context window overflow. (see origin: Key Decisions)

**Per-panel selection, not global.**
Different panels serve different contexts (macro events vs. country risk vs. market). A single global lens is too blunt. (see origin: Key Decisions)

**Premium-only; auto re-run on switch.**
(see origin: Key Decisions)

**agentskills.io import: instructions field only (phase 1).**
The `tools` array in agentskills.io skills requires server-side function execution — out of scope for phase 1. Only `instructions` is extracted. (see origin: Scope Boundaries)

---

### Implementation Phases

#### Phase 1: Foundation — Framework Store + Types

**New file: `src/services/analysis-framework-store.ts`**

Modelled on `src/services/mcp-store.ts`. Provides:

- `AnalysisFramework` interface: `id, name, description, systemPromptAppend, isBuiltIn, createdAt`
- `BUILT_IN_FRAMEWORKS: AnalysisFramework[]` — 5 initial presets (see Acceptance Criteria for list)
- `loadFrameworkLibrary()` — returns built-in presets + user-imported from localStorage key `wm-analysis-frameworks`
- `saveImportedFramework(fw)` — persists to localStorage; max 20 imported frameworks
- `deleteImportedFramework(id)` — removes by ID; cannot delete built-ins
- `renameImportedFramework(id, name)` — updates display name
- `getActiveFrameworkForPanel(panelId: AnalysisPanelId)` — reads from localStorage key `wm-panel-frameworks`
- `setActiveFrameworkForPanel(panelId, frameworkId | null)` — writes; null = Default (Neutral)
- `subscribeFrameworkChange(panelId, cb)` — registers a `window` event listener for `wm-framework-changed`; calls `cb` when `event.detail.panelId === panelId`; returns an unsubscribe function. Event dispatched as `window.dispatchEvent(new CustomEvent('wm-framework-changed', { detail: { panelId, frameworkId } }))`, matching the project's `wm-*` event pattern (see `market-watchlist.ts`).
- Premium gate: `getActiveFrameworkForPanel` returns `null` if `!hasPremiumAccess()`

**New type: `AnalysisPanelId`**

```ts
export type AnalysisPanelId =
  | 'insights'          // InsightsPanel (WorldBrief)
  | 'country-brief'     // CountryDeepDivePanel
  | 'daily-market-brief'  // DailyMarketBriefPanel
  | 'deduction';        // DeductionPanel
```

**Framework instruction length cap:** Max 2000 characters at save time. Enforced in `saveImportedFramework()`. Show a visible character counter and error in the import UI.

---

#### Phase 2: Server Handler Extensions

**File: `server/_shared/llm.ts`**

Add `systemAppend?: string` to `LlmCallOptions`. In `callLlm()`, if `systemAppend` is provided and the first message is `role: 'system'`, append `\n\n---\n\n${systemAppend}` to its content before sending. This is the lowest-level injection point and handles all three handlers automatically.

**Proto workflow for `GetCountryIntelBriefRequest`**

Add `framework` field to the proto definition, then regenerate:

```proto
// proto/worldmonitor/intelligence/v1/get_country_intel_brief.proto
message GetCountryIntelBriefRequest {
  string country_code = 1 [
    (buf.validate.field).required = true,
    (buf.validate.field).string.len = 2,
    (buf.validate.field).string.pattern = "^[A-Z]{2}$",
    (sebuf.http.query) = {name: "country_code"}
  ];
  // Optional analytical framework instructions to append to system prompt.
  // Max 2000 chars enforced at the handler level.
  string framework = 2 [(sebuf.http.query) = {name: "framework"}];
}
```

Then run `make generate` to regenerate `src/generated/`. The handler in `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts` gains the typed field automatically.

**File: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`**

- Read `req.framework` (empty string = default).
- Pass as `systemAppend` to `callLlm()`.
- **Cache key update**: current key is `ci-sebuf:v2:${countryCode}:${lang}:${contextHash}`. Extend to:

```ts
// frameworkHash must use the ASYNC sha256Hex from server/_shared/hash.ts
import { sha256Hex } from '../../_shared/hash.ts';

const frameworkHash = req.framework
  ? (await sha256Hex(req.framework)).slice(0, 8)
  : '';
const cacheKey = `ci-sebuf:v2:${countryCode}:${lang}:${contextHash}:${frameworkHash}`;
```

`sha256Hex` is async (Web Crypto). `hashString` (FNV-1a, sync) is only for non-crypto client-side use — do not use it here.

**Proto workflow for `DeductSituationRequest`**

```proto
// proto/worldmonitor/intelligence/v1/deduct_situation.proto
message DeductSituationRequest {
  string query = 1;
  string geo_context = 2;
  // Optional analytical framework instructions.
  string framework = 3;
}
```

Run `make generate`. The handler in `deduct-situation.ts` reads `req.framework` and passes it as `systemAppend` to `callLlm()`. No cache key change needed (DeductionPanel results are not cached).

**File: `server/worldmonitor/news/v1/_shared.ts` (`buildArticlePrompts`)**

- Add `frameworkAppend?: string` to the opts object.
- Pass through to the `callLlm` call in `summarize-article.ts` via a new `systemAppend` field on the RPC request.

**File: `server/worldmonitor/news/v1/summarize-article.ts`**

- Thread `systemAppend` from RPC request down to `callLlm()`.

**New Vercel edge route: `api/skills/fetch-agentskills.ts`** (bare edge function — no proto, no gateway)

Pattern: same as `api/widget-agent.ts` (not routed through sebuf/gateway). Export `config = { runtime: 'edge' }` and a default handler function.

```ts
// api/skills/fetch-agentskills.ts
export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') { /* CORS preflight */ }
  const { url, id } = await req.json();
  // Validate domain: must be agentskills.io
  // Fetch skill, extract instructions field
  // Enforce 2000-char cap (truncate + warning flag)
  // Rate-limit: 10 fetches/hour per CF-Connecting-IP
  return Response.json({ name, description, instructions, truncated });
}
```

Register the route in `vercel.json` rewrites: `{ "source": "/api/skills/:path*", "destination": "/api/skills/:path*" }` (auto-resolved by Vercel file-based routing — no manual rewrite needed for `api/` files).

---

#### Phase 3: Client Panel Wiring

**`src/components/InsightsPanel.ts`**

InsightsPanel uses a **generation counter** for cancellation (not AbortController). The class declares `private updateGeneration = 0`. On each new analysis request, the counter is incremented and the current value captured; async steps return early if `this.updateGeneration !== thisGeneration`.

- `updateFromClient()` (client-side fallback path, line ~446): before calling `generateSummary()`, increment `this.updateGeneration`, capture `const gen = this.updateGeneration`. Read `getActiveFrameworkForPanel('insights')`; if non-null, append framework `systemPromptAppend` to the `geoContext` string. After each await, guard with `if (this.updateGeneration !== gen) return`.
- Subscribe to framework changes in the constructor: `subscribeFrameworkChange('insights', () => { this.updateGeneration++; this.reAnalyze(); })`.
- Note: The server-path (`updateFromServer()`) uses pre-computed briefs and cannot accept per-user framework injection in phase 1 — the framework only shapes the *client-side* fallback path for InsightsPanel.

> ⚠️ **InsightsPanel caveat (phase 1 scope):** The primary server path for InsightsPanel generates a shared pre-computed WorldBrief (Redis-cached across all users). Per-user framework injection cannot apply to this path without a significant architecture change. In phase 1, frameworks apply only when InsightsPanel falls back to client-side generation. The selector label reads "(applies to client-generated analysis only)". This is a documented limitation, not a bug.

**`src/components/CountryDeepDivePanel.ts`**

- In the `getCountryIntelBrief` RPC call, read `getActiveFrameworkForPanel('country-brief')` and pass `framework: fw?.systemPromptAppend` in the request.
- Subscribe to `subscribeFrameworkChange('country-brief', () => this.refresh())` in the constructor; unsubscribe in `destroy()`.

**`src/services/daily-market-brief.ts` / `src/components/DailyMarketBriefPanel.ts`**

`buildDailyMarketBrief` is called from `src/app/data-loader.ts:1420`. `DailyMarketBriefPanel` has no cancellation mechanism. Use the same **generation counter** pattern as InsightsPanel.

**Exact signature changes:**

```ts
// BuildDailyMarketBriefOptions (daily-market-brief.ts:63)
export interface BuildDailyMarketBriefOptions {
  markets: MarketData[];
  newsByCategory: Record<string, NewsItem[]>;
  timezone?: string;
  now?: Date;
  targets?: MarketWatchlistEntry[];
  regimeContext?: RegimeMacroContext;
  yieldCurveContext?: YieldCurveContext;
  sectorContext?: SectorBriefContext;
  frameworkAppend?: string;                 // NEW — appended to geoContext passed to summarize()
  summarize?: (
    headlines: string[],
    onProgress?: undefined,
    geoContext?: string,
    lang?: string,
  ) => Promise<SummarizationResult | null>;
}
```

`SummarizeOptions` (in `summarization.ts`) does not need changes — `frameworkAppend` is threaded via the `geoContext` string parameter of `generateSummary()`, not via a new options field. Append `\n\n---\nAnalytical Framework:\n${frameworkAppend}` to `geoContext` inside `buildDailyMarketBrief()` before passing to `summarize()`.

**Cancellation in `data-loader.ts`**: add a `dailyBriefGeneration` counter on the DataLoader class. Increment before calling `buildDailyMarketBrief()`. After the call resolves, check counter before calling `panel.renderBrief()`.

**Subscription**: in `DailyMarketBriefPanel`, subscribe to `subscribeFrameworkChange('daily-market-brief', () => this.requestRefresh())` where `requestRefresh()` dispatches to data-loader's existing refresh flow.

**`src/components/DeductionPanel.ts`**

- In `handleSubmit()`, read `getActiveFrameworkForPanel('deduction')`; if active, append framework `systemPromptAppend` to the `geoContext` string before the RPC call.
- No subscription needed (user manually submits each query).

---

#### Phase 4: Framework Selector UI Component

**New file: `src/components/FrameworkSelector.ts`**

A lightweight self-contained component that renders a `<select>` element for the framework selector. Used by each panel.

```ts
interface FrameworkSelectorOptions {
  panelId: AnalysisPanelId;
  onSelect: (frameworkId: string | null) => void;
  isPremium: boolean;
  panel: Panel;  // Needed for showGatedCta() on locked state click
}
```

- Renders `<select class="framework-selector">` (or locked `<span class="framework-selector-locked">` for free users).
- Populates from `loadFrameworkLibrary()`.
- Shows current active framework as selected value (from `getActiveFrameworkForPanel()`).
- On `change`: calls `setActiveFrameworkForPanel()` then `onSelect()`.
- Locked state: disables select; on click, calls `panel.showGatedCta(PanelGateReason.FREE_TIER, onUpgradeAction)` where `onUpgradeAction` opens the upgrade modal. Do **not** dispatch a `wm-upgrade-prompt` event — that event does not exist. Use the existing `Panel.showGatedCta()` mechanism (`src/components/Panel.ts:793`).
- Minimal CSS: 11px font, dark background to match panel header aesthetic.

**Each target panel constructor appends selector to `this.header`:**

```ts
// In CountryDeepDivePanel constructor:
const selector = new FrameworkSelector({
  panelId: 'country-brief',
  onSelect: () => this.refresh(),
  isPremium: hasPremiumAccess(),
});
this.header.appendChild(selector.el);
```

---

#### Phase 5: Settings Integration

**`src/services/preferences-content.ts`**

Add a new `<details class="wm-pref-group">` section **"Analysis Frameworks"** between the Intelligence and Media groups.

Contents:

1. **Active framework display** — read-only list showing which framework is active per panel (or "Default" if none). This is informational; per-panel selection is done in the panel headers.
2. **Skill library list** — shows all imported skills with name, description (truncated), and action buttons (rename, delete). Built-in frameworks are listed as read-only (no delete/rename).
3. **Import button** — opens the import modal.

**Import modal (`FrameworkImportModal`)**

A simple modal (same pattern as existing modals in the codebase):

- Tab A: **From agentskills.io** — URL/ID input field → "Fetch" button → preview of name + instructions (first 200 chars) → "Save to Library" button.
- Tab B: **Paste skill definition** — `<textarea>` for raw JSON → `JSON.parse()` validation with live error feedback → "Save to Library" button. JSON only in phase 1; YAML deferred (no YAML parser dependency to add).
- Validation errors shown inline (empty instructions, too long, parse error, CORS/network error).
- On save: calls `saveImportedFramework()` and refreshes the library list.

**Import error taxonomy** (to be shown in modal):

| Scenario | Message |
|---|---|
| Network error / timeout | "Could not reach agentskills.io. Check your connection." |
| URL not from agentskills.io | "Only agentskills.io URLs are supported." |
| Skill has no `instructions` field | "This skill has no instructions — it may use tools only (not supported in phase 1)." |
| Invalid JSON | "Could not parse skill definition. Paste valid JSON." |
| Instructions too long (>2000 chars) | "Instructions exceed the 2000-character limit (paste is X chars). Trim and retry." |
| Duplicate name in library | "A framework named '[name]' already exists. Rename the existing one first." |
| Rate limit (10 fetches/hour) | "Too many import requests. Try again in an hour." |

---

## System-Wide Impact

### Interaction Graph

1. User selects framework in `FrameworkSelector` → calls `setActiveFrameworkForPanel()` → dispatches `wm-framework-changed` custom event on `window` with payload `{ detail: { panelId: AnalysisPanelId, frameworkId: string | null } }`
2. Target panel's `subscribeFrameworkChange()` listener fires → calls `this.refresh()` / `this.reAnalyze()`
3. Panel increments its generation counter (`this.updateGeneration++`) to cancel any in-flight async chain; sets loading state. (InsightsPanel and DailyMarketBriefPanel use generation counters — not AbortController. CountryDeepDivePanel uses whatever its existing refresh mechanism provides.)
4. Panel reads `getActiveFrameworkForPanel(panelId)` → gets `systemPromptAppend` string
5. Panel passes string to RPC call (or `geoContext` append for client-side paths) → server handler appends to system prompt → `callLlm()` with extended prompt
6. LLM response returned → `setContent()` (debounced 150ms) → panel renders new analysis

### Error Propagation

- LLM call failure (timeout, provider error): existing `showError()` pattern on the panel handles this. No special behavior needed for framework-caused errors vs. normal errors.
- Framework instructions cause LLM to refuse or produce empty output: treated as a normal empty/failed response. Consider adding a hint: "If analysis is empty, your active framework may be causing issues — try Default."
- Context window overflow (very long framework + large context snapshot): provider will either truncate or return a 400. `callLlm()` fallback chain handles provider failure. Cap at 2000 chars mitigates this.

### State Lifecycle Risks

- **In-flight race on rapid switching:** InsightsPanel and DailyMarketBriefPanel use generation counters (`this.updateGeneration++`). Rapid framework switches increment the counter; stale async chains detect the mismatch and return early without rendering. CountryDeepDivePanel's `refresh()` should follow its existing request-cancellation pattern (examine at implementation time). Do not introduce AbortController where the generation-counter pattern is already established.
- **Cache serving wrong framework result (C1):** Mitigated by extending the cache key with `frameworkHash` in `get-country-intel-brief.ts`. DeductionPanel is not cached, so no risk. InsightsPanel server path is shared/pre-computed — framework cannot apply there (documented limitation).
- **stale localStorage after downgrade:** On tier downgrade, `getActiveFrameworkForPanel()` returns `null` (gate enforced in the read path). Frameworks stay in localStorage — re-accessible on re-upgrade. Skills library is preserved.

### API Surface Parity

- The `DeductSituationRequest` proto (or handler type) gains a `framework?: string` field.
- The summarize-article handler gains a `systemAppend?: string` field.
- The country intel brief handler gains a `framework?: string` field.
- All three are optional/backward-compatible additions.

### Integration Test Scenarios

1. Premium user selects Dalio framework on CountryBriefPanel → receives analysis that references "economic seasons" — verifies prompt injection.
2. Free user clicks framework selector → locked state renders → no LLM call is triggered.
3. User rapidly switches A → B → C frameworks → only C's result renders (A and B requests are aborted).
4. Cache: CountryBriefPanel called twice with same country + same framework → second call returns cached result (no LLM call).
5. Import an agentskills.io skill with >2000-char instructions → import is rejected with character-count error.

---

## Acceptance Criteria

### Functional

- [ ] **R1:** InsightsPanel, CountryDeepDivePanel, DailyMarketBriefPanel, and DeductionPanel each show a framework selector in their panel header (visible to all users).
- [ ] **R2:** Selector shows "Default (Neutral)" + all frameworks from the user's library.
- [ ] **R3:** Built-in library ships with these 5 frameworks: Ray Dalio Macroeconomic Cycles, Warren Buffett Value & Risk, Adversarial Geopolitical Equilibrium, PMESII-PT Analysis, Red Team Devil's Advocate. Each has a meaningful `systemPromptAppend` (50–300 words of analytical instruction).
- [ ] **R4:** Selecting a non-default framework causes the panel's next LLM call to include that framework's instructions appended to the system prompt.
- [ ] **R5:** Switching framework cancels any in-flight analysis and immediately triggers a new analysis. Panel shows loading state during transition.
- [ ] **R6:** Framework selection persists in localStorage per panel. On page reload, the same framework is active.
- [ ] **R7:** Premium users can import a framework by agentskills.io URL/ID (via Vercel proxy) or by pasting JSON/YAML. Imported framework appears in the selector across all panels.
- [ ] **R8:** Settings > "Analysis Frameworks" lists all imported skills with rename and delete. Built-in frameworks are listed as read-only.
- [ ] **R9:** Non-premium users see the selector in a locked/disabled state with an upgrade tooltip. No framework-augmented LLM calls are made for free users.

### Non-Functional

- [ ] Framework instructions capped at 2000 characters — enforced at import and at server call.
- [ ] `get-country-intel-brief` cache key includes framework hash — different frameworks produce distinct cached results.
- [ ] Vercel edge route for agentskills.io fetch validates domain and rate-limits to 10/hour/IP.
- [ ] No existing tests broken by new optional fields on RPC handlers.
- [ ] TypeScript compiles clean.

### InsightsPanel caveat (phase 1 scope)

- [ ] InsightsPanel framework selector is present but labeled "(applies to client-generated analysis)". A visible note explains it does not affect the pre-computed server brief. This limitation is documented and not treated as a bug.

---

## Built-In Framework Definitions

Each framework is a complete `AnalysisFramework` object with a `systemPromptAppend` string injected at the end of the server-side LLM system prompt. These strings are the source of truth for Phase 1.

### `dalio-macro` — Ray Dalio Macroeconomic Cycles

```
Analyze this situation through the lens of Ray Dalio's macroeconomic framework.
Structure your analysis around:
1. Debt cycle positioning: identify whether the relevant economy or market is in an early, middle, or late phase of the short-term debt cycle (5–8 years) and/or the long-term debt cycle (75–100 years). Note signs of deleveraging, reflation, or credit expansion.
2. Wealth and political gap: assess whether inequality trends are amplifying internal conflict, populist policy risk, or capital flight.
3. Reserve currency status: if relevant, evaluate threats to or dependence on the dominant reserve currency. Note any de-dollarisation dynamics or monetary cooperation shifts.
4. The three forces: separately weigh (a) productivity growth, (b) short-term debt cycle effects, and (c) long-term debt cycle effects as contributing factors to the current situation.
5. Root-cause diagnosis: prefer structural explanations over proximate ones. Ask: what machine is producing this outcome?
Close with: the most likely next arc of this cycle, and what classic Dalio playbook response (print, reform, restructure, or conflict) seems most probable.
```

### `buffett-value` — Warren Buffett Value & Risk

```
Analyze this situation through Warren Buffett's value investing and risk assessment framework.
Structure your analysis around:
1. Durable competitive advantage (moat): does the entity at the centre of this story possess a sustainable moat — cost leadership, network effects, switching costs, or intangible assets? Is that moat widening or eroding?
2. Management quality and capital allocation: are decision-makers behaving rationally with capital? Are they honest with stakeholders? Look for evidence of empire-building, accounting aggression, or genuine long-term orientation.
3. Margin of safety: what is the downside scenario, and how severe is it? Quantify the worst case before discussing the upside. Buffett thinks about permanent loss of capital first.
4. Circle of competence: flag explicitly if this situation involves dynamics that are structurally difficult to predict (novel technology, regulatory discretion, geopolitical escalation ladders). Note the epistemic limit.
5. Business economics: is this a business (or state) that earns a high return on capital without requiring continuous heavy reinvestment? Or does it consume capital to grow?
Close with: a plain-language verdict on whether this situation represents a durable value opportunity, a value trap, or a situation outside the circle of competence.
```

### `geopolitical-equilibrium` — Adversarial Geopolitical Equilibrium

```
Analyze this situation as an adversarial geopolitical equilibrium problem.
Structure your analysis around:
1. Actor map: identify the principal actors (states, factions, institutions, firms). For each, state their primary objective, their best alternative to agreement (BATNA), and their red lines.
2. Payoff structure: is this a zero-sum, positive-sum, or mixed-motive game? Identify whether cooperation is stable (enforceable commitments exist) or whether defection is the dominant strategy.
3. Equilibrium assessment: what is the current equilibrium? Is it stable (no actor benefits from unilateral deviation) or is it a fragile coordination point? Name the mechanism holding it in place.
4. Destabilisation vectors: list the top three shocks or moves that would break the current equilibrium. Who has the incentive and capability to trigger each?
5. Alliance mathematics: trace second-order effects — how do shifts in one bilateral relationship alter the payoffs in adjacent relationships? Apply balance-of-power logic.
6. Credibility and signalling: assess whether key commitments (deterrence postures, treaty obligations, sanctions threats) are credible. Cheap talk vs. costly signals.
Close with: the most likely equilibrium transition path and the leading indicator to watch.
```

### `pmesii` — PMESII-PT Analysis

```
Analyze this situation using the PMESII-PT operational environment framework used in military and strategic analysis.
Assess each dimension in turn:
- Political: governance legitimacy, leadership cohesion, succession risk, external interference in political processes.
- Military: hard power balance, force readiness and morale, doctrine and training quality, escalation thresholds, asymmetric capabilities (drones, cyber, proxy forces).
- Economic: GDP trajectory, fiscal health, sanctions exposure, supply chain dependencies, resource leverage points.
- Social: demographic trends, inter-communal tensions, public trust in institutions, diaspora influence, information environment health.
- Infrastructure: critical infrastructure vulnerabilities (energy, water, transport, communications), cyber attack surface, resilience of logistics networks.
- Information: narrative dominance, disinformation vectors, media freedom, strategic communications effectiveness.
- Physical environment: terrain, climate stress, resource geography, natural disaster exposure.
- Time: which actor benefits from delay vs. speed? Is time pressure increasing or decreasing for each side?
Close with: the two or three PMESII dimensions that are most decisive for the outcome, and the cross-dimensional interaction most likely to produce a non-linear effect.
```

### `red-team` — Red Team Devil's Advocate

```
Your role is to challenge the consensus narrative on this situation by applying red team analysis.
Structure your challenge as follows:
1. State the consensus view: in 2–3 sentences, articulate the mainstream interpretation of this situation as it would appear in a major financial paper or intelligence summary.
2. Steelman the opposite: construct the strongest possible case for the contrarian position. Do not use strawmen — find the best evidence and logic available for the alternative.
3. Hidden assumptions audit: list 3–5 assumptions embedded in the consensus view that are treated as given but are actually contestable. For each, describe what would happen if the assumption is wrong.
4. Worst-case scenario (tail risk): describe the plausible worst-case outcome that the consensus view is systematically underweighting. What would need to be true for this to materialise?
5. Who benefits from the current narrative: identify actors who have incentives to promote the consensus framing. Does the prevalence of a narrative correlate with the interests of those spreading it?
6. Early warning signals: what observable data points would indicate the contrarian scenario is beginning to unfold? List 2–3 specific, trackable signals.
Close with: a one-sentence devil's advocate verdict — what is the most important thing the consensus is probably wrong about?
```

---

## Dependencies & Prerequisites

- `hasPremiumAccess()` from `src/services/panel-gating.ts` — already exists.
- `loadFromStorage` / `saveToStorage` helper pattern from `src/services/mcp-store.ts` — reuse.
- `callLlm()` in `server/_shared/llm.ts` — extend with `systemAppend?` field.
- agentskills.io domain reachable from Vercel edge — confirm during implementation.
- No new npm packages required. Paste import is JSON-only (`JSON.parse`). YAML deferred to a future phase.

---

## Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Framework instructions blow context window | Medium | 2000-char cap at import + server enforcement |
| Cache serves wrong framework (C1) | High | Extend cache key with `frameworkHash` |
| Race condition on rapid switching (C2) | Medium | Abort in-flight request before starting new one |
| Prompt injection via imported skills (C3) | Medium | Server-side cap + instructions treated as system prompt append (not user input) — LLM is not instructed to execute skill-defined tools |
| InsightsPanel server path not framework-aware | Low | Documented limitation, phase 2 scope |
| agentskills.io CORS blocks browser fetch | High | Vercel proxy route mitigates entirely |
| Free-tier users bypassing client gate via localStorage | Low | Server doesn't enforce — framework instructions are prompt additions only, not security-critical features; enforce via `hasPremiumAccess()` on the read path in the store |

---

## Future Considerations

- **Phase 2 InsightsPanel server-path support:** Requires a per-user server brief generation flow (bypasses shared cache). High cost — deserves its own planning.
- **Framework stacking (multiple active per panel):** Out of scope for phase 1. Evaluation after user feedback.
- **Community framework marketplace:** Sharing imported skills across users. Requires backend storage (not localStorage) and moderation. Revenue opportunity.
- **Tool execution (agentskills.io `tools` field):** Requires server-side orchestration, function registry, security sandbox. Phase 3+.
- **Framework quality scoring:** After enough usage, track which frameworks produce higher engagement/re-analysis rates.

---

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md](docs/brainstorms/2026-03-27-intelligence-analytical-frameworks-requirements.md)
  Key decisions carried forward: per-panel (not global), auto re-run on switch, premium-only, instructions-only from agentskills.io phase 1.

### Internal References

- Pattern reference for store: `src/services/mcp-store.ts`
- Pattern reference for settings group: `src/services/preferences-content.ts:179` (Intelligence group)
- Premium gate: `src/services/panel-gating.ts` — `hasPremiumAccess()`
- isProUser: `src/services/widget-store.ts:153`
- LLM call: `server/_shared/llm.ts` — `callLlm(LlmCallOptions)`
- Country brief system prompt: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:42`
- Country brief cache key: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:~29`
- Deduction prompts: `server/worldmonitor/intelligence/v1/deduction-prompt.ts:101-143`
- World brief / market brief system prompt: `server/worldmonitor/news/v1/_shared.ts:50`
- Summarize RPC handler: `server/worldmonitor/news/v1/summarize-article.ts`
- Panel base class: `src/components/Panel.ts`
- InsightsPanel (WorldBrief): `src/components/InsightsPanel.ts:340` (client path)
- CountryDeepDivePanel: `src/components/CountryDeepDivePanel.ts`
- DailyMarketBriefPanel: `src/components/DailyMarketBriefPanel.ts` + `src/services/daily-market-brief.ts:375`
- DeductionPanel: `src/components/DeductionPanel.ts:122`
- AI flow settings (pattern ref): `src/services/ai-flow-settings.ts`

### Related Work

- Issue: koala73/worldmonitor#2291 (user request — skills repository for structured analysis)
- External: apifyforge.com/actors/intelligence/adversarial-geopolitical-equilibrium-mcp (Geopolitical Equilibrium framework reference)
- agentskills.io specification (framework definition format)
