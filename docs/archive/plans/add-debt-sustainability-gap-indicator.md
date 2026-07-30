# Plan: Add `debtSustainabilityGap` indicator to WorldMonitor resilience

**Status**: APPROVED by Codex (gpt-5.5) after 4 rounds of review on 2026-05-12.
**Origin**: session pivot from the orphan-fiscal-data finding — `govExpenditurePct` + `primaryBalancePct` were ingested via `seed-imf-macro.mjs` but no resilience indicator consumed them. Plan #1 (descriptive UI surface) is separately shipped this session.

---

## Context

WorldMonitor scores 190+ countries on a resilience composite. One dimension is `fiscalSpace`, with three sub-indicators today (all read from one Redis blob `resilience:recovery:fiscal-space:v1`, populated by `scripts/seed-recovery-fiscal-space.mjs`):

```
recoveryGovRevenue       weight 0.4  higherBetter   goalposts 5..45    GGR_NGDP
recoveryFiscalBalance    weight 0.3  higherBetter   goalposts -15..5   GGXCNL_NGDP
recoveryDebtToGdp        weight 0.3  lowerBetter    goalposts 0..150   GGXWDG_NGDP
```

Scorer: `scoreFiscalSpace` in `server/worldmonitor/resilience/v1/_dimension-scorers.ts:2013`.

**Problem**: None of these signals alone — or blended — answers "is this country's debt path sustainable?" A country can have high debt + strong primary surplus + g≈r and be fine (Japan-ish), or low debt + chronic primary deficit + r>g and be in trouble. The current composite penalizes the level and rewards the surplus, then averages, losing the r-g interaction term.

**Proposal**: add a fourth `fiscalSpace` indicator — `debtSustainabilityGap` — capturing the standard IMF DSA construct used by Article IV missions, ECB MIP scoreboard, and S&P sovereign methodology.

---

## Formula

```
g  = (1 + realGdpGrowthPct/100) × (1 + inflationPct/100) − 1     compounded nominal growth (decimal)
r  = max(0, (primaryBalancePct − fiscalBalancePct) / debtToGdpPct)  effective interest rate (decimal)
pb*= ((r − g) / (1 + g)) × debtToGdpPct                          debt-stabilizing primary balance (% GDP)
gap= primaryBalancePct − pb*                                     positive = debt declining, negative = rising
```

**Derivation note**: `r` comes from the algebraic identity (overall balance = primary balance − interest expense), so `interest %GDP = primaryBalance − fiscalBalance`, then `r = interest/debt`. This avoids needing per-country sovereign yields (which we only have for US via FRED `DGS10`).

---

## All inputs already seeded — no new ingestion

| Term | IMF series | Existing seeder | Existing field |
|---|---|---|---|
| `d` debt %GDP | GGXWDG_NGDP | seed-recovery-fiscal-space.mjs | `debtToGdpPct` ✓ |
| `pb` primary balance | GGXONLB_NGDP | seed-imf-macro.mjs | `primaryBalancePct` (orphan; **will pull into fiscal-space blob too**) |
| overall balance | GGXCNL_NGDP | seed-recovery-fiscal-space.mjs | `fiscalBalancePct` ✓ |
| real growth | NGDP_RPCH | seed-imf-growth.mjs | `realGdpGrowthPct` (will pull into fiscal-space blob too) |
| CPI inflation | PCPIPCH | seed-imf-macro.mjs | `inflationPct` (will pull into fiscal-space blob too) |

---

## Worked examples (end-to-end)

| Country | d | pb | fb | real g | infl | nominal g | r | pb* | **gap** | normalized score |
|---|---|---|---|---|---|---|---|---|---|---|
| France 2024 | 110 | −2.5 | −4.5 | 0.7 | 2.1 | 2.815% | 1.818% | −1.067 | **−1.43** | **44.6** |
| Japan 2024 | 250 | 0 | −3 | 0.5 | 2.0 | 2.510% | 1.200% | −3.198 | **+3.20** | **100** (clamps) |
| Italy 2024 | 137 | +1.0 | −3.5 | 0.5 | 2.0 | 2.510% | 3.285% | +1.038 | **−0.04** | **62.0** |
| Norway 2024 | 38 | +10 | +8 | 1.0 | 2.5 | 3.525% | 5.263% | +0.637 | **+9.36** | **100** (clamps) |
| Argentina 2024 | 90 | −2 | −5 | −3.0 | 200 | inflation > 25% cap | — | — | **null** | excluded |

