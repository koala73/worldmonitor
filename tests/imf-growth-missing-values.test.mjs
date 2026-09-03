import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestValue, weoYears, buildGrowthCountries } from '../scripts/seed-imf-growth.mjs';

const [current, previous, oldest] = weoYears();

// imfSdmxFetchIndicator normalizes SDMX observations to numbers before
// returning the year map. Numeric strings are not part of this internal contract.
for (const [label, value] of [
  ['null', null], ['empty string', ''], ['whitespace', ' \t '],
  ['false', false], ['true', true], ['numeric string', '2.5'],
  ['nonnumeric string', 'missing'], ['undefined', undefined],
  ['empty array', []], ['numeric array', [2.5]], ['object', {}],
  ['NaN', NaN], ['Infinity', Infinity],
]) {
  test(`growth rejects ${label} and falls back to the next valid year`, () => {
    assert.equal(latestValue({ [current]: value }), null);
    assert.deepEqual(latestValue({ [current]: value, [previous]: 2.5 }),
      { value: 2.5, year: Number(previous) });
  });
}

test('growth retains a genuine numeric zero in preference to older observations', () => {
  assert.deepEqual(latestValue({ [current]: 0, [previous]: 2.5 }),
    { value: 0, year: Number(current) });
});

test('growth falls through multiple missing years without losing the observation year', () => {
  assert.deepEqual(latestValue({ [current]: null, [previous]: '', [oldest]: -1.2 }),
    { value: -1.2, year: Number(oldest) });
});

test('growth publication omits missing-only countries and preserves fallback freshness', () => {
  const countries = buildGrowthCountries({ realGdpGrowth: {
    USA: { [current]: null }, GBR: { [current]: '', [previous]: 1.5 },
    FRA: { [current]: 0 },
  } });
  assert.equal(countries.US, undefined);
  assert.equal(countries.GB.realGdpGrowthPct, 1.5);
  assert.equal(countries.GB.year, Number(previous));
  assert.equal(countries.GB.latestYear, Number(previous));
  assert.equal(countries.FR.realGdpGrowthPct, 0);
});
