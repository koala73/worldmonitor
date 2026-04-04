import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExposureIndex,
  OWID_ENERGY_MIX_KEY_PREFIX,
  OWID_EXPOSURE_INDEX_KEY,
  OWID_COUNTRY_LIST_KEY,
  OWID_META_KEY,
  OWID_TTL_SECONDS,
} from '../scripts/seed-owid-energy-mix.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCountries(overrides = []) {
  const base = new Map([
    ['DE', { iso2: 'DE', country: 'Germany',      year: 2023, coalShare: 26, gasShare: 15, oilShare: 1,  renewShare: 56, importShare: 4,  nuclearShare: 2,  windShare: 34, solarShare: 12, hydroShare: 3,  seededAt: '' }],
    ['IT', { iso2: 'IT', country: 'Italy',         year: 2023, coalShare: 5,  gasShare: 47, oilShare: 2,  renewShare: 40, importShare: 15, nuclearShare: 0,  windShare: 7,  solarShare: 10, hydroShare: 15, seededAt: '' }],
    ['ZA', { iso2: 'ZA', country: 'South Africa',  year: 2023, coalShare: 88, gasShare: 0,  oilShare: 1,  renewShare: 8,  importShare: 2,  nuclearShare: 5,  windShare: 3,  solarShare: 2,  hydroShare: 1,  seededAt: '' }],
    ['SA', { iso2: 'SA', country: 'Saudi Arabia',  year: 2023, coalShare: 0,  gasShare: 38, oilShare: 62, renewShare: 0,  importShare: 0,  nuclearShare: 0,  windShare: 0,  solarShare: 0,  hydroShare: 0,  seededAt: '' }],
    ['MT', { iso2: 'MT', country: 'Malta',         year: 2023, coalShare: null, gasShare: null, oilShare: 3, renewShare: 10, importShare: 93, nuclearShare: null, windShare: 5, solarShare: 5, hydroShare: 0, seededAt: '' }],
    ['NO', { iso2: 'NO', country: 'Norway',        year: 2023, coalShare: 0,  gasShare: 2,  oilShare: 0,  renewShare: 97, importShare: -2, nuclearShare: 0,  windShare: 8,  solarShare: 0,  hydroShare: 89, seededAt: '' }],
  ]);
  for (const [iso2, patch] of overrides) base.set(iso2, { ...base.get(iso2), ...patch });
  return base;
}

// ---------------------------------------------------------------------------
// buildExposureIndex — ranking correctness
// ---------------------------------------------------------------------------

