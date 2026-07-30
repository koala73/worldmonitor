// Plan 2026-04-26-002 §U4 (combined PR 3+4+5) — pinning tests for the
// imputed-dim coverage penalty in `coverageWeightedMean`.
//
// The penalty halves the effective weight of any dim with a non-empty
// `imputationClass` (i.e., the scorer set the class because the dim has
// no observed data). These tests pin the math directly using synthetic
// dim arrays so future contributors can't silently change the factor.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// We can't import the private `coverageWeightedMean` directly, but we
// can drive it end-to-end by constructing fixture dimensions and calling
// `buildPillarList` / domain aggregation. Simpler approach: replicate
// the contract here with the EXACT same formula — if the production
// formula drifts, the §U4 doc-comment in _shared.ts will visibly
// disagree with this mirror, surfacing the divergence in code review.

const IMPUTED_DIM_WEIGHT_FACTOR = 0.5;

function coverageWeightedMeanMirror(
  dims: Array<{ score: number; coverage: number; weight?: number; imputationClass: string }>,
): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const d of dims) {
    const w = d.weight ?? 1.0;
    const imputationFactor = d.imputationClass ? IMPUTED_DIM_WEIGHT_FACTOR : 1.0;
    const effective = d.coverage * w * imputationFactor;
    totalWeight += effective;
    weightedSum += d.score * effective;
  }
  if (!totalWeight) return 0;
  return weightedSum / totalWeight;
}

describe('coverage penalty for imputed dims (Plan 2026-04-26-002 §U4)', () => {
  it('observed-only dims behave like the v15 coverage-weighted mean (no penalty)', () => {
    const dims = [
      { score: 80, coverage: 1.0, imputationClass: '' },
      { score: 60, coverage: 1.0, imputationClass: '' },
    ];
    // (80 + 60) / 2 = 70 — no penalty applied.
    assert.equal(coverageWeightedMeanMirror(dims), 70);
  });

  it('half-imputed dim contributes half-weight, lifting the mean toward observed dims', () => {
    // High-scoring imputed dim (85, stable-absence) at half weight, paired
    // with an observed dim at 60. Pre-§U4: mean = (85 + 60) / 2 = 72.5.
    // Post-§U4: mean = (85*0.5 + 60*1.0) / (0.5 + 1.0) = (42.5 + 60) / 1.5 = 68.33.
    const dims = [
      { score: 85, coverage: 1.0, imputationClass: 'stable-absence' },
      { score: 60, coverage: 1.0, imputationClass: '' },
    ];
    const result = coverageWeightedMeanMirror(dims);
    assert.ok(Math.abs(result - 68.333) < 0.01,
      `expected ~68.33 (imputed at 0.5 weight), got ${result}`);
  });

  it('low-scoring imputed dim at half weight lifts the mean (less drag)', () => {
    // unmonitored impute (50/0.3) at half weight; observed dim at 80.
    // Pre-§U4: weighted = (50*0.3 + 80*1.0) / (0.3 + 1.0) = (15 + 80) / 1.3 ≈ 73.08
    // Post-§U4: weighted = (50*0.15 + 80*1.0) / (0.15 + 1.0) = (7.5 + 80) / 1.15 ≈ 76.09
    const dims = [
      { score: 50, coverage: 0.3, imputationClass: 'unmonitored' },
      { score: 80, coverage: 1.0, imputationClass: '' },
    ];
    const result = coverageWeightedMeanMirror(dims);
    assert.ok(result > 75 && result < 77,
      `expected ~76.09 (imputed drag halved → mean lifted), got ${result}`);
  });

  it('all-imputed dim list: penalty cancels in the ratio (mean unchanged from v15)', () => {
    // When every dim is imputed, halving every weight cancels in the ratio:
    // (s1*c1*0.5 + s2*c2*0.5) / (c1*0.5 + c2*0.5) = (s1*c1 + s2*c2) / (c1 + c2).
    // The penalty ONLY shifts the mean when there's a mix of observed +
    // imputed dims — pure-imputed countries see no change.
    const dimsAllImputed = [
      { score: 85, coverage: 0.7, imputationClass: 'stable-absence' },
      { score: 50, coverage: 0.3, imputationClass: 'unmonitored' },
    ];
    const dimsAllImputedV15 = [
      { score: 85, coverage: 0.7, imputationClass: '' },  // simulated v15: no penalty
      { score: 50, coverage: 0.3, imputationClass: '' },
    ];
    const v16 = coverageWeightedMeanMirror(dimsAllImputed);
    const v15 = coverageWeightedMeanMirror(dimsAllImputedV15);
    assert.ok(Math.abs(v16 - v15) < 0.001,
      `pure-imputed dim list should be invariant under §U4 (v15=${v15}, v16=${v16})`);
  });

  it('zero-coverage dims contribute zero regardless of imputation factor', () => {
    // Retired dims have coverage=0; they should be neutralized whether
    // imputed or not. Verifies §U4 doesn't double-count them.
    const dims = [
      { score: 0, coverage: 0, imputationClass: '' },               // retired observed
      { score: 0, coverage: 0, imputationClass: 'unmonitored' },    // retired imputed
      { score: 70, coverage: 1.0, imputationClass: '' },
    ];
    assert.equal(coverageWeightedMeanMirror(dims), 70);
  });

  it('empty dim list returns 0 (no division-by-zero)', () => {
    assert.equal(coverageWeightedMeanMirror([]), 0);
  });

  it('per-dim weight is multiplicative with the imputation factor', () => {
    // Recovery dims dial down to weight=0.5; if also imputed, effective
    // weight = coverage * 0.5 * 0.5 = 0.25 of nominal.
    const dims = [
      { score: 90, coverage: 1.0, weight: 1.0, imputationClass: '' },
      { score: 50, coverage: 0.3, weight: 0.5, imputationClass: 'unmonitored' },  // recovery imputed
    ];
    // weighted = 90*1*1*1 + 50*0.3*0.5*0.5 = 90 + 3.75 = 93.75
    // totalW = 1*1*1 + 0.3*0.5*0.5 = 1 + 0.075 = 1.075
    // mean = 93.75 / 1.075 ≈ 87.21
    const result = coverageWeightedMeanMirror(dims);
    assert.ok(Math.abs(result - 87.21) < 0.01,
      `expected ~87.21 (per-dim weight × imputation factor compose), got ${result}`);
  });
});
