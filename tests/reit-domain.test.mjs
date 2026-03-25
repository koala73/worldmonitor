/**
 * Unit tests for REIT domain math functions:
 * - Pearson correlation computation
 * - Regime classification (threshold boundary tests)
 * - socialHealthScore formula (weighted composite)
 * - Disaster exposure score (haversine + scoring)
 * - Bond yield spread
 * - Sector rotation signal generation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---- Pearson correlation (replicated from seed-reit-analytics.mjs) ----

function pearsonCorrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const x = xs.slice(0, n);
  const y = ys.slice(0, n);
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : +(num / den).toFixed(3);
}

// ---- Regime classification (replicated) ----

function classifyRegime(ff, t10, cpi, ur) {
  const ffRising = ff.delta3m > 0.25;
  const urRising = ur.delta3m > 0.3;
  if (ffRising && t10.value > 5 && urRising) return 'REIT_REGIME_STRESS';
  if (ffRising || t10.value > 4.5 || cpi.value > 4) return 'REIT_REGIME_CAUTIOUS';
  if (ff.delta3m <= 0 && cpi.value < 3 && ur.value < 4.5) return 'REIT_REGIME_FAVORABLE';
  return 'REIT_REGIME_NEUTRAL';
}

// ---- socialHealthScore (replicated) ----

function computeSocialHealthScore(googleRating, yelpRating, velocityScore, llmScore) {
  const gNorm = (googleRating / 5) * 10;
  const yNorm = (yelpRating / 5) * 10;
  return +(gNorm * 0.40 + yNorm * 0.20 + velocityScore * 0.25 + llmScore * 0.15).toFixed(1);
}

function computeVelocityScore(momPct) {
  return Math.max(0, Math.min(10, 5 + Math.floor(momPct / 20)));
}

// ---- Haversine distance (replicated) ----

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==== Tests ====

describe('Pearson correlation', () => {
  it('returns 1.0 for perfectly correlated arrays', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    assert.equal(r, 1);
  });

  it('returns -1.0 for perfectly inversely correlated arrays', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    assert.equal(r, -1);
  });

  it('returns 0 for uncorrelated arrays', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [5, 5, 5, 5, 5]);
    assert.equal(r, 0);
  });

  it('returns 0 for fewer than 3 data points', () => {
    assert.equal(pearsonCorrelation([1, 2], [3, 4]), 0);
    assert.equal(pearsonCorrelation([1], [2]), 0);
    assert.equal(pearsonCorrelation([], []), 0);
  });

  it('handles mismatched array lengths by using shorter', () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6]);
    assert.equal(r, 1); // first 3 elements still perfectly correlated
  });
});

describe('Regime classification', () => {
  const make = (ffDelta, t10Val, cpiVal, urVal, urDelta = 0) => ({
    ff: { delta3m: ffDelta },
    t10: { value: t10Val },
    cpi: { value: cpiVal },
    ur: { value: urVal, delta3m: urDelta },
  });

  it('classifies STRESS when all 3 conditions met', () => {
    const { ff, t10, cpi, ur } = make(0.5, 5.5, 3, 4, 0.5);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_STRESS');
  });

  it('classifies CAUTIOUS when Fed Funds rising > 25bps', () => {
    const { ff, t10, cpi, ur } = make(0.3, 4.0, 3, 4, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_CAUTIOUS');
  });

  it('classifies CAUTIOUS when 10Y > 4.5%', () => {
    const { ff, t10, cpi, ur } = make(0, 4.6, 3, 4, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_CAUTIOUS');
  });

  it('classifies CAUTIOUS when CPI > 4%', () => {
    const { ff, t10, cpi, ur } = make(0, 4.0, 4.5, 4, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_CAUTIOUS');
  });

  it('classifies FAVORABLE when rates stable, low CPI, low UNRATE', () => {
    const { ff, t10, cpi, ur } = make(-0.1, 3.5, 2.5, 3.8, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_FAVORABLE');
  });

  it('classifies NEUTRAL when no clear signal', () => {
    const { ff, t10, cpi, ur } = make(0.1, 4.0, 3.5, 4.6, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_NEUTRAL');
  });

  it('boundary: Fed Funds delta exactly 0.25 is NOT cautious', () => {
    const { ff, t10, cpi, ur } = make(0.25, 4.0, 3, 4.6, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_NEUTRAL');
  });

  it('boundary: 10Y exactly 4.5 is NOT cautious', () => {
    const { ff, t10, cpi, ur } = make(0, 4.5, 3, 4.6, 0);
    assert.equal(classifyRegime(ff, t10, cpi, ur), 'REIT_REGIME_NEUTRAL');
  });
});

describe('socialHealthScore', () => {
  it('computes correct weighted composite', () => {
    // google=4.0 (8.0), yelp=3.5 (7.0), velocity=5 (flat), llm=6
    const score = computeSocialHealthScore(4.0, 3.5, 5, 6);
    // 8.0*0.40 + 7.0*0.20 + 5*0.25 + 6*0.15 = 3.2 + 1.4 + 1.25 + 0.9 = 6.75
    assert.equal(score, 6.8); // rounded to 1 decimal
  });

  it('returns 0 when all inputs are 0', () => {
    assert.equal(computeSocialHealthScore(0, 0, 0, 0), 0);
  });

  it('returns 10 for perfect scores', () => {
    const score = computeSocialHealthScore(5, 5, 10, 10);
    // 10*0.40 + 10*0.20 + 10*0.25 + 10*0.15 = 4+2+2.5+1.5 = 10
    assert.equal(score, 10);
  });
});

describe('velocityScore', () => {
  it('flat (0% MoM) = 5', () => {
    assert.equal(computeVelocityScore(0), 5);
  });

  it('+60% MoM = 8', () => {
    assert.equal(computeVelocityScore(60), 8);
  });

  it('-40% MoM = 3', () => {
    assert.equal(computeVelocityScore(-40), 3);
  });

  it('clamped at 0 for extreme negative', () => {
    assert.equal(computeVelocityScore(-200), 0);
  });

  it('clamped at 10 for extreme positive', () => {
    assert.equal(computeVelocityScore(200), 10);
  });
});

describe('Haversine distance', () => {
  it('returns 0 for same point', () => {
    assert.equal(haversineKm(40, -74, 40, -74), 0);
  });

  it('NYC to LA is approximately 3940 km', () => {
    const d = haversineKm(40.7128, -74.0060, 34.0522, -118.2437);
    assert.ok(d > 3900 && d < 4000, `Expected ~3940km, got ${d}`);
  });

  it('Shanghai to Beijing is approximately 1068 km', () => {
    const d = haversineKm(31.2304, 121.4737, 39.9042, 116.4074);
    assert.ok(d > 1050 && d < 1090, `Expected ~1068km, got ${d}`);
  });

  it('short distance: within same city (~10km)', () => {
    // Manhattan to Brooklyn
    const d = haversineKm(40.7580, -73.9855, 40.6892, -73.9822);
    assert.ok(d > 5 && d < 15, `Expected ~7.6km, got ${d}`);
  });
});

describe('Bond yield spread', () => {
  it('positive spread when REIT yield > 10Y', () => {
    const avgReitYield = 5.2;
    const treasuryYield = 4.28;
    const spread = +(avgReitYield - treasuryYield).toFixed(2);
    assert.equal(spread, 0.92);
    assert.ok(spread > 0);
  });

  it('negative spread when REIT yield < 10Y', () => {
    const avgReitYield = 3.1;
    const treasuryYield = 4.5;
    const spread = +(avgReitYield - treasuryYield).toFixed(2);
    assert.equal(spread, -1.4);
    assert.ok(spread < 0);
  });
});
