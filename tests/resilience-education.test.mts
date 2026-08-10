// Pin the `education` dimension's normalization transform.
//
// Indicator: SE.SEC.CUAT.UP.FE.ZS — female upper-secondary attainment, 25+.
// Construct: the "Education" section of docs/methodology/country-resilience-index.mdx
//
// The construct contract requires a threshold or saturating transform for
// development-adjacent indicators, so the score rewards functional capacity
// rather than affluence. But the measured distribution does NOT saturate:
// across the 181 covered countries the median is 50.0, the deciles are close
// to uniform, and only 1.7% exceed 95% (against adult literacy's 42%). A log
// or logistic squash would destroy discrimination in the 20-80 band where
// two-thirds of the universe lives.
//
// The resolution is a two-segment piecewise-linear map with a slope drop at
// 85. Decreasing slope is concave, which satisfies the contract, while the
// first segment stays linear across the band that actually holds countries.
// The bend affects 22 of 181 countries (12.2%).
//
// These tests assert the MECHANISM on synthetic inputs. They deliberately do
// not encode "country A outranks country B" — that fits the construct to an
// expected answer rather than testing it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeEducationAttainment,
  EDUCATION_BEND,
  EDUCATION_BEND_SCORE,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.js';

describe('normalizeEducationAttainment — anchors', () => {
  it('maps the goalposts to the full score range', () => {
    assert.equal(normalizeEducationAttainment(0), 0);
    assert.equal(normalizeEducationAttainment(100), 100);
  });

  it('maps the bend to the bend score', () => {
    assert.equal(normalizeEducationAttainment(EDUCATION_BEND), EDUCATION_BEND_SCORE);
  });

  it('places the observed distribution extremes inside the range', () => {
    // Measured min (Niger 1.15) and max (Belarus 98.18). Neither may clip:
    // fixed 0/100 anchors exist so no observed country sits at a goalpost.
    const lo = normalizeEducationAttainment(1.15);
    const hi = normalizeEducationAttainment(98.18);
    assert.ok(lo > 0, 'observed minimum must not floor at 0');
    assert.ok(hi < 100, 'observed maximum must not ceiling at 100');
  });
});

describe('normalizeEducationAttainment — monotonicity', () => {
  it('is strictly increasing across the observed range', () => {
    const samples = [1.15, 5, 12, 20, 35, 50, 65, 76, 85, 90, 95, 98.18];
    for (let i = 1; i < samples.length; i++) {
      const prev = normalizeEducationAttainment(samples[i - 1]);
      const cur = normalizeEducationAttainment(samples[i]);
      assert.ok(cur > prev, `score must increase from ${samples[i - 1]} to ${samples[i]} (${prev} -> ${cur})`);
    }
  });

  it('rewards more schooling at every decile boundary', () => {
    for (let v = 0; v < 100; v += 10) {
      assert.ok(
        normalizeEducationAttainment(v + 10) > normalizeEducationAttainment(v),
        `decile ${v} -> ${v + 10} must increase`,
      );
    }
  });
});

describe('normalizeEducationAttainment — the bend is real', () => {
  it('yields materially less score per point above the bend', () => {
    // Equal 13-point input spans on either side of the bend.
    const below = normalizeEducationAttainment(85) - normalizeEducationAttainment(72);
    const above = normalizeEducationAttainment(98) - normalizeEducationAttainment(85);
    assert.ok(above < below, `top band must compress (${above} vs ${below})`);
    assert.ok(above * 1.5 < below, 'compression must be material, not marginal');
  });

  it('is continuous at the bend — no cliff', () => {
    const justBelow = normalizeEducationAttainment(EDUCATION_BEND - 0.5);
    const at = normalizeEducationAttainment(EDUCATION_BEND);
    const justAbove = normalizeEducationAttainment(EDUCATION_BEND + 0.5);
    assert.ok(at - justBelow <= 2, 'no discontinuity approaching the bend from below');
    assert.ok(justAbove - at <= 2, 'no discontinuity leaving the bend from above');
  });

  it('does not invert or plateau above the bend', () => {
    // Concave must still mean increasing. A flat top would make the 22
    // countries above the bend indistinguishable from each other.
    assert.ok(normalizeEducationAttainment(100) > normalizeEducationAttainment(90));
    assert.ok(normalizeEducationAttainment(90) > normalizeEducationAttainment(86));
  });

  it('keeps discrimination in the 20-80 band where two-thirds of countries sit', () => {
    // A saturating transform would compress this band. The span from p25
    // (19.5) to p75 (76.1) must stay wide.
    const span = normalizeEducationAttainment(76.1) - normalizeEducationAttainment(19.5);
    assert.ok(span > 50, `interquartile span must stay wide, got ${span}`);
  });
});

describe('normalizeEducationAttainment — boundary handling', () => {
  it('clamps out-of-range input rather than extrapolating', () => {
    assert.equal(normalizeEducationAttainment(120), 100);
    assert.equal(normalizeEducationAttainment(-5), 0);
  });

  it('returns null for a missing reading so the blend drops the slot', () => {
    // Returning 0 would score an unsurveyed country as the worst on earth.
    assert.equal(normalizeEducationAttainment(null), null);
    assert.equal(normalizeEducationAttainment(undefined), null);
    assert.equal(normalizeEducationAttainment(Number.NaN), null);
  });
});
