import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  RESILIENCE_DIMENSION_DOMAINS,
  getResilienceDomainWeight,
  type ResilienceDimensionId,
  type ResilienceDomainId,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// PR 3 §3.6 — Coverage-and-influence cap on indicator weight.
//
// Rule (plan §3.6, verbatim):
//   No indicator with observed coverage below 70% may exceed 5% nominal
//   weight OR 5% effective influence in the post-change sensitivity run.
//
// This file enforces the NOMINAL-WEIGHT half (static, runs every build).
// The effective-influence half is checked by the variable-importance
// output of scripts/validate-resilience-sensitivity.mjs and committed as
// an artifact; see plan §5 acceptance-criteria item 9.
//
// Why the gate exists (plan §3.6):
//   "A dimension at 30% observed coverage carries the same effective
//   weight as one at 95%. This contradicts the OECD/JRC handbook on
//   uncertainty analysis."
//
// Assumption: the global universe is ~195 countries (UN members + a few
// territories commonly ranked). "70% coverage" → 137+ countries.

const GLOBAL_COUNTRY_UNIVERSE = 195;
const COVERAGE_FLOOR = Math.ceil(GLOBAL_COUNTRY_UNIVERSE * 0.7); // 137
const NOMINAL_WEIGHT_CAP = 0.05; // 5%

// Nominal overall weight of an indicator = weight in dimension
//   × dimension share of domain
//   × domain weight in overall score.
//
// `dimension share of domain` is NOT 1/N_total — the scorer aggregates
// by coverage-weighted mean (server/worldmonitor/resilience/v1/_shared.ts
// coverageWeightedMean), so a dimension that pins at coverage=0 drops
// out of the denominator and the surviving dimensions' shares go UP,
// not down. PR 3 commit 1 retires fuelStockDays by pinning its scorer
// at coverage=0 for every country — so in the current live state the
// recovery domain has 5 contributing dimensions (not 6), and each core
// recovery indicator's nominal share is 1/5 × 0.25 = 5%, not the
// 1/6 × 0.25 = 4.17% a naive N-based count would report.
//
// We therefore count "effective contributing dimensions" per domain:
// dimensions that have at least one tier='core' indicator in the
// registry. A dimension with only experimental/enrichment indicators
// (e.g. fuelStockDays, post-retirement) scores coverage=0 in the core
// path and is excluded from the coverage-weighted domain mean, so it
// does not dilute the core dimensions' shares.
//
// This still under-estimates the WORST case — a live source-failure
// run can drop a usually-contributing dimension to coverage=0, further
// raising surviving dimensions' shares. The worst-case upper bound is
// indicator.weight × domain_weight (single surviving dimension, 1/1
// share). Enforcing THAT bound would fail most indicators, so we
// enforce the baseline (all core-bearing dimensions present) here and
// rely on the sensitivity-script's effective-influence output (plan
// §3.6 second half, plan §5 acceptance item 9) to catch the dynamic
// case.
//
// Indicator weights within a dimension are normalized to sum to 1 for
// non-experimental tiers (enforced by the indicator-registry test).

function dimensionsInDomain(domainId: ResilienceDomainId): ResilienceDimensionId[] {
  return (Object.keys(RESILIENCE_DIMENSION_DOMAINS) as ResilienceDimensionId[])
    .filter((dimId) => RESILIENCE_DIMENSION_DOMAINS[dimId] === domainId);
}

function coreBearingDimensions(domainId: ResilienceDomainId): Set<ResilienceDimensionId> {
  const dimsInDomain = new Set(dimensionsInDomain(domainId));
  const withCore = new Set<ResilienceDimensionId>();
  for (const entry of INDICATOR_REGISTRY) {
    if (entry.tier === 'core' && dimsInDomain.has(entry.dimension)) {
      withCore.add(entry.dimension);
    }
  }
  return withCore;
}

function nominalOverallWeight(indicator: typeof INDICATOR_REGISTRY[number]): number {
  const domainId = RESILIENCE_DIMENSION_DOMAINS[indicator.dimension];
  if (domainId == null) return 0;
  const domainWeight = getResilienceDomainWeight(domainId);
  // Count only dimensions that have ≥1 core indicator — retired or
  // all-experimental dimensions contribute coverage=0 to the scorer and
  // are excluded from the coverage-weighted domain mean.
  const contributing = coreBearingDimensions(domainId).size;
  const dimensionShare = contributing > 0 ? 1 / contributing : 0;
  return indicator.weight * dimensionShare * domainWeight;
}

