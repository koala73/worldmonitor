import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOW_CARBON_MAX_CONTENT_AGE_MIN,
  buildLowCarbonCountriesFromOwidRows,
  getLowCarbonMinNewestYear,
  parseOwidLowCarbonCsv,
  validateLowCarbonGeneration,
} from '../scripts/seed-low-carbon-generation.mjs';
import { wbCountryDictContentMeta } from '../scripts/_wb-country-dict-content-age-helpers.mjs';

const VALUE_COL = 'low_carbon_share_of_electricity__pct';
const FIXED_NOW = Date.UTC(2026, 5, 9, 12, 0, 0);

function row(entity, code, year, value) {
  return {
    entity,
    code,
    year: String(year),
    [VALUE_COL]: String(value),
  };
}

test('low-carbon generation parses OWID latest country year and skips aggregates', () => {
  const csv = [
    `entity,code,year,${VALUE_COL}`,
    'ASEAN (Ember),,2025,25.5',
    'United States,USA,2024,42.5',
    'United States,USA,2025,43.2',
    'Norway,NOR,2024,99.1',
  ].join('\n');

  const countries = parseOwidLowCarbonCsv(csv);

  assert.equal(Object.keys(countries).length, 2);
  assert.deepEqual(countries.US, {
    value: 43.2,
    year: 2025,
    source: 'OWID share-electricity-low-carbon',
    sourceEntity: 'United States',
    sourceCode: 'USA',
  });
  assert.equal(countries.NO.value, 99.1);
  assert.equal(countries.NO.year, 2024);
});

test('low-carbon generation clamps impossible OWID percentages to scorer-safe bounds', () => {
  const countries = buildLowCarbonCountriesFromOwidRows([
    row('Example High', 'USA', 2025, 101.4),
    row('Example Low', 'CAN', 2025, -2),
  ]);

  assert.equal(countries.US.value, 100);
  assert.equal(countries.CA.value, 0);
});

test('low-carbon generation ignores unmapped, undated, and non-numeric rows', () => {
  const countries = buildLowCarbonCountriesFromOwidRows([
    row('United States', 'USA', 2025, 43.2),
    row('Unmapped Example', 'ZZZ', 2025, 100),
    row('No Year', 'CAN', 'bad', 80),
    row('Empty Year', 'NOR', '', 80),
    row('Out-of-range Year', 'FRA', 1899, 80),
    row('No Value', 'NOR', 2025, ''),
  ]);

  assert.deepEqual(Object.keys(countries), ['US']);
});

test('low-carbon generation fails closed if OWID column schema drifts', () => {
  const csv = [
    'entity,code,year,unexpected_value_column',
    'United States,USA,2025,43.2',
  ].join('\n');

  assert.throws(
    () => parseOwidLowCarbonCsv(csv),
    /schema changed: missing low_carbon_share_of_electricity__pct/,
  );
});

test('low-carbon generation validates near-current coverage and newest year', () => {
  const minNewestYear = getLowCarbonMinNewestYear(FIXED_NOW);

  const countries = {};
  for (let idx = 0; idx < 179; idx += 1) {
    countries[`X${idx}`] = { value: 50, year: 2025 };
  }
  assert.equal(validateLowCarbonGeneration({ countries }, FIXED_NOW), false, '179 countries is below the coverage floor');

  countries.X179 = { value: 50, year: minNewestYear };
  assert.equal(
    validateLowCarbonGeneration({ countries }, FIXED_NOW),
    true,
    '180 countries with newest year inside the rolling floor passes',
  );

  for (const entry of Object.values(countries)) entry.year = minNewestYear - 1;
  assert.equal(validateLowCarbonGeneration({ countries }, FIXED_NOW), false, 'stale newest year fails validation');
});

test('low-carbon content-age budget is restored to 18 months for OWID/Ember annual cadence', () => {
  assert.equal(LOW_CARBON_MAX_CONTENT_AGE_MIN, 18 * 30 * 24 * 60);

  const fresh = { countries: { US: { value: 43.2, year: 2025 } } };
  const freshMeta = wbCountryDictContentMeta(fresh, FIXED_NOW);
  const freshAgeMin = (FIXED_NOW - freshMeta.newestItemAt) / 60000;
  assert.ok(freshAgeMin < LOW_CARBON_MAX_CONTENT_AGE_MIN, '2025 data is within the restored budget');

  const stale = { countries: { US: { value: 43.2, year: 2023 } } };
  const staleMeta = wbCountryDictContentMeta(stale, FIXED_NOW);
  const staleAgeMin = (FIXED_NOW - staleMeta.newestItemAt) / 60000;
  assert.ok(staleAgeMin > LOW_CARBON_MAX_CONTENT_AGE_MIN, '2023 data trips STALE_CONTENT by June 2026');
});
