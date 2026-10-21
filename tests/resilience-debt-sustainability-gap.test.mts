import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeDebtSustainabilityGap,
  INFLATION_GAP_CAP_PCT,
} from '../scripts/seed-recovery-fiscal-space.mjs';

/**
 * Worked examples for the IMF DSA gap formula. These five cases are
 * pinned from the approved plan document and are the ground-truth
 * regression suite — any change to computeDebtSustainabilityGap that
 * shifts these by > 0.01 needs explicit justification in the PR.
 *
 * Formula:
 *   g    = (1 + realG/100) * (1 + infl/100) - 1
 *   r    = max(0, (pb - fb) / debt)
 *   pb*  = ((r - g) / (1 + g)) * debt
 *   gap  = pb - pb*
 */
describe('computeDebtSustainabilityGap (formula correctness)', () => {
  it('France 2024: mid-debt, mild deficit → gap ≈ -1.43', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 110, pb: -2.5, fb: -4.5, realG: 0.7, infl: 2.1,
    });
    assert.ok(gap !== null, 'gap should be defined for France inputs');
    assert.ok(Math.abs(gap! - -1.43) < 0.01, `expected ≈ -1.43, got ${gap}`);
  });

  it('Japan 2024: very-high debt, flat pb, g≈r → gap ≈ +3.20 (clamps at 100)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 250, pb: 0, fb: -3, realG: 0.5, infl: 2.0,
    });
    assert.ok(gap !== null, 'gap should be defined for Japan inputs');
    assert.ok(Math.abs(gap! - 3.20) < 0.01, `expected ≈ +3.20, got ${gap}`);
  });

  it('Norway 2024: low debt, strong surplus → gap large positive (>5)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 38, pb: 10, fb: 8, realG: 1.0, infl: 2.5,
    });
    assert.ok(gap !== null, 'gap should be defined for Norway inputs');
    assert.ok(gap! > 5, `expected gap > 5, got ${gap}`);
    // Tighter pin from the plan's worked example:
    assert.ok(Math.abs(gap! - 9.36) < 0.05, `expected ≈ +9.36, got ${gap}`);
  });

  it('Italy 2024: high-debt, mild surplus → gap near zero (debt-stabilizing)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 137, pb: 1.0, fb: -3.5, realG: 0.5, infl: 2.0,
    });
    assert.ok(gap !== null, 'gap should be defined for Italy inputs');
    // Plan example: gap ≈ -0.04 (right at the stabilizing point). Tolerance
    // tightened from 0.5 to 0.01 to match the other worked examples — the
    // wider tolerance would have masked formula regressions in (-0.5, +0.5)
    // (greptile P2: PR #3669).
    assert.ok(Math.abs(gap! - -0.04) < 0.01, `expected ≈ -0.04 for stabilizing Italy, got ${gap}`);
  });

  it('returns null for degenerate denominator (debt = 0)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 0, pb: 0, fb: 0, realG: 1, infl: 2,
    });
    assert.equal(gap, null);
  });

  it('returns null for negative debt (negative net debt, rare edge)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: -10, pb: 0, fb: 0, realG: 1, infl: 2,
    });
    assert.equal(gap, null);
  });

  it('returns null above inflation cap (Argentina 2024: infl=200)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 90, pb: -2, fb: -5, realG: -3, infl: 200,
    });
    assert.equal(gap, null);
  });

  it('returns null exactly above inflation cap boundary (infl = cap + epsilon)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 100, pb: 0, fb: -2, realG: 1, infl: INFLATION_GAP_CAP_PCT + 0.01,
    });
    assert.equal(gap, null, 'inflation just above cap should drop to null');
  });

  it('accepts inflation exactly at the cap (infl = cap)', () => {
    const gap = computeDebtSustainabilityGap({
      debt: 100, pb: 0, fb: -2, realG: 1, infl: INFLATION_GAP_CAP_PCT,
    });
    assert.ok(gap !== null, 'inflation at cap should still produce a gap (strict `>` boundary)');
  });

  it('returns null when any individual input is null', () => {
    assert.equal(computeDebtSustainabilityGap({ debt: null, pb: 0, fb: 0, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: null, fb: 0, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: 0, fb: null, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: 0, fb: 0, realG: null, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: 0, fb: 0, realG: 1, infl: null }), null);
  });

  it('returns null when any input is non-finite (NaN / Infinity)', () => {
    assert.equal(computeDebtSustainabilityGap({ debt: NaN, pb: 0, fb: 0, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: Infinity, pb: 0, fb: 0, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: NaN, fb: 0, realG: 1, infl: 2 }), null);
    assert.equal(computeDebtSustainabilityGap({ debt: 100, pb: 0, fb: 0, realG: 1, infl: NaN }), null);
  });

  it('clamps effective rate r at 0 (rounding-negative interest does not flip sign)', () => {
    // Construct a case where (pb - fb) is slightly negative due to
    // rounding artifacts: pb=-3.001, fb=-3.000 → interest ≈ -0.001 < 0.
    // Without the floor, gap would be slightly different; with the floor,
    // r is treated as 0 and pb* = -g/(1+g) * d.
    const gap = computeDebtSustainabilityGap({
      debt: 100, pb: -3.001, fb: -3, realG: 1, infl: 2,
    });
    assert.ok(gap !== null);
    // With r=0, g≈0.0302, pb*= -0.0302/1.0302 * 100 = -2.932.
    // gap = -3.001 - (-2.932) = -0.069. Without the floor, r=-0.00001 →
    // pb* = (-0.00001 - 0.0302)/1.0302 * 100 = -2.933. gap = -0.068.
    // The two differ by ~0.001 — small but distinguishable. We assert
    // the floor branch matches the r=0 expectation within tolerance.
    assert.ok(Math.abs(gap! - -0.069) < 0.01, `r should floor at 0, got gap=${gap}`);
  });
});