describe('buildExposureIndex', () => {
  it('returns updatedAt, year, and all five fuel buckets', () => {
    const idx = buildExposureIndex(makeCountries());
    assert.ok(typeof idx.updatedAt === 'string');
    assert.equal(idx.year, 2023);
    assert.ok(Array.isArray(idx.gas));
    assert.ok(Array.isArray(idx.coal));
    assert.ok(Array.isArray(idx.oil));
    assert.ok(Array.isArray(idx.imported));
    assert.ok(Array.isArray(idx.renewable));
  });

  it('each bucket includes only countries with a non-null value for that metric', () => {
    const idx = buildExposureIndex(makeCountries());
    // MT has no gasShare/coalShare but has oilShare and importShare
    assert.ok(!idx.gas.some((e) => e.iso2 === 'MT'), 'MT has null gasShare — should not appear in gas bucket');
    assert.ok(!idx.coal.some((e) => e.iso2 === 'MT'), 'MT has null coalShare — should not appear in coal bucket');
    assert.ok(idx.oil.some((e) => e.iso2 === 'MT'), 'MT has oilShare=3 — must appear in oil bucket');
    assert.ok(idx.imported.some((e) => e.iso2 === 'MT'), 'MT has importShare=93 — must appear in imported bucket');
  });

  it('countries with only oil/import/renewables data are not excluded from those buckets', () => {
    // SA has no coalShare=0 (not null), but the key case: a country with gasShare=null, coalShare=null
    const countries = makeCountries();
    countries.set('XX', {
      iso2: 'XX', country: 'TestOilOnly', year: 2023,
      coalShare: null, gasShare: null, oilShare: 80,
      renewShare: null, importShare: 50, nuclearShare: null,
      windShare: null, solarShare: null, hydroShare: null, seededAt: '',
    });
    const idx = buildExposureIndex(countries);
    assert.ok(idx.oil.some((e) => e.iso2 === 'XX'), 'oil-only country must appear in oil bucket');
    assert.ok(idx.imported.some((e) => e.iso2 === 'XX'), 'oil-only country must appear in imported bucket');
    assert.ok(!idx.gas.some((e) => e.iso2 === 'XX'), 'oil-only country must not appear in gas bucket');
    assert.ok(!idx.coal.some((e) => e.iso2 === 'XX'), 'oil-only country must not appear in coal bucket');
  });

  it('each bucket is sorted descending by share', () => {
    const idx = buildExposureIndex(makeCountries());
    for (const bucket of [idx.gas, idx.coal, idx.oil, idx.imported, idx.renewable]) {
      for (let i = 1; i < bucket.length; i++) {
        assert.ok(bucket[i - 1].share >= bucket[i].share,
          `bucket not sorted descending at index ${i}: ${bucket[i - 1].share} < ${bucket[i].share}`);
      }
    }
  });

  it('top of each bucket is the expected country', () => {
    const idx = buildExposureIndex(makeCountries());
    assert.equal(idx.coal[0].iso2, 'ZA', 'highest coal share should be ZA (88%)');
    assert.equal(idx.gas[0].iso2, 'IT', 'highest gas share should be IT (47%)');
    assert.equal(idx.oil[0].iso2, 'SA', 'highest oil share should be SA (62%)');
    assert.equal(idx.imported[0].iso2, 'MT', 'highest import share should be MT (93%)');
    assert.equal(idx.renewable[0].iso2, 'NO', 'highest renewable share should be NO (97%)');
  });

  it('caps each bucket at 20 entries', () => {
    // Build 25 countries all with gasShare values, using unique 2-char ISO2 codes
    const countries = new Map();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXY'; // 25 unique letters → AA..AY
    for (let i = 0; i < 25; i++) {
      const iso2 = `A${letters[i]}`;
      countries.set(iso2, { iso2, country: `Country${i}`, year: 2023, gasShare: 50 - i, coalShare: null, oilShare: null, renewShare: null, importShare: null, nuclearShare: null, windShare: null, solarShare: null, hydroShare: null, seededAt: '' });
    }
    const idx = buildExposureIndex(countries);
    assert.equal(idx.gas.length, 20);
  });

  it('handles all-null year values without throwing', () => {
    const countries = makeCountries([[
      'DE', { year: null }], ['IT', { year: null }], ['ZA', { year: null }],
      ['SA', { year: null }], ['MT', { year: null }], ['NO', { year: null }],
    ]);
    const idx = buildExposureIndex(countries);
    assert.equal(idx.year, null);
  });
});

// ---------------------------------------------------------------------------
// Exported constants — key naming contract
// ---------------------------------------------------------------------------

describe('exported key constants', () => {
  it('OWID_ENERGY_MIX_KEY_PREFIX matches expected pattern', () => {
    assert.equal(OWID_ENERGY_MIX_KEY_PREFIX, 'energy:mix:v1:');
  });

  it('OWID_EXPOSURE_INDEX_KEY matches expected pattern', () => {
    assert.equal(OWID_EXPOSURE_INDEX_KEY, 'energy:exposure:v1:index');
  });

  it('OWID_COUNTRY_LIST_KEY matches expected pattern', () => {
    assert.equal(OWID_COUNTRY_LIST_KEY, 'energy:mix:v1:_countries');
  });

  it('OWID_META_KEY matches expected pattern', () => {
    assert.equal(OWID_META_KEY, 'seed-meta:economic:owid-energy-mix');
  });

  it('OWID_TTL_SECONDS covers the monthly cron cadence (35 days)', () => {
    assert.ok(OWID_TTL_SECONDS >= 35 * 24 * 3600,
      `TTL ${OWID_TTL_SECONDS}s is less than 35 days — meta would expire before next monthly run`);
  });
});
