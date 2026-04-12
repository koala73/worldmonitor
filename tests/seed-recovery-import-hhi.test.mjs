import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeHhi } from '../scripts/seed-recovery-import-hhi.mjs';

describe('seed-recovery-import-hhi', () => {
  it('computes HHI=1 for single-partner imports', () => {
    const records = [{ partnerCode: '156', primaryValue: 1000 }];
    assert.equal(computeHhi(records), 1);
  });

  it('computes HHI for two equal partners', () => {
    const records = [
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    assert.equal(computeHhi(records), 0.5);
  });

  it('computes HHI for diversified imports (4 equal partners)', () => {
    const records = [
      { partnerCode: '156', primaryValue: 250 },
      { partnerCode: '842', primaryValue: 250 },
      { partnerCode: '276', primaryValue: 250 },
      { partnerCode: '392', primaryValue: 250 },
    ];
    assert.equal(computeHhi(records), 0.25);
  });

  it('HHI > 0.25 flags concentrated', () => {
    const records = [
      { partnerCode: '156', primaryValue: 900 },
      { partnerCode: '842', primaryValue: 100 },
    ];
    const hhi = computeHhi(records);
    assert.ok(hhi > 0.25, `HHI ${hhi} should exceed 0.25 concentration threshold`);
  });

  it('HHI with asymmetric partners matches manual calculation', () => {
    const records = [
      { partnerCode: '156', primaryValue: 600 },
      { partnerCode: '842', primaryValue: 300 },
      { partnerCode: '276', primaryValue: 100 },
    ];
    const hhi = computeHhi(records);
    const expected = (0.6 ** 2) + (0.3 ** 2) + (0.1 ** 2);
    assert.ok(Math.abs(hhi - Math.round(expected * 10000) / 10000) < 0.001);
  });

  it('excludes world aggregate partner codes (0 and 000)', () => {
    const records = [
      { partnerCode: '0', primaryValue: 5000 },
      { partnerCode: '000', primaryValue: 5000 },
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    const hhi = computeHhi(records);
    assert.equal(hhi, 0.5);
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
});
