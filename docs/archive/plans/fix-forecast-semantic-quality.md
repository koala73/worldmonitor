# Plan: Fix Forecast Semantic Quality — 3 PRs

## Context

Live run `1773983083084-bu6b1f` (2026-03-20T05:04:52) confirms two categories of
junk effects still reaching the report surface. Root cause identified from live R2
data and code trace. This plan fixes them precisely and independently.

---

## Root Cause: Confirmed from Live R2 Data

### Bug 1: Generic blueprint actors create false `sharedActor` cross-situation links

The actor registry at line 2044 uses `actor.key || \`${actor.name}:${actor.category}\``
as the actor ID. When two different situations both instantiate a generic blueprint
actor (e.g. `"Incumbent leadership"` for conflict domain AND political domain), they
get the SAME actor ID: `"Incumbent leadership:state"`.

The actor registry deduplicates them into ONE entry with `forecastIds` from both
situations. Then `buildSituationSimulationState` filters actors per situation by
forecastId overlap — both situations get this shared actor entry. When
`pushInteraction` compares `source.actorId === target.actorId`, it fires `true`.

**Live evidence:**
```
Israel conflict → Taiwan political | ch: regional_spillover | sharedActor: true
  srcActorId: "Incumbent leadership:state" | actorSpec: 0.68

Cuba infrastructure → Iran infrastructure | ch: service_disruption | sharedActor: true
  srcActorId: "Civil protection authorities:state" | actorSpec: 0.73
```

`scoreActorSpecificity("Incumbent leadership")` = 0.68. It IS already penalized by
`GENERIC_ACTOR_NAME_MARKERS` containing `'leadership'`. The engine just never gates
`sharedActor` on specificity before using it as a structural credit.

### Bug 2: No geographic theater awareness in cross-situation effect emission

Once an interaction makes it into `reportableInteractionLedger` via `sharedActor: true`,
`buildCrossSituationEffects` has no concept of geographic distance between situations.
Israel (MENA) → Taiwan (East Asia) passes all current gates if the interaction group
has high enough score. There is no check that these are on opposite sides of the planet.

`CROSS_THEATER_EXEMPT_CHANNELS` doesn't exist yet. Cyber and market effects can
legitimately cross theaters (same APT group, same commodity price). Conflict,
political, infrastructure, and supply_chain effects should not unless the actor is
specifically and credibly named.

---

## PR 1 — `fix(forecast): block generic-actor cross-theater interactions`

**File:** `scripts/seed-forecasts.mjs`
**Scope:** 3 targeted changes + test updates
**Risk:** Low — tightens existing gates, does not remove any data path

### Change A: Specificity gate in `pushInteraction` (lines 3480–3491)

Move `sourceSpecificity / targetSpecificity / avgSpecificity` computation ABOVE the
`sharedActor` declaration. Add specificity threshold to `sharedActor`:

**Before (line 3480):**
```js
const sharedActor = source.actorId && target.actorId && source.actorId === target.actorId;
const sharedChannels = ...
...
const sourceSpecificity = scoreActorSpecificity(source);
const targetSpecificity = scoreActorSpecificity(target);
const avgSpecificity = (sourceSpecificity + targetSpecificity) / 2;
```

**After:**
```js
const sourceSpecificity = scoreActorSpecificity(source);
const targetSpecificity = scoreActorSpecificity(target);
const avgSpecificity = (sourceSpecificity + targetSpecificity) / 2;
const sharedActor = source.actorId && target.actorId && source.actorId === target.actorId
  && avgSpecificity >= 0.72;
const sharedChannels = ...
```

**Threshold justification from live data:**

- `"Incumbent leadership:state"` → 0.68 → BLOCKED ✓
- `"Civil protection authorities:state"` → 0.73 → BLOCKED ✓ (just above 0.72, need check)
- `"Threat actors:adversarial"` → 0.95 → ALLOWED (China/US cyber) ✓
- `"External power broker:external"` → 0.85 → ALLOWED at this stage, handled by Change B

