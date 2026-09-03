import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as labor from '../scripts/seed-imf-labor.mjs';
import * as external from '../scripts/seed-imf-external.mjs';

for (const [name, adapter] of [['labor', labor], ['external', external]]) {
  const [current, previous, oldest] = adapter.weoYears();
  test(`${name}: invalid values neither create observations nor hide older valid years`, () => {
    for (const invalid of [null, undefined, '', ' \t ', false, true, '2.5', 'missing', [], [2.5], {}, NaN, Infinity]) {
      assert.equal(adapter.latestValue({ [current]: invalid }), null);
      assert.deepEqual(adapter.latestValue({ [current]: invalid, [previous]: -1.2 }),
        { value: -1.2, year: Number(previous) });
    }
  });

  test(`${name}: genuine zero takes precedence over an older value`, () => {
    assert.deepEqual(adapter.latestValue({ [current]: 0, [previous]: 2.5 }),
      { value: 0, year: Number(current) });
  });

  test(`${name}: skips consecutive missing years`, () => {
    assert.deepEqual(adapter.latestValue({ [current]: null, [previous]: '', [oldest]: 2.5 }),
      { value: 2.5, year: Number(oldest) });
  });
}

test('labor does not publish a missing unemployment rate as current-year zero', () => {
  const [current, previous] = labor.weoYears();
  const countries = labor.buildLaborCountries({ unemployment: {
    USA: { [current]: null }, GBR: { [current]: false, [previous]: 4.5 },
  } });
  assert.equal(countries.US, undefined);
  assert.equal(countries.GB.unemploymentPct, 4.5);
  assert.equal(countries.GB.latestYear, Number(previous));
});

test('external omits countries without any valid observations', () => {
  const [current] = external.weoYears();
  assert.deepEqual(external.buildExternalCountries({
    currentAccount: { USA: { [current]: null } },
    importVol: { USA: { [current]: false } },
    exportVol: { USA: { [current]: '' } },
  }), {});
});
