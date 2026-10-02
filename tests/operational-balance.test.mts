import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateOperationalBalance, importOperationalWorksheet, operationalExample } from '../src/utils/operational-balance.ts';

test('literal daily balances preserve day 8 gaps and move on-time alternative gap to day 10', () => {
  const input = operationalExample();
  input.alternativeDeliveries = [{ date: '2026-09-17', quantity: 40, unit: 'units', costUsd: null }];
  const result = calculateOperationalBalance(input);
  assert.deepEqual(result.baseline.days.map(d => [d.closingStock, d.unmetDemand]), [[80,0],[60,0],[40,0],[60,0],[40,0],[20,0],[0,0],[0,20],[0,20],[0,20]]);
  assert.deepEqual(result.alternative.days.map(d => [d.closingStock, d.unmetDemand]), [[80,0],[60,0],[40,0],[60,0],[40,0],[20,0],[0,0],[20,0],[0,0],[0,20]]);
  assert.equal(result.baseline.firstGapDay, 8); assert.equal(result.alternative.firstGapDay, 10);
  assert.equal(result.avoidedUnmetDemand, 40);
  input.alternativeDeliveries[0]!.date = '2026-09-18';
  const late = calculateOperationalBalance(input);
  assert.equal(late.alternative.firstGapDay, 8);
  assert.deepEqual(late.alternative.days.slice(7).map(d => d.unmetDemand), [20,0,0]);
});

test('zero, partial and multiple deliveries and reduced consumption retain physical balance', () => {
  const input = operationalExample();
  input.startingStock = 0; input.deliveries = []; input.horizonDays = 2;
  assert.deepEqual(calculateOperationalBalance(input).baseline.days.map(d => d.unmetDemand), [20,20]);
  input.dailyDemand = 0;
  assert.deepEqual(calculateOperationalBalance(input).baseline.days.map(d => [d.closingStock,d.unmetDemand]), [[0,0],[0,0]]);
  input.dailyDemand = 20;
  input.deliveries = [5, 10].map(quantity => ({ date: input.startDate, quantity, unit: 'units', costUsd: 3 }));
  input.alternativeDailyDemand = 5;
  const result = calculateOperationalBalance(input);
  assert.deepEqual(result.baseline.days.map(d => [d.arrivals,d.unmetDemand]), [[15,5],[0,20]]);
  assert.deepEqual(result.alternative.days.map(d => [d.closingStock,d.unmetDemand]), [[10,0],[5,0]]);
  assert.equal(result.alternative.firstGapDay, null);
});

test('prices remain unknown and import recomputes results with exact round trip', () => {
  const input = operationalExample();
  input.alternativeDeliveries = [{ date: '2026-09-17', quantity: 40, unit: 'units', costUsd: 50 }];
  assert.equal(calculateOperationalBalance(input).additionalDeliveryCostUsd, null);
  input.deliveries[0]!.costUsd = 0;
  const result = calculateOperationalBalance(input);
  assert.equal(result.additionalDeliveryCostUsd, 50);
  assert.deepEqual(importOperationalWorksheet(JSON.stringify(result)), result);
  assert.deepEqual(importOperationalWorksheet(JSON.stringify({ ...result, baseline: 'untrusted' })), result);
});

test('input boundary rejects missing values, mixed units, bad dates and bounded payloads', () => {
  for (const patch of [ { startingStock: null }, { dailyDemand: '' }, { dailyDemand: -1 }, { dailyDemand: Infinity }, { dailyDemand: 1e10 }, { dailyDemand: 0.0000001 }, { horizonDays: 91 }, { horizonDays: 1.5 }, { startDate: '2026-02-30' }, { unit: '' }, { alternativeDailyDemand: undefined }, { deliveries: [{ date: '2026-09-13', quantity: 40, unit: 'kg' }] }, { deliveries: [{ date: '2026-09-09', quantity: 40, unit: 'units' }] }, { alternativeDeliveries: Array(31).fill({ date: '2026-09-13', quantity: 1, unit: 'units' }) } ]) {
    assert.throws(() => calculateOperationalBalance({ ...operationalExample(), ...patch }), undefined, JSON.stringify(patch));
  }
  assert.throws(() => importOperationalWorksheet('{'));
  assert.throws(() => importOperationalWorksheet(' '.repeat(65537)), /64 KiB/);
  assert.throws(() => importOperationalWorksheet('{"schema":"wrong"}'), /Unsupported/);
});

test('fractional stock and deliveries retain six-decimal balances', () => {
  const result = calculateOperationalBalance({ ...operationalExample(), startingStock: 0.3, dailyDemand: 0.1, horizonDays: 4, deliveries: [] });
  assert.deepEqual(result.baseline.days.map(day => [day.closingStock, day.unmetDemand]), [[0.2,0],[0.1,0],[0,0],[0,0.1]]);
});