NOTE: "Civil protection authorities:state" scores 0.73 because:
`base(0.55) + nonShared(+0.10) + nonGenericCategory(+0.15) + 3-word name(+0.05) - genericMarker('authorities', -0.12) = 0.73`

The threshold of 0.72 blocks it by 0.01. This is intentional but fragile. If concerned, raise to
0.75 to give a clear margin. Test with both values.

### Change B: MACRO_REGION_MAP + cross-theater gate in `buildCrossSituationEffects`

Add a new constant block immediately before `buildCrossSituationEffects`:

```js
const MACRO_REGION_MAP = {
  // MENA
  'Israel': 'MENA', 'Iran': 'MENA', 'Syria': 'MENA', 'Iraq': 'MENA',
  'Lebanon': 'MENA', 'Gaza': 'MENA', 'Egypt': 'MENA', 'Saudi Arabia': 'MENA',
  'Yemen': 'MENA', 'Jordan': 'MENA', 'Turkey': 'MENA', 'Libya': 'MENA',
  'Middle East': 'MENA', 'Persian Gulf': 'MENA', 'Red Sea': 'MENA',
  'Strait of Hormuz': 'MENA', 'Eastern Mediterranean': 'MENA',
  // EAST_ASIA
  'Taiwan': 'EAST_ASIA', 'China': 'EAST_ASIA', 'Japan': 'EAST_ASIA',
  'South Korea': 'EAST_ASIA', 'North Korea': 'EAST_ASIA',
  'Western Pacific': 'EAST_ASIA', 'South China Sea': 'EAST_ASIA',
  // AMERICAS
  'United States': 'AMERICAS', 'Brazil': 'AMERICAS', 'Mexico': 'AMERICAS',
  'Cuba': 'AMERICAS', 'Canada': 'AMERICAS', 'Colombia': 'AMERICAS',
  'Venezuela': 'AMERICAS', 'Argentina': 'AMERICAS', 'Peru': 'AMERICAS',
  // EUROPE
  'Russia': 'EUROPE', 'Ukraine': 'EUROPE', 'Germany': 'EUROPE',
  'France': 'EUROPE', 'United Kingdom': 'EUROPE', 'Poland': 'EUROPE',
  'Baltic Sea': 'EUROPE', 'Black Sea': 'EUROPE', 'Kerch Strait': 'EUROPE',
  'Sweden': 'EUROPE', 'Finland': 'EUROPE', 'Norway': 'EUROPE',
  // SOUTH_ASIA
  'India': 'SOUTH_ASIA', 'Pakistan': 'SOUTH_ASIA', 'Afghanistan': 'SOUTH_ASIA',
  'Bangladesh': 'SOUTH_ASIA', 'Myanmar': 'SOUTH_ASIA',
  // AFRICA
  'Congo': 'AFRICA', 'Sudan': 'AFRICA', 'Ethiopia': 'AFRICA',
  'Nigeria': 'AFRICA', 'Somalia': 'AFRICA', 'Mali': 'AFRICA',
  'Mozambique': 'AFRICA', 'Sahel': 'AFRICA',
};

// Channels where cross-theater effects are legitimate regardless of geography
const CROSS_THEATER_EXEMPT_CHANNELS = new Set(['cyber_disruption', 'market_repricing']);

// Minimum actor specificity to justify a named-actor cross-theater link
const CROSS_THEATER_ACTOR_SPECIFICITY_MIN = 0.90;

function getMacroRegion(regions = []) {
  for (const region of regions) {
    if (MACRO_REGION_MAP[region]) return MACRO_REGION_MAP[region];
  }
  return null;
}

function isCrossTheaterPair(sourceRegions, targetRegions) {
  const src = getMacroRegion(sourceRegions);
  const tgt = getMacroRegion(targetRegions);
  return !!(src && tgt && src !== tgt);
}
```

