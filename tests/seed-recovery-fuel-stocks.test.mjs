import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFuelStockDays } from '../scripts/seed-recovery-fuel-stocks.mjs';

describe('seed-recovery-fuel-stocks', () => {
  it('computes fuel-stock-days from IEA members', () => {
    const members = [
      { iso2: 'US', daysOfCover: 120, netExporter: false, belowObligation: false },
      { iso2: 'JP', daysOfCover: 200, netExporter: false, belowObligation: false },
      { iso2: 'DE', daysOfCover: 85, netExporter: false, belowObligation: true },
    ];
    const result = computeFuelStockDays(members);
    assert.equal(Object.keys(result).length, 3);
    assert.equal(result.US.fuelStockDays, 120);
    assert.equal(result.US.meetsObligation, true);
    assert.equal(result.DE.fuelStockDays, 85);
    assert.equal(result.DE.meetsObligation, false);
    assert.equal(result.DE.belowObligation, true);
  });

  it('skips net exporters', () => {
    const members = [
      { iso2: 'NO', daysOfCover: null, netExporter: true, belowObligation: false },
      { iso2: 'US', daysOfCover: 120, netExporter: false, belowObligation: false },
    ];
    const result = computeFuelStockDays(members);
    assert.equal(Object.keys(result).length, 1);
    assert.ok(!result.NO);
    assert.ok(result.US);
  });

  it('skips members with null daysOfCover', () => {
    const members = [
      { iso2: 'CA', daysOfCover: null, netExporter: false, belowObligation: false },
    ];
    const result = computeFuelStockDays(members);
    assert.equal(Object.keys(result).length, 0);
  });

  it('returns empty for empty members array', () => {
    const result = computeFuelStockDays([]);
    assert.equal(Object.keys(result).length, 0);
  });

  it('90-day boundary: exactly 90 meets obligation', () => {
    const members = [
      { iso2: 'FR', daysOfCover: 90, netExporter: false, belowObligation: false },
    ];
    const result = computeFuelStockDays(members);
    assert.equal(result.FR.meetsObligation, true);
    assert.equal(result.FR.belowObligation, false);
  });

  it('89 days is below obligation', () => {
    const members = [
      { iso2: 'IT', daysOfCover: 89, netExporter: false, belowObligation: true },
    ];
    const result = computeFuelStockDays(members);
    assert.equal(result.IT.meetsObligation, false);
    assert.equal(result.IT.belowObligation, true);
  });
});
