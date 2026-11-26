import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toFredSeries } from '../src/services/economic/fred-series.ts';

type BatchResults = Parameters<typeof toFredSeries>[0];

function batch(seriesId: string, units: string, observations: Array<[string, number]>): BatchResults {
  return {
    [seriesId]: {
      seriesId, title: seriesId, units, frequency: 'Weekly',
      observations: observations.map(([date, value]) => ({ date, value })),
    },
  } as BatchResults;
}

test('Fed total assets (WALCL, millions of dollars) render in billions', () => {
  // GET /api/economic/v1/get-fred-series?series_id=WALCL returned these two weeks, units "Millions of U.S. Dollars".
  const [walcl] = toFredSeries(batch('WALCL', 'Millions of U.S. Dollars', [
    ['2026-11-11', 6758867],
    ['2026-11-18', 6741452],
  ]));
  assert.equal(walcl?.unit, '$B');
  assert.equal(walcl?.value, 6741.5, '$6,741.5 billion, not $6,741.5 trillion');
  assert.equal(walcl?.previousValue, 6758.9);
  assert.equal(walcl?.change, -17.4, 'weekly change of -$17.4 billion');
  assert.equal(walcl?.date, '2026-11-18');
});

test('a sub-billion weekly move in Fed total assets is not rounded to zero', () => {
  const [walcl] = toFredSeries(batch('WALCL', 'Millions of U.S. Dollars', [
    ['2026-11-11', 6741452],
    ['2026-11-18', 6741052],
  ]));
  assert.equal(walcl?.change, -0.4);
});

test('M2 supply (M2SL, billions of dollars) still renders in trillions', () => {
  const [m2] = toFredSeries(batch('M2SL', 'Billions of Dollars', [
    ['2026-09-01', 22300.4],
    ['2026-10-01', 22412.9],
  ]));
  assert.equal(m2?.unit, '$T');
  assert.equal(m2?.value, 22.4);
  assert.equal(m2?.change, 0.1);
});