Gap goalposts `worst=-5, best=+3`, direction `higherBetter`, linear normalization → score [0..100], clamps outside.

---

## Implementation — single seed blob, gap computed at seed time

**Decision**: compute the gap in the seeder, store `debtSustainabilityGapPct` per country in the blob. Scorer just normalizes. Reasons:

- Backtest harness (`EXTRACTION_RULES`) becomes a one-liner identical to existing fiscal rules.
- Year-alignment logic runs once per seeder tick, not per score request.
- Matches the existing project pattern (scorers read precomputed fields; they don't do algebra).

### 1. `scripts/seed-recovery-fiscal-space.mjs`

**Architecture**: factor the pure logic into exported helpers so tests don't need to mock `imfSdmxFetchIndicator`:

```js
// Exported constants — also imported by tests so the prod floors are asserted
// directly, not via Function.prototype.toString() introspection.
export const FISCAL_SPACE_VALIDATION_FLOORS = { fiscal3: 150, gap: 100 };
export const INFLATION_GAP_CAP_PCT = 25;

// Pure helpers, exported for testing:
export function latestCommonYear(byYearMaps) {
  // byYearMaps: array of { [year]: value } for the 5 formula inputs.
  // Returns the most recent year present in all maps with finite values, or null.
}

export function computeDebtSustainabilityGap({ debt, pb, fb, realG, infl }) {
  if (debt == null || debt <= 0) return null;
  if (infl == null || infl > INFLATION_GAP_CAP_PCT) return null;
  if (pb == null || fb == null || realG == null) return null;

  const g = (1 + realG / 100) * (1 + infl / 100) - 1;        // compounded nominal growth (decimal)
  const r = Math.max(0, (pb - fb) / debt);                    // effective rate (decimal), floor 0
  const pbStar = ((r - g) / (1 + g)) * debt;
  return pb - pbStar;
}

export function buildFiscalSpaceCountries(perIndicator) {
  // perIndicator: { revenue, balance, debt, primaryBalance, growth, inflation }
  //   — each is { [iso3]: { [year]: value } } as returned by imfSdmxFetchIndicator
  // Returns: { [iso2]: { ... per-country payload ... } }

  // Country inclusion stays anchored to fiscal-3 only — exact existing semantics:
  // union over revenue ∪ balance ∪ debt keys, then skip if all three resolve null.
  // Critically NOT widened to growth/inflation, which would let a fiscal-series
  // outage emit countries with null fiscal-3 fields (R1-P0 risk).
  const countries = {};
  const allIso3 = new Set([
    ...Object.keys(perIndicator.revenue),
    ...Object.keys(perIndicator.balance),
    ...Object.keys(perIndicator.debt),
  ]);

  for (const iso3 of allIso3) {
    if (isAggregate(iso3)) continue;
    const iso2 = ISO3_TO_ISO2[iso3]; if (!iso2) continue;

    // Fiscal-3 keep their individual per-series latest values (no regression):
    const rev  = latestValue(perIndicator.revenue[iso3]);
    const bal  = latestValue(perIndicator.balance[iso3]);
    const debt = latestValue(perIndicator.debt[iso3]);

    // Existing skip guard — preserve verbatim:
    if (!rev && !bal && !debt) continue;

    // Gap inputs require year alignment across the 5 formula inputs only
    // (revenue is NOT in the formula → not in the alignment check):
    const commonYear = latestCommonYear([
      perIndicator.debt[iso3],
      perIndicator.balance[iso3],
      perIndicator.primaryBalance[iso3],
      perIndicator.growth[iso3],
      perIndicator.inflation[iso3],
    ]);

    let pb = null, real = null, infl = null, gap = null, gapYear = null;
    if (commonYear != null) {
      // ALL formula inputs read at commonYear — fixes R2-P1-1:
      const debtCommon = perIndicator.debt[iso3][commonYear];
      const fbCommon   = perIndicator.balance[iso3][commonYear];
      pb               = perIndicator.primaryBalance[iso3][commonYear];
      real             = perIndicator.growth[iso3][commonYear];
      infl             = perIndicator.inflation[iso3][commonYear];
      gap = computeDebtSustainabilityGap({ debt: debtCommon, pb, fb: fbCommon, realG: real, infl });
      gapYear = commonYear;
    }

    countries[iso2] = {
      // Existing fiscal-3 fields — unchanged latest-per-series semantics:
      govRevenuePct:     rev?.value ?? null,
      fiscalBalancePct:  bal?.value ?? null,
      debtToGdpPct:      debt?.value ?? null,
      year:              rev?.year ?? bal?.year ?? debt?.year ?? null,
      // New gap-indicator fields — read at commonYear or null:
      primaryBalancePct:         pb,
      realGdpGrowthPct:          real,
      inflationPct:              infl,
      debtSustainabilityGapPct:  gap,
      gapYear,
    };
  }
  return countries;
}

export function validateFiscalSpace(data, floors = FISCAL_SPACE_VALIDATION_FLOORS) {
  const all = Object.values(data?.countries || {});
  const withFiscal3 = all.filter(c =>
    c.govRevenuePct != null && c.fiscalBalancePct != null && c.debtToGdpPct != null
  ).length;
  const withGap = all.filter(c => c.debtSustainabilityGapPct != null).length;
  return withFiscal3 >= floors.fiscal3 && withGap >= floors.gap;
}
```

The `fetchFiscalSpace` async wrapper stays small — it does the 6 `imfSdmxFetchIndicator` calls in parallel, hands the result to `buildFiscalSpaceCountries`, and passes through.

**Schema bump**: `schemaVersion: 1 → 2`. New fields are additive — old scorer reads work unchanged.

**Validation semantics (explicit)**:

- `validateFiscalSpace` is called by `runSeed`'s pre-publish check.
- If it returns false → **seeder rejects the payload entirely**; `runSeed` short-circuits the canonical write; the previous canonical blob keeps serving (existing strict-floor behavior in `_seed-utils.mjs:1010-1017`).
- If it returns true but some individual countries lack gap inputs → those countries get `debtSustainabilityGapPct: null` and the scorer naturally redistributes weight via `weightedBlend`. The other 3 indicators continue scoring those countries.

Two failure modes, cleanly separated:

- **System-level outage** (IMF fiscal-3 down across the board → <150 countries with fiscal-3 OR <100 with gap inputs) → seeder refuses to publish, last canonical blob serves.
- **Per-country gap unavailability** (year misalignment, hyperinflation cap, partial growth/inflation for one specific country) → that country's gap indicator scores null, fiscal-3 still scores it.

### 2. `server/worldmonitor/resilience/v1/_indicator-registry.ts`

Add new indicator entry, rebalance existing fiscalSpace weights:

```ts
{
  id: 'debtSustainabilityGap',
  dimension: 'fiscalSpace',
  description: 'Primary-balance gap to debt-stabilizing level: gap = pb − ((r−g)/(1+g))·d (IMF DSA construct). Positive = debt path declining, negative = rising. r derived from interest expense / debt; g from compounded real growth and CPI.',
  direction: 'higherBetter',
  goalposts: { worst: -5, best: 3 },
  weight: 0.35,
  sourceKey: 'resilience:recovery:fiscal-space:v1',
  scope: 'global',
  cadence: 'annual',
  tier: 'core',
  coverage: 150,  // realistic joint coverage post-launch; lower than 190 by design
  license: 'open-data',
  comprehensive: true,
},
// Existing three reweighted:
// recoveryGovRevenue:    0.4  → 0.25
// recoveryFiscalBalance: 0.3  → 0.20
// recoveryDebtToGdp:     0.3  → 0.20
// debtSustainabilityGap:        0.35
//                       sum = 1.0
```

### 3. `server/worldmonitor/resilience/v1/_dimension-scorers.ts::scoreFiscalSpace`

```ts
return weightedBlend([
  { score: entry.govRevenuePct == null ? null : normalizeHigherBetter(entry.govRevenuePct, 5, 45), weight: 0.25 },
  { score: entry.fiscalBalancePct == null ? null : normalizeHigherBetter(entry.fiscalBalancePct, -15, 5), weight: 0.20 },
  { score: entry.debtToGdpPct == null ? null : normalizeLowerBetter(entry.debtToGdpPct, 0, 150), weight: 0.20 },
  { score: entry.debtSustainabilityGapPct == null ? null : normalizeHigherBetter(entry.debtSustainabilityGapPct, -5, 3), weight: 0.35 },
]);
```

Existing `weightedBlend` already redistributes null-weights — no special handling needed.

### 4. `scripts/compare-resilience-current-vs-proposed.mjs:366`

Add one row to `EXTRACTION_RULES` matching the existing `recovery-country-field` shape:

```js
debtSustainabilityGap: {
  type: 'recovery-country-field',
  key:  'resilience:recovery:fiscal-space:v1',
  field: 'debtSustainabilityGapPct',
},
```

This makes the existing `tests/resilience-indicator-extraction-plan.test.mjs:23` parity test pass automatically.

### 5. Type update — `RecoveryFiscalSpaceCountry`

Locate the type def (likely in `_indicator-registry.ts` or `server/worldmonitor/resilience/types.ts`), add:
```ts
primaryBalancePct: number | null;
realGdpGrowthPct: number | null;
inflationPct: number | null;
debtSustainabilityGapPct: number | null;
gapYear: number | null;
```

### 6. Docs

- `docs/methodology/country-resilience-index.mdx:322` — update the fiscal-space indicator table (4 rows now, new weights).
- `docs/methodology/indicator-sources.yaml:521` — add new entry with source series, formula, caveats (hyperinflation cap, joint-coverage note).

---

## Edge cases

| Case | Handling |
|---|---|
| `debtToGdpPct ≤ 0` (negative net debt, rare) | `r` division skipped, gap = null. Indicator score null → weight redistributes. |
| `r < 0` from WEO rounding (interest near zero) | `r` floor clamped at 0. |
| `inflationPct > 25` (hyperinflation) | Gap = null. Argentina, Lebanon, Venezuela excluded from this indicator until inflation normalizes. Fiscal-3 still score them. |
| Any individual input null | `commonYear` returns null → gap = null. Fiscal-3 unaffected. |
| Year mismatch across inputs | Same as above — `latestCommonYear` returns null → gap = null. |
| Country missing from blob entirely | Existing `IMPUTE.recoveryFiscalSpace` fallback fires (no change). |

---

## Tests

### Unit tests (new file `tests/resilience-debt-sustainability-gap.test.mts`)

Pure formula tests via the exported helper. Helper signature is `{ debt, pb, fb, realG, infl }` — match exactly:

```ts
computeDebtSustainabilityGap({ debt: 110, pb: -2.5, fb: -4.5, realG: 0.7, infl: 2.1 })
  // → gap ≈ -1.43

computeDebtSustainabilityGap({ debt: 250, pb: 0, fb: -3, realG: 0.5, infl: 2.0 })
  // → gap ≈ +3.20

computeDebtSustainabilityGap({ debt: 38,  pb: 10, fb: 8,  realG: 1.0, infl: 2.5 })
  // → gap large positive (>5)

computeDebtSustainabilityGap({ debt: 0,   pb: 0, fb: 0,   realG: 1, infl: 2 })
  // → null (degenerate denom)

computeDebtSustainabilityGap({ debt: 90,  pb: -2, fb: -5, realG: -3, infl: 200 })
  // → null (inflation cap)
```

### Seeder contract tests (new file `tests/seed-recovery-fiscal-space.test.mts`)

No ESM mocking. Test the pure exported helpers directly:

```ts
import {
  buildFiscalSpaceCountries,
  computeDebtSustainabilityGap,
  latestCommonYear,
  validateFiscalSpace,
  FISCAL_SPACE_VALIDATION_FLOORS,
} from '../scripts/seed-recovery-fiscal-space.mjs';

// computeDebtSustainabilityGap — formula correctness (5 worked cases above)
// latestCommonYear — picks latest year present in all maps; returns null if none

// buildFiscalSpaceCountries — 6-country fixture covering:
//   - full data → all 4 fields populated
//   - one fiscal-3 field missing (e.g. no revenue but balance + debt present) → emitted with rev=null, fiscal balance + debt intact
//   - missing growth → emitted, gap=null, fiscal-3 intact
//   - inflation > 25 (Argentina-like) → emitted, gap=null, fiscal-3 intact
//   - year mismatch (debt 2024, others 2023) → emitted, gap=null, fiscal-3 intact
//   - all fiscal-3 missing (only macro/growth present) → SKIPPED (preserves existing skip guard)

// validateFiscalSpace — exercise with small floors:
//   - validateFiscalSpace(small5CountryFixture, { fiscal3: 3, gap: 2 }) → true
//   - validateFiscalSpace(small5CountryFixture, { fiscal3: 150, gap: 100 }) → false
//   - Two-floor independence: pass 1, fail 2 → false; pass 2, fail 1 → false

// Production floors — assert named constant directly:
it('production floors are 150 fiscal-3 / 100 gap-inputs', () => {
  assert.deepEqual(FISCAL_SPACE_VALIDATION_FLOORS, { fiscal3: 150, gap: 100 });
});
```

### Scorer test (new file `tests/resilience-fiscal-space.test.mts`)

5 representative countries through `scoreFiscalSpace` end-to-end. Snapshot test on the output to catch unintended drift on rebalanced weights.

### Existing test parity

- `tests/resilience-indicator-extraction-plan.test.mjs:23` — must pass after EXTRACTION_RULES update.
- Existing `scoreFiscalSpace`-touching tests need score-baseline updates (the weight change shifts all current scores slightly even without the new indicator firing).

---

## Backtest / ranking-shift validation

Run `scripts/compare-resilience-current-vs-proposed.mjs` against the change. Expected directional shifts:

- **Drops**: high-debt + negative-pb (Italy, Greece, Belgium, France marginally) — losing level-only debt protection
- **Rises**: high-debt + g≈r + flat-pb (Japan — formula honors that debt isn't actually growing)
- **Rises**: low-debt + positive pb (Norway, Singapore, Switzerland, Denmark)
- **Held**: mid-debt + strong nominal growth via inflation (Vietnam, India, Indonesia) — g > r gives them room
- **Excluded**: Argentina, Lebanon, Venezuela (inflation cap) — fiscal-3 still scores them, no gap signal

**Acceptance threshold**: ≤10 countries shift by more than ±5 ranks in the `economy` pillar. Any country breaching that gets a one-line explanation in the PR description.

---

## Deployment verification

### Pre-merge

- All new + existing tests green
- Local seeder run against IMF fixture, dump JSON, manually inspect 3 countries (France, Japan, Norway): assert `debtSustainabilityGapPct` matches worked examples ±0.01.
- `npx tsc --noEmit` clean.

### Post-merge / post-deploy

- Wait one seeder cron tick (≤24h for monthly cadence; actual seeder runs on a faster cron for this blob).
- **Redis payload assertion** (primary verification): direct GET on `resilience:recovery:fiscal-space:v1` (via Upstash REST or `node -e` against the prod Redis URL). Assert ≥100 countries have `debtSustainabilityGapPct: number` and spot-check 3 known countries (France, Japan, Norway) against the worked examples ±0.5 tolerance to account for IMF data refreshes.
- **Scorer impact** (secondary): the production resilience API exposes dimension-level scores, not sub-indicator rows — so "4 sub-scores not 3" is NOT directly observable from the API. Instead, run `scripts/compare-resilience-current-vs-proposed.mjs` against pre/post Redis snapshots and confirm the expected directional ranking shifts.
- `/api/health` will show the seeder's freshness — that's real and useful — but NOT field-level coverage. Don't rely on health for field verification.

### Rollback path

- Revert the PR. Seeder schemaVersion drops back to 1 on the next tick. Old scorer reads the new blob — extra fields are ignored, fiscal-3 score returns. Zero data loss; only a few hours of degraded scores between revert and next seeder tick.

---

## Files touched

1. `scripts/seed-recovery-fiscal-space.mjs` — pull 3 more series, compute gap, schema v2, two-floor validate, export named helpers + floors constant.
2. `server/worldmonitor/resilience/v1/_indicator-registry.ts` — new indicator + rebalanced weights.
3. `server/worldmonitor/resilience/v1/_dimension-scorers.ts::scoreFiscalSpace` — add 4th sub-score.
4. Type def of `RecoveryFiscalSpaceCountry` (likely same file as scorer or its types module).
5. `scripts/compare-resilience-current-vs-proposed.mjs:366` — one new EXTRACTION_RULES row.
6. `docs/methodology/country-resilience-index.mdx:322` — update fiscal-space indicator table.
7. `docs/methodology/indicator-sources.yaml:521` — add new entry.
8. `tests/resilience-debt-sustainability-gap.test.mts` — NEW, formula unit tests.
9. `tests/seed-recovery-fiscal-space.test.mts` — NEW, seeder contract test.
10. `tests/resilience-fiscal-space.test.mts` — NEW, scorer integration tests.

---

## Policy decisions (LOCKED 2026-05-12 by user)

1. **Goalpost calibration**: `worst=-5 / best=+3` ✅ — DSA-distress envelope, score 50 ≈ debt-stabilizing point.
2. **Inflation cap**: `INFLATION_GAP_CAP_PCT = 25` ✅ — Turkey 2024 (~65%), Argentina, Lebanon, Venezuela excluded from gap indicator. Fiscal-3 still scores them.
3. **Weights inside fiscalSpace**: `recoveryGovRevenue 0.25 / recoveryFiscalBalance 0.20 / recoveryDebtToGdp 0.20 / debtSustainabilityGap 0.35` ✅ — gap is largest single slice; other three are co-signals.
4. **Backtest acceptance threshold**: `≤10 countries shifting >±5 ranks` in the `economy` pillar ✅ (plan default — user did not override).

All four are pinned. `/ce-work` should not re-ask.

---

## Review history

| Round | Verdict | Findings | Key changes after this round |
|---|---|---|---|
| 1 | REVISE | 2× P0 + 3× P1 + 2× P2 = 7 | France math redone end-to-end; two-floor validate; year alignment via `latestCommonYear`; gap moved to seed-time computation for backtest-harness compat; standard `((r−g)/(1+g))·d` formula; compounded `(1+real)(1+infl)−1` growth; docs files added; one-PR rollout |
| 2 | REVISE | 3× P1 + 2× P2 = 5 | Year-alignment bug fixed in pseudocode (all 5 formula inputs read at commonYear); revenue dropped from common-year input set; correct `EXTRACTION_RULES` shape `{type:'recovery-country-field', key, field}`; pure exported helpers replace ESM mocking; explicit two-failure-mode validation semantics |
| 3 | REVISE | 2× P1 + 2× P2 = 4 | `allIso3` defined as fiscal-3 union with skip guard preserved; test fixture expanded to 6 cases separating "one field missing → emit" from "all fiscal-3 missing → skip"; formula test param names corrected to match helper signature; post-deploy verification rewritten to Redis + backtest (not API response shape) |
| 4 | **APPROVED** | 1× non-blocking nit | Export `FISCAL_SPACE_VALIDATION_FLOORS` constant for direct test assertion (incorporated into this final draft) |
