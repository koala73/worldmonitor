import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { baseRateProbability } from '../scripts/_bet-baserate.mjs';

describe('baseRateProbability', () => {
  it('estimates an upward-move frequency with Laplace smoothing', () => {
    // baseline 100, threshold 102 → requiredDelta +2. Steps: +3,+1,+5,-2,+4 → 3 of 5 cross.
    const series = [100, 103, 104, 109, 107, 111];
    const { probability, method, n, crossed } = baseRateProbability(series, {
      baselineValue: 100, threshold: 102,
    });
    assert.equal(method, 'empirical_move_frequency');
    assert.equal(n, 5);
    assert.equal(crossed, 3);
    // (3 + 1) / (5 + 1 + 1) = 4/7
    assert.equal(probability, 0.571429);
  });

  it('handles a downward bet via the sign of required delta', () => {
    // baseline 50, threshold 48 → requiredDelta -2. Steps: -3,-1,-5,+2,-4 → deltas<=-2: -3,-5,-4 = 3.
    const series = [50, 47, 46, 41, 43, 39];
    const { crossed, n, probability } = baseRateProbability(series, {
      baselineValue: 50, threshold: 48,
    });
    assert.equal(n, 5);
    assert.equal(crossed, 3);
    assert.equal(probability, 0.571429);
  });

  it('never emits a hard 0 or 1 even at the extremes', () => {
    const never = baseRateProbability([10, 10, 10, 10], { baselineValue: 10, threshold: 1000 });
    assert.ok(never.probability > 0 && never.probability < 0.5, `got ${never.probability}`);
    const always = baseRateProbability([10, 30, 60, 100], { baselineValue: 10, threshold: 11 });
    assert.ok(always.probability > 0.5 && always.probability < 1, `got ${always.probability}`);
  });

  it('falls back to a soft directional prior when history is too thin', () => {
    const r = baseRateProbability([100], { baselineValue: 100, threshold: 105 });
    assert.equal(r.method, 'prior_directional');
    assert.equal(r.n, 0);
    assert.equal(r.probability, 0.4);
  });

  it('returns a neutral prior when the spec has no usable threshold', () => {
    const r = baseRateProbability([1, 2, 3], { baselineValue: 3 });
    assert.equal(r.method, 'prior');
    assert.equal(r.probability, 0.5);
  });
});