describe('resilience coverage-and-influence gate (PR 3 §3.6)', () => {
  it('no indicator with <70% country coverage carries >5% nominal weight in the overall score', () => {
    const violations = INDICATOR_REGISTRY
      // Only core indicators contribute to the overall (public) score.
      // Enrichment and experimental are drill-down-only, so their
      // nominal-weight-in-overall is 0 regardless of registry weight.
      .filter((e) => e.tier === 'core')
      .filter((e) => e.coverage < COVERAGE_FLOOR)
      .map((e) => ({
        id: e.id,
        dimension: e.dimension,
        coverage: e.coverage,
        weight: e.weight,
        nominalOverall: Number(nominalOverallWeight(e).toFixed(4)),
      }))
      .filter((v) => v.nominalOverall > NOMINAL_WEIGHT_CAP);

    assert.deepEqual(
      violations,
      [],
      `Indicators below ${COVERAGE_FLOOR}-country coverage floor with nominal overall weight > ${NOMINAL_WEIGHT_CAP * 100}%:\n${
        violations.map((v) => `  - ${v.id} (dim=${v.dimension}, coverage=${v.coverage}, nominal=${(v.nominalOverall * 100).toFixed(2)}%)`).join('\n')
      }\n\nFix options:\n  1. Demote to enrichment or experimental tier.\n  2. Lower the indicator's weight within its dimension.\n  3. Improve coverage to ≥${COVERAGE_FLOOR} countries.`,
    );
  });

  it('effective-influence artifact reference exists (sensitivity-script contract)', () => {
    // The plan (§3.6, §5 item 9) requires post-change variable-importance
    // to confirm the nominal-weight gate is not violated in the dynamic
    // (variance-explained) dimension either. That artifact is produced
    // by scripts/validate-resilience-sensitivity.mjs and not re-computed
    // here (it requires seeded Redis). This test only asserts the gate
    // script exists, so removing it via refactor breaks the build.
    const here = dirname(fileURLToPath(import.meta.url));
    const sensScript = join(here, '..', 'scripts', 'validate-resilience-sensitivity.mjs');
    assert.ok(existsSync(sensScript),
      `plan §3.6 effective-influence half is enforced by ${sensScript} — file is missing`);
  });

  it('retired dimensions (coverage=0 for every country) do not count in the per-domain share denominator', () => {
    // Regression guard for the §3.6 gate math. When PR 3 commit 1
    // pinned fuelStockDays at coverage=0, the coverage-weighted domain
    // aggregation raised the surviving recovery dimensions' shares from
    // 1/6 to 1/5. Any gate that uses 1/N_total as the divisor will
    // under-report nominal influence and can silently pass a regression
    // that drives a low-coverage indicator above the 5% cap.
    //
    // This test asserts the helper correctly excludes all-experimental
    // dimensions from the share denominator.
    const recoveryDimsTotal = dimensionsInDomain('recovery').length;
    const recoveryCoreBearing = coreBearingDimensions('recovery').size;
    assert.ok(recoveryCoreBearing < recoveryDimsTotal,
      `expected at least one recovery dimension to be all-non-core (post-fuelStockDays-retirement); got ${recoveryCoreBearing}/${recoveryDimsTotal}. If this flips, the fuelStockDays retirement was reverted and §3.6 math assumptions need review.`);

    // Explicit: fuelStockDays is the dimension we retired. Confirm it
    // has zero core indicators.
    const fuelStockCoreCount = INDICATOR_REGISTRY.filter(
      (e) => e.dimension === 'fuelStockDays' && e.tier === 'core',
    ).length;
    assert.equal(fuelStockCoreCount, 0,
      'fuelStockDays must have zero core indicators post-PR 3 §3.5 retirement. If this fails, un-retire must be intentional + the gate math reviewed.');

    // And the recovery-domain core indicators should each compute 5%
    // under the corrected formula (1.0 × 1/5 × 0.25), not 4.17%.
    const debtToReserves = INDICATOR_REGISTRY.find((e) => e.id === 'recoveryDebtToReserves');
    assert.ok(debtToReserves != null, 'recoveryDebtToReserves must exist');
    const computed = nominalOverallWeight(debtToReserves!);
    // 0.05 exactly, allow fp wiggle
    assert.ok(Math.abs(computed - 0.05) < 1e-9,
      `recoveryDebtToReserves nominal weight should be 0.05 (1.0 × 1/5 × 0.25) post-retirement; got ${computed}. If this is 0.0417, the share denominator is using 1/6 instead of 1/5 — fuelStockDays retirement is not being excluded.`);
  });

  it('reports the current nominal-weight distribution for audit', () => {
    // Visibility-only (no assertion beyond "ran cleanly"). The output
    // lets reviewers eyeball the distribution and spot outliers that
    // technically pass (coverage ≥ floor) but still carry unusually
    // high weight for a narrow construct.
    const ranked = INDICATOR_REGISTRY
      .filter((e) => e.tier === 'core')
      .map((e) => ({
        id: e.id,
        nominalOverall: Number((nominalOverallWeight(e) * 100).toFixed(2)),
        coverage: e.coverage,
      }))
      .sort((a, b) => b.nominalOverall - a.nominalOverall)
      .slice(0, 10);
    if (ranked.length > 0) {
      console.warn('[PR 3 §3.6] top 10 core indicators by nominal overall weight:');
      for (const r of ranked) {
        console.warn(`  ${r.id}: nominal=${r.nominalOverall}%  coverage=${r.coverage}`);
      }
    }
    assert.ok(ranked.length > 0, 'expected at least one core indicator');
  });
});
