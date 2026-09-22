// #8424 review follow-up: the canonical bls:series:v1 envelope is the only key
// get-bls-series reads, and a known series absent from a valid envelope is a
// 503. So the seeder must refuse a partial FRED cohort (runSeed then keeps the
// last-good envelope serving) and the ids it publishes must match the ids the
// RPC accepts, or a documented enum value 503s forever.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { BLS_SERIES_IDS, validate } from '../scripts/seed-bls-series.mjs';

const contracts = JSON.parse(readFileSync(new URL('../shared/openapi-filter-param-contracts.json', import.meta.url), 'utf8'));

function series(id, observationCount = 3) {
  return {
    seriesId: id,
    title: id,
    units: 'x',
    observations: Array.from({ length: observationCount }, (_, i) => ({ year: '2026', period: `M0${i + 1}`, periodName: 'm', value: String(i) })),
  };
}

test('validate accepts the full cohort', () => {
  assert.equal(validate({ series: BLS_SERIES_IDS.map((id) => series(id)) }), true);
});

test('validate refuses a 1-of-2 fetch so runSeed preserves the last-good envelope', () => {
  const [first, ...rest] = BLS_SERIES_IDS;
  assert.ok(rest.length > 0, 'the cohort has more than one series');
  assert.equal(validate({ series: [series(first)] }), false);
});

test('validate refuses a series that arrived without observations', () => {
  const [first, ...rest] = BLS_SERIES_IDS;
  assert.equal(validate({ series: [series(first, 0), ...rest.map((id) => series(id))] }), false);
});

// The RPC refuses to serve an entry missing seriesId/title/units, so the
// producer must refuse to publish one: otherwise the seed passes validation,
// health reads fresh, and every request for that series 503s until the next
// run. The two predicates are one contract and have to move together.
test('validate refuses a series missing title or units', () => {
  const [first, ...rest] = BLS_SERIES_IDS;
  const others = rest.map((id) => series(id));
  for (const missing of ['title', 'units']) {
    const broken = series(first);
    delete broken[missing];
    assert.equal(validate({ series: [broken, ...others] }), false, `a series without ${missing} is not publishable`);
  }
});

test('validate refuses a series whose title or units is not a string', () => {
  const [first, ...rest] = BLS_SERIES_IDS;
  const others = rest.map((id) => series(id));
  assert.equal(validate({ series: [{ ...series(first), title: 42 }, ...others] }), false);
  assert.equal(validate({ series: [{ ...series(first), units: null }, ...others] }), false);
});

test('validate refuses the empty and malformed shapes', () => {
  assert.equal(validate({ series: [] }), false);
  assert.equal(validate({}), false);
  assert.equal(validate(null), false);
});

test('the published series ids equal the ids the RPC accepts', () => {
  assert.deepEqual([...BLS_SERIES_IDS].sort(), [...contracts.economicBlsSeriesIds].sort());
});
