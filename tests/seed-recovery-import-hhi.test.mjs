import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeHhi } from '../scripts/seed-recovery-import-hhi.mjs';

describe('seed-recovery-import-hhi', () => {
  it('computes HHI=1 for single-partner imports', () => {
    const records = [{ partnerCode: '156', primaryValue: 1000 }];
    const result = computeHhi(records);
    assert.equal(result.hhi, 1);
    assert.equal(result.partnerCount, 1);
  });

  it('computes HHI for two equal partners', () => {
    const records = [
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2);
  });

  it('computes HHI for diversified imports (4 equal partners)', () => {
    const records = [
      { partnerCode: '156', primaryValue: 250 },
      { partnerCode: '842', primaryValue: 250 },
      { partnerCode: '276', primaryValue: 250 },
      { partnerCode: '392', primaryValue: 250 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.25);
    assert.equal(result.partnerCount, 4);
  });

  it('HHI > 0.25 flags concentrated', () => {
    const records = [
      { partnerCode: '156', primaryValue: 900 },
      { partnerCode: '842', primaryValue: 100 },
    ];
    const result = computeHhi(records);
    assert.ok(result.hhi > 0.25, `HHI ${result.hhi} should exceed 0.25 concentration threshold`);
  });

  it('HHI with asymmetric partners matches manual calculation', () => {
    const records = [
      { partnerCode: '156', primaryValue: 600 },
      { partnerCode: '842', primaryValue: 300 },
      { partnerCode: '276', primaryValue: 100 },
    ];
    const result = computeHhi(records);
    const expected = (0.6 ** 2) + (0.3 ** 2) + (0.1 ** 2);
    assert.ok(Math.abs(result.hhi - Math.round(expected * 10000) / 10000) < 0.001);
    assert.equal(result.partnerCount, 3);
  });

  it('excludes world aggregate partner codes (0 and 000)', () => {
    const records = [
      { partnerCode: '0', primaryValue: 5000 },
      { partnerCode: '000', primaryValue: 5000 },
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2);
  });

  it('returns null for empty records', () => {
    assert.equal(computeHhi([]), null);
  });

  it('returns null when all records are world aggregates', () => {
    const records = [
      { partnerCode: '0', primaryValue: 1000 },
      { partnerCode: '000', primaryValue: 2000 },
    ];
    assert.equal(computeHhi(records), null);
  });

  // P1 fix: multi-row per partner must aggregate before computing shares
  it('aggregates multiple rows for the same partner before computing shares', () => {
    // Simulates Comtrade returning multiple commodity rows for partner 156
    const records = [
      { partnerCode: '156', primaryValue: 300 },
      { partnerCode: '156', primaryValue: 200 },  // same partner, different commodity
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    // After aggregation: 156=500, 842=500 → HHI = 0.5^2 + 0.5^2 = 0.5
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2, 'partnerCount must count unique partners, not rows');
  });

  it('handles multi-year duplicate rows correctly', () => {
    // Simulates Comtrade returning the same partner across 2 years
    const records = [
      { partnerCode: '156', primaryValue: 400 },  // year 1
      { partnerCode: '156', primaryValue: 600 },  // year 2
      { partnerCode: '842', primaryValue: 200 },  // year 1
      { partnerCode: '842', primaryValue: 300 },  // year 2
    ];
    const result = computeHhi(records);
    // Aggregated: 156=1000, 842=500 → shares: 0.667, 0.333
    // HHI = 0.667^2 + 0.333^2 ≈ 0.5556
    assert.ok(Math.abs(result.hhi - 0.5556) < 0.01, `HHI ${result.hhi} should be ~0.5556`);
    assert.equal(result.partnerCount, 2);
  });
});
