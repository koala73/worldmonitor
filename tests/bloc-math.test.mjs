import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  logReturns,
  alignReturns,
  fitTwoLeg,
  computeLean,
  abnormalReturns,
  stdev,
  scoreCountry,
} from '../scripts/_bloc-math.mjs';

// Deterministic pseudo-noise so the tests never flake.
function lcg(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
}

function seriesFrom(returns, start = 100) {
  const ts = [], px = [];
  let p = start;
  for (let i = 0; i < returns.length; i++) {
    ts.push(1700000000 + i * 86400);
    px.push(p);
    p *= Math.exp(returns[i]);
  }
  ts.push(1700000000 + returns.length * 86400);
  px.push(p);
  return { ts, px };
}

describe('logReturns', () => {
  it('produces n-1 returns keyed by the later timestamp', () => {
    const r = logReturns([1, 2, 3], [100, 110, 121]);
    assert.equal(r.size, 2);
    assert.ok(Math.abs(r.get(2) - Math.log(1.1)) < 1e-12);
    assert.ok(Math.abs(r.get(3) - Math.log(1.1)) < 1e-12);
  });

  it('drops non-positive and non-numeric prices instead of fabricating a return', () => {
    const r = logReturns([1, 2, 3, 4], [100, 0, 110, null]);
    assert.equal(r.size, 0);
  });
});

describe('alignReturns', () => {
  it('inner-joins on shared timestamps only', () => {
    const a = new Map([[1, 0.1], [2, 0.2], [3, 0.3]]);
    const b = new Map([[2, 0.9], [3, 0.8], [4, 0.7]]);
    const { keys, series } = alignReturns([a, b]);
    assert.deepEqual(keys, [2, 3]);
    assert.deepEqual(series[0], [0.2, 0.3]);
    assert.deepEqual(series[1], [0.9, 0.8]);
  });

  it('never pads a missing session', () => {
    const a = new Map([[1, 0.1]]);
    const b = new Map([[2, 0.2]]);
    assert.deepEqual(alignReturns([a, b]).keys, []);
  });
});

describe('fitTwoLeg', () => {
  it('recovers known coefficients from a clean construction', () => {
    const rnd = lcg(7);
    const x1 = [], x2 = [], y = [];
    for (let i = 0; i < 200; i++) {
      const a = rnd() * 0.02;
      const b = rnd() * 0.02;
      x1.push(a); x2.push(b);
      y.push(0.0001 + 1.5 * a + 0.4 * b);
    }
    const fit = fitTwoLeg(y, x1, x2);
    assert.ok(Math.abs(fit.betaUs - 1.5) < 1e-6, `betaUs=${fit.betaUs}`);
    assert.ok(Math.abs(fit.betaCn - 0.4) < 1e-6, `betaCn=${fit.betaCn}`);
    assert.ok(fit.r2 > 0.99);
    assert.equal(fit.obs, 200);
  });

  it('separates the legs where two single-leg fits would not', () => {
    // Both legs share a large common factor; the country loads ONLY on the
    // China-specific part. A naive single-leg fit vs the US leg would still
    // report a big positive slope from the shared factor.
    const rnd = lcg(11);
    const x1 = [], x2 = [], y = [];
    for (let i = 0; i < 200; i++) {
      const common = rnd() * 0.02;
      const cnOwn = rnd() * 0.02;
      x1.push(common);
      x2.push(common + cnOwn);
      y.push(cnOwn);
    }
    const fit = fitTwoLeg(y, x1, x2);
    assert.ok(fit.betaCn > 0.9, `betaCn=${fit.betaCn}`);
    assert.ok(fit.betaUs < -0.9, `betaUs=${fit.betaUs}`);
    assert.ok(computeLean(fit.betaUs, fit.betaCn) > 0.9);
  });

  it('returns null below the observation floor', () => {
    assert.equal(fitTwoLeg([1, 2, 3], [1, 2, 3], [3, 2, 1]), null);
  });

  it('returns null on a zero-variance leg', () => {
    const y = Array.from({ length: 80 }, (_, i) => i / 100);
    const x1 = Array.from({ length: 80 }, (_, i) => i / 100);
    const x2 = new Array(80).fill(0.5);
    assert.equal(fitTwoLeg(y, x1, x2), null);
  });

  it('returns null on perfectly collinear legs', () => {
    const y = Array.from({ length: 80 }, (_, i) => (i % 7) / 100);
    const x1 = Array.from({ length: 80 }, (_, i) => (i % 5) / 100);
    const x2 = x1.map((v) => v * 3);
    assert.equal(fitTwoLeg(y, x1, x2), null);
  });
});

