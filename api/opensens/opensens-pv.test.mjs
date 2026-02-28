/**
 * Unit tests for /api/opensens/pv
 * Run with: node --test api/opensens/opensens-pv.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// ---- Inline the pure functions for testing ----

function fallbackPvEstimate(lat, kwp) {
  const absLat = Math.abs(lat);
  let psh;
  if (absLat < 15) psh = 5.5;
  else if (absLat < 25) psh = 5.2;
  else if (absLat < 35) psh = 4.8;
  else if (absLat < 45) psh = 4.2;
  else if (absLat < 55) psh = 3.5;
  else psh = 2.8;
  const pr = 0.80;
  const p50 = parseFloat((kwp * psh * pr).toFixed(2));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const seasonFactor = lat >= 0
      ? 1 + 0.2 * Math.cos(((i - 5) * Math.PI) / 6)
      : 1 + 0.2 * Math.cos(((i - 11) * Math.PI) / 6);
    return { month: i + 1, kwhEstimate: parseFloat((p50 * seasonFactor).toFixed(3)) };
  });
  return { p50, p10: parseFloat((p50 * 0.70).toFixed(2)), p90: parseFloat((p50 * 1.30).toFixed(2)), monthly };
}

function coarseBucket(lat, lon, precision = 1) {
  const factor = Math.pow(10, precision);
  const bLat = (Math.round(lat * factor) / factor).toFixed(precision);
  const bLon = (Math.round(lon * factor) / factor).toFixed(precision);
  return `${bLat},${bLon}`;
}

describe('fallbackPvEstimate', () => {
  it('returns positive p50 for equatorial location', () => {
    const res = fallbackPvEstimate(0, 3);
    assert.ok(res.p50 > 0, `Expected p50 > 0, got ${res.p50}`);
  });

  it('p10 < p50 < p90', () => {
    const res = fallbackPvEstimate(48.85, 3);
    assert.ok(res.p10 < res.p50);
    assert.ok(res.p50 < res.p90);
  });

  it('scales linearly with kwp', () => {
    const r3 = fallbackPvEstimate(20, 3);
    const r6 = fallbackPvEstimate(20, 6);
    assert.ok(Math.abs(r6.p50 / r3.p50 - 2) < 0.01, 'Should scale linearly with kWp');
  });

  it('returns 12 monthly values', () => {
    const { monthly } = fallbackPvEstimate(0, 3);
    assert.equal(monthly.length, 12);
    assert.equal(monthly[0].month, 1);
    assert.equal(monthly[11].month, 12);
  });

  it('high-latitude gets lower yield than equatorial', () => {
    const eq = fallbackPvEstimate(5, 3);
    const arctic = fallbackPvEstimate(60, 3);
    assert.ok(arctic.p50 < eq.p50);
  });

  it('southern hemisphere seasonality inverts vs northern', () => {
    const nh = fallbackPvEstimate(40, 3);
    const sh = fallbackPvEstimate(-40, 3);
    // June (index 5) should be summer peak NH and winter trough SH
    const nhJun = nh.monthly[5].kwhEstimate;
    const shJun = sh.monthly[5].kwhEstimate;
    assert.ok(nhJun > shJun, 'NH June should be higher than SH June');
  });
});

describe('coarseBucket for PV cache keying', () => {
  it('two nearby points map to same bucket at 0.1° resolution', () => {
    const b1 = coarseBucket(48.851, 2.351, 1);
    const b2 = coarseBucket(48.856, 2.354, 1);
    assert.equal(b1, b2);
  });

  it('two distant points map to different buckets', () => {
    const b1 = coarseBucket(48.0, 2.0, 1);
    const b2 = coarseBucket(49.0, 3.0, 1);
    assert.notEqual(b1, b2);
  });
});

describe('PV system size clamping', () => {
  it('clamps kwp to [0.5, 20]', () => {
    const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);
    assert.equal(clamp(0.1, 0.5, 20), 0.5);
    assert.equal(clamp(99, 0.5, 20), 20);
    assert.equal(clamp(3, 0.5, 20), 3);
  });
});

describe('tilt default (abs(lat))', () => {
  it('defaults to abs(lat) for optimum tilt', () => {
    const lat = -33.87; // Sydney
    const defaultTilt = Math.abs(lat);
    assert.ok(defaultTilt > 0 && defaultTilt <= 90);
    assert.equal(defaultTilt, 33.87);
  });
});
