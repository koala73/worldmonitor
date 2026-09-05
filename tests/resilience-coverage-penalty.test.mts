// Plan 2026-04-26-002 §U4 (combined PR 3+4+5) — pinning tests for the
// imputed-dim coverage penalty in `coverageWeightedMean`.
//
// The penalty halves the effective weight of any dim with a non-empty
// `imputationClass` (i.e., the scorer set the class because the dim has
// no observed data).
//
// These asserted against a local mirror of the formula whose stated
// detection mechanism was a reviewer noticing the mirror and the real
// function disagree. It had already drifted: the mirror read a per-dim
// `weight` field, while the real function looks the weight up in
// RESILIENCE_DIMENSION_WEIGHTS by dimension id. They now call the real
// function through the module's testing export.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { __testing__ } from '../server/worldmonitor/resilience/v1/_shared.ts';

const { coverageWeightedMean, IMPUTED_DIM_WEIGHT_FACTOR } = __testing__;

/** A dimension carrying only the fields coverageWeightedMean reads. */
function dim(id: string, score: number, coverage: number, imputationClass = '') {
  return { id, score, coverage, imputationClass } as never;
}

describe('coverage penalty for imputed dims (Plan 2026-04-26-002 §U4)', () => {
  it('halves the weight of an imputed dim', () => {
    assert.equal(IMPUTED_DIM_WEIGHT_FACTOR, 0.5);
  });

  it('observed-only dims behave like the v15 coverage-weighted mean (no penalty)', () => {
    const dims = [dim('macroFiscal', 80, 1.0), dim('cyberDigital', 60, 1.0)];
    // both weight 1.0, both fully covered: (80 + 60) / 2 = 70.
    assert.equal(coverageWeightedMean(dims), 70);
  });

  it('half-imputed dim contributes half-weight, lifting the mean toward observed dims', () => {
    // Pre-§U4: mean = (85 + 60) / 2 = 72.5.
    // Post-§U4: mean = (85*0.5 + 60*1.0) / (0.5 + 1.0) = 68.33.
    const dims = [
      dim('macroFiscal', 85, 1.0, 'stable-absence'),
      dim('cyberDigital', 60, 1.0),
    ];
    const result = coverageWeightedMean(dims);
    assert.ok(Math.abs(result - 68.333) < 0.01, `expected ~68.33 (imputed at 0.5 weight), got ${result}`);
  });

  it('low-scoring imputed dim at half weight lifts the mean (less drag)', () => {
    // Pre-§U4: (50*0.3 + 80*1.0) / (0.3 + 1.0) ≈ 73.08
    // Post-§U4: (50*0.15 + 80*1.0) / (0.15 + 1.0) ≈ 76.09
    const dims = [
      dim('macroFiscal', 50, 0.3, 'unmonitored'),
      dim('cyberDigital', 80, 1.0),
    ];
    const result = coverageWeightedMean(dims);
    assert.ok(result > 75 && result < 77, `expected ~76.09 (imputed drag halved → mean lifted), got ${result}`);
  });

  it('all-imputed dim list: penalty cancels in the ratio (mean unchanged from v15)', () => {
    // Halving every weight cancels in the ratio, so the penalty only shifts
    // the mean when observed and imputed dims are mixed.
    const imputed = [
      dim('macroFiscal', 85, 0.7, 'stable-absence'),
      dim('cyberDigital', 50, 0.3, 'unmonitored'),
    ];
    const asV15 = [dim('macroFiscal', 85, 0.7), dim('cyberDigital', 50, 0.3)];
    const v16 = coverageWeightedMean(imputed);
    const v15 = coverageWeightedMean(asV15);
    assert.ok(Math.abs(v16 - v15) < 0.001, `pure-imputed dim list should be invariant under §U4 (v15=${v15}, v16=${v16})`);
  });

  it('zero-coverage dims contribute zero regardless of imputation factor', () => {
    // Retired dims carry coverage=0 and must be neutralized either way.
    const dims = [
      dim('reserveAdequacy', 0, 0),
      dim('fuelStockDays', 0, 0, 'unmonitored'),
      dim('cyberDigital', 70, 1.0),
    ];
    assert.equal(coverageWeightedMean(dims), 70);
  });

  it('empty dim list returns 0 (no division-by-zero)', () => {
    assert.equal(coverageWeightedMean([]), 0);
  });

  it('reads the per-dim weight from the canonical table, not from the dim', () => {
    // liquidReserveAdequacy is 0.5 in RESILIENCE_DIMENSION_WEIGHTS and also
    // imputed here, so its effective weight is coverage * 0.5 * 0.5.
    // weighted = 90*1*1*1 + 50*0.3*0.5*0.5 = 93.75
    // totalW   = 1*1*1 + 0.3*0.5*0.5 = 1.075  →  ≈ 87.21
    const dims = [
      dim('macroFiscal', 90, 1.0),
      dim('liquidReserveAdequacy', 50, 0.3, 'unmonitored'),
    ];
    const result = coverageWeightedMean(dims);
    assert.ok(Math.abs(result - 87.21) < 0.01, `expected ~87.21 (table weight × imputation factor compose), got ${result}`);

    // A weight field on the dim itself is ignored, so the same ids give the
    // same answer whatever the caller attaches.
    const withStrayWeight = [
      { ...dim('macroFiscal', 90, 1.0), weight: 0.1 },
      { ...dim('liquidReserveAdequacy', 50, 0.3, 'unmonitored'), weight: 9 },
    ] as never[];
    assert.equal(coverageWeightedMean(withStrayWeight), result);
  });
});