describe('computeLean', () => {
  it('is -1 for a pure US loading and +1 for a pure China loading', () => {
    assert.equal(computeLean(1.2, 0), -1);
    assert.equal(computeLean(0, 1.2), 1);
  });

  it('is 0 when the two loadings match', () => {
    assert.equal(computeLean(0.8, 0.8), 0);
  });

  it('is scale-free — doubling both betas does not move the tilt', () => {
    assert.ok(Math.abs(computeLean(1.0, 0.25) - computeLean(2.0, 0.5)) < 1e-12);
  });

  it('is 0 rather than NaN when both loadings are zero', () => {
    assert.equal(computeLean(0, 0), 0);
  });
});

describe('abnormalReturns', () => {
  it('is ~zero when the fit explains everything', () => {
    const x1 = [0.01, -0.02, 0.03], x2 = [0.0, 0.01, -0.01];
    const fit = { alpha: 0, betaUs: 2, betaCn: 1, r2: 1, obs: 3 };
    const y = x1.map((v, i) => 2 * v + 1 * x2[i]);
    for (const { ar } of abnormalReturns([1, 2, 3], y, x1, x2, fit)) {
      assert.ok(Math.abs(ar) < 1e-15);
    }
  });

  it('isolates a country-specific shock from the bloc move', () => {
    const x1 = [0.01, 0.01], x2 = [0.0, 0.0];
    const fit = { alpha: 0, betaUs: 1, betaCn: 0, r2: 1, obs: 2 };
    const y = [0.01, 0.05]; // second session: +4% beyond what the legs explain
    const ars = abnormalReturns([1, 2], y, x1, x2, fit);
    assert.ok(Math.abs(ars[0].ar) < 1e-15);
    assert.ok(Math.abs(ars[1].ar - 0.04) < 1e-15);
  });
});

describe('stdev', () => {
  it('is ~0 for a constant series and exactly 0 for a single observation', () => {
    // A sum of squares over a constant series is only float-zero, not exact.
    assert.ok(stdev([0.2, 0.2, 0.2]) < 1e-15);
    assert.equal(stdev([0.5]), 0);
  });

  it('never returns NaN from float error on a constant series', () => {
    assert.ok(Number.isFinite(stdev(new Array(500).fill(0.3))));
  });
});

describe('scoreCountry', () => {
  it('scores a US-coupled market as negative lean', () => {
    const rnd = lcg(3);
    const us = [], cn = [], ct = [];
    for (let i = 0; i < 150; i++) {
      const a = rnd() * 0.02, b = rnd() * 0.02;
      us.push(a); cn.push(b); ct.push(1.3 * a + 0.05 * b);
    }
    const mk = (arr) => logReturns(...Object.values(seriesFrom(arr)));
    const score = scoreCountry(mk(ct), mk(us), mk(cn));
    assert.ok(score.lean < -0.5, `lean=${score.lean}`);
    assert.ok(score.r2 > 0.9);
    assert.ok(score.recentAr.length <= 30);
  });

  it('returns null when the histories do not overlap enough', () => {
    const a = new Map([[1, 0.01], [2, 0.02]]);
    const b = new Map([[1, 0.01], [2, 0.02]]);
    const c = new Map([[1, 0.01], [2, 0.02]]);
    assert.equal(scoreCountry(a, b, c), null);
  });
});