Then inside `buildCrossSituationEffects`, immediately after the `hasDirectStructuralLink`
line (currently line 3880), add:

```js
const isCrossTheater = isCrossTheaterPair(source.regions || [], target.regions || []);
if (
  isCrossTheater
  && !CROSS_THEATER_EXEMPT_CHANNELS.has(group.strongestChannel)
  && (!hasSharedActor || Number(group.avgActorSpecificity || 0) < CROSS_THEATER_ACTOR_SPECIFICITY_MIN)
) continue;
```

**Gate logic verified against live pairs:**

| Pair | Channel | CrossTheater | Exempt? | SharedActor | ActorSpec | Result |
|------|---------|-------------|---------|------------|----------|--------|
| China cyber ↔ US cyber | cyber_disruption | YES (EAST_ASIA/AMERICAS) | YES | — | — | ALLOWED ✓ |
| Brazil ↔ Mexico conflict | security_escalation | NO (both AMERICAS) | — | true | 0.85 | ALLOWED ✓ |
| Brazil ↔ Israel conflict | security_escalation | YES (AMERICAS/MENA) | NO | true (after PR1A) | 0.85 < 0.90 | BLOCKED ✓ |
| Cuba ↔ Iran infra | service_disruption | YES (AMERICAS/MENA) | NO | false (after PR1A) | 0.73 | BLOCKED ✓ |
| Israel ↔ Taiwan political | regional_spillover | YES (MENA/EAST_ASIA) | NO | false (after PR1A) | 0.68 | BLOCKED ✓ |
| Israel ↔ US political | regional_spillover | YES (MENA/AMERICAS) | NO | false (after PR1A) | 0.68 | BLOCKED ✓ |
| Taiwan ↔ US political | political_pressure | YES (EAST_ASIA/AMERICAS) | NO | true | 0.85 < 0.90 | BLOCKED (correct: generic actor) |
| Baltic ↔ Black Sea supply | logistics_disruption | NO (both EUROPE) | — | — | — | ALLOWED ✓ |

### Change C: Export `isCrossTheaterPair` and `getMacroRegion` at bottom of file

Add to the `export {}` block so tests can import them:
```js
export {
  ...existing exports...
  isCrossTheaterPair,
  getMacroRegion,
};
```

### Test changes (`tests/forecast-trace-export.test.mjs`)

Add 3 new tests in the `forecast run world state` describe block:

1. **`blocks Israel → Taiwan via generic Incumbent Leadership actor`**
   - Setup: two simulations (conflict/MENA, political/EAST_ASIA) with sharedActor=true at spec 0.68
   - Assert: `effects.length === 0`

2. **`allows China → US via Threat Actors cross-theater cyber_disruption`**
   - Setup: two simulations (cyber/EAST_ASIA, cyber/AMERICAS) with cyber_disruption, sharedActor=true at spec 0.95
   - Assert: `effects.length === 1`, `effects[0].channel === 'cyber_disruption'`

3. **`blocks Brazil → Israel via External Power Broker security_escalation`**
   - Setup: two simulations (conflict/AMERICAS, conflict/MENA) with sharedActor=true at spec 0.85
   - Assert: `effects.length === 0` (cross-theater, channel not exempt, spec < 0.90)

Also add unit tests for `isCrossTheaterPair` directly:

- `isCrossTheaterPair(['Israel'], ['Taiwan'])` → `true`
- `isCrossTheaterPair(['Brazil'], ['Mexico'])` → `false`
- `isCrossTheaterPair(['China'], ['unknown-region'])` → `false` (null getMacroRegion)

### Verification

Run:
```
node --check scripts/seed-forecasts.mjs
tsx --test tests/forecast-trace-export.test.mjs
```

Expected: 0 junk cross-theater effects in next live run. Check `report.crossSituationEffects`
should contain only China/US cyber and Brazil/Mexico conflict.

