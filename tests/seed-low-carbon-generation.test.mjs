import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLowCarbonCountries,
  collectByIsoYear,
} from '../scripts/seed-low-carbon-generation.mjs';

function records(iso3, valuesByYear) {
  return Object.entries(valuesByYear).map(([date, value]) => ({
    countryiso3code: iso3,
    date,
    value,
  }));
}

test('low-carbon generation uses latest common source year, not max mixed component year', () => {
  const nuclearByIso = collectByIsoYear(records('USA', {
    2024: 18,
    2021: 20,
  }));
  const renewByIso = collectByIsoYear(records('USA', {
    2021: 15,
  }));
  const hydroByIso = collectByIsoYear(records('USA', {
    2024: 7,
    2021: 6,
  }));

  const countries = buildLowCarbonCountries({ nuclearByIso, renewByIso, hydroByIso });

  assert.equal(countries.US.value, 41);
  assert.equal(countries.US.year, 2021);
  assert.deepEqual(countries.US.sourceYears, {
    nuclear: 2021,
    renewablesExHydro: 2021,
    hydro: 2021,
  });
  assert.equal(countries.US.nuclearShare, 20);
  assert.equal(countries.US.renewablesExHydroShare, 15);
  assert.equal(countries.US.hydroShare, 6);
});

test('low-carbon generation omits countries with no common component year', () => {
  const nuclearByIso = collectByIsoYear(records('FRA', { 2024: 65 }));
  const renewByIso = collectByIsoYear(records('FRA', { 2021: 12 }));
  const hydroByIso = collectByIsoYear(records('FRA', { 2024: 10 }));

  const countries = buildLowCarbonCountries({ nuclearByIso, renewByIso, hydroByIso });

  assert.equal(countries.FR, undefined);
});

test('low-carbon generation treats an absent component series as zero', () => {
  const nuclearByIso = collectByIsoYear(records('NOR', { 2024: 1 }));
  const renewByIso = new Map();
  const hydroByIso = collectByIsoYear(records('NOR', { 2024: 95 }));

  const countries = buildLowCarbonCountries({ nuclearByIso, renewByIso, hydroByIso });

  assert.equal(countries.NO.value, 96);
  assert.equal(countries.NO.year, 2024);
  assert.deepEqual(countries.NO.sourceYears, {
    nuclear: 2024,
    renewablesExHydro: null,
    hydro: 2024,
  });
  assert.equal(countries.NO.nuclearShare, 1);
  assert.equal(countries.NO.renewablesExHydroShare, 0);
  assert.equal(countries.NO.hydroShare, 95);
});