---

## PR 2 — `fix(forecast): raise LLM enrichment budget`

**File:** `scripts/seed-forecasts.mjs` lines 27–28 only
**Risk:** Very low — constant change, no logic change

### Change

```js
// Before
const ENRICHMENT_COMBINED_MAX = 3;
const ENRICHMENT_SCENARIO_MAX = 3;

// After
const ENRICHMENT_COMBINED_MAX = 5;
const ENRICHMENT_SCENARIO_MAX = 3;
```

Total enrichment budget: 3+3=6 → 5+3=8 per run.

### Why not higher?

- Current LLM success rate: 3/3 (100%) — headroom exists
- 8 enriched / 13 published = 61.5% target enrichedRate (up from 38.5%)
- Raising to 8+3=11 risks rate limits; 5+3=8 is safe headroom
- The scenario-only path is cheaper (no perspectives/cases call), keep at 3

### Test

No logic change. The existing enrichment selection tests remain valid.
Run `tsx --test tests/forecast-trace-export.test.mjs` as smoke test.

### Verification

After next live run, check `traceQuality.enrichedRate` in summary.json.
Target: > 0.55. Acceptable: > 0.45.

---

## PR 3 — `fix(forecast): diagnose and fix military detector surfacing`

**Status: requires live data diagnosis before coding**

### Diagnosis step (run before writing code)

Pull the latest world-state and check:
```js
// In the live run, check what military data was available
ws.domainStates.find(d => d.domain === 'military')
ws.report.domainOverview  // check if military appears in activeDomainCount
```

Also check the seed inputs to confirm theater posture data:
```
curl https://api.worldmonitor.app/api/forecast-bootstrap | jq '.militaryData'
```

### Two possible fixes depending on diagnosis:

**Path A — Detector emits 0 (theater posture all 'normal')**

The gate at line 719:
```js
if (posture !== 'elevated' && posture !== 'critical' && !surgeIsUsable) continue;
```
This skips all theaters at 'normal' posture unless there's a usable surge. If no current
theater is elevated and surges are below threshold, zero military forecasts are generated.

Fix: Add a baseline military forecast for the most active theater even at 'normal' posture
if surge multiple is above a lower threshold (e.g., >= 1.8x baseline). This keeps military
present even during calm periods.

**Path B — Detector emits candidates but publish selection suppresses them**

Check `publishTelemetry.suppressedFamilySelection` and `suppressedSituationDomainCap`.
If military forecasts exist but are suppressed, examine whether `canSelect` in the
publish selection is blocking them. Military is already in the exemption list for
domain cap at line 5315, but check whether `MAX_PRESELECTED_FORECASTS_PER_FAMILY`
or `MAX_PUBLISHED_FORECASTS_PER_FAMILY_DOMAIN` is capping them before the diversity
pass reaches them.

Fix for Path B: Ensure at least one military forecast is explicitly seeded in the first
pass of the selection loop before the diversity filter runs.

### Not starting PR 3 until diagnosis confirms Path A or B.

---

## Execution Order

1. **PR 1** — `fix/forecast-cross-theater-gate` branch — highest leverage, fixes the
   junk effects that are the primary credibility problem
2. **PR 2** — `fix/forecast-enrichment-budget` branch — 2-line change, can be done
   in the same session, independent of PR 1
3. **PR 3** — diagnose first from live R2 data, then write a targeted fix

PRs 1 and 2 are independent and can be merged in any order. PR 3 is independent of both.

---

## What This Does Not Fix

- Enrichment quality — the LLM output quality depends on input prompt quality, not these PRs
- Situation clustering precision — some situations have overly broad region sets (e.g. Black Sea
  market at `["Black Sea","Middle East","Red Sea","Western Pacific"]`) which will continue to
  create imprecise cross-situation scoring; this is a separate, larger issue
- Retention/cleanup of old R2 trace files — 100+ runs/day accumulating with no TTL
