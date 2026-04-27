import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGrowthCountries,
  isAggregate as isAggregateGrowth,
  latestValue as latestValueGrowth,
  validate as validateGrowth,
  CANONICAL_KEY as GROWTH_KEY,
  CACHE_TTL as GROWTH_TTL,
} from '../scripts/seed-imf-growth.mjs';

import {
  buildLaborCountries,
  validate as validateLabor,
  CANONICAL_KEY as LABOR_KEY,
  CACHE_TTL as LABOR_TTL,
} from '../scripts/seed-imf-labor.mjs';

import {
  buildExternalCountries,
  validate as validateExternal,
  CANONICAL_KEY as EXTERNAL_KEY,
  CACHE_TTL as EXTERNAL_TTL,
} from '../scripts/seed-imf-external.mjs';

const YEAR = String(new Date().getFullYear());

describe('seed-imf shared helpers', () => {
  it('isAggregate flags WEO regional aggregates and rejects 2-letter codes', () => {
    assert.equal(isAggregateGrowth('USA'), false);
    assert.equal(isAggregateGrowth('GBR'), false);
    assert.equal(isAggregateGrowth('EUROQ'), true); // ends with Q
    assert.equal(isAggregateGrowth('WEOWORLD'), true);
    assert.equal(isAggregateGrowth('EU'), true);   // not 3-letter
    assert.equal(isAggregateGrowth(''), true);
    assert.equal(isAggregateGrowth('G20'), true);
  });

  it('latestValue picks the most recent finite year-keyed value', () => {
    const y = Number(YEAR);
    const series = { [`${y - 2}`]: 1.1, [`${y - 1}`]: 2.2 };
    const result = latestValueGrowth(series);
    assert.deepEqual(result, { value: 2.2, year: y - 1 });

    assert.equal(latestValueGrowth({}), null);
    assert.equal(latestValueGrowth({ [`${y}`]: 'NaN' }), null);
  });
});

describe('seed-imf-growth', () => {
  it('uses the v1 economic:imf:growth canonical key with 35-day TTL', () => {
    assert.equal(GROWTH_KEY, 'economic:imf:growth:v1');
    assert.equal(GROWTH_TTL, 35 * 24 * 3600);
  });

  it('buildGrowthCountries maps ISO3 → ISO2, drops aggregates, and computes savings-investment gap', () => {
    const countries = buildGrowthCountries({
      realGdpGrowth:       { USA: { [YEAR]: 2.5 }, GBR: { [YEAR]: 1.1 }, WEOWORLD: { [YEAR]: 3 } },
      nominalGdpPerCapita: { USA: { [YEAR]: 80000 }, GBR: { [YEAR]: 50000 } },
      realGdp:             { USA: { [YEAR]: 22000 } },
      pppPerCapita:        { USA: { [YEAR]: 80000 }, GBR: { [YEAR]: 55000 } },
      pppGdp:              { USA: { [YEAR]: 27000 } },
      investmentPct:       { USA: { [YEAR]: 21 }, GBR: { [YEAR]: 17.5 } },
      savingsPct:          { USA: { [YEAR]: 18 }, GBR: { [YEAR]: 14 } },
    });

    assert.ok(countries.US, 'USA → US');
    assert.equal(countries.US.realGdpGrowthPct, 2.5);
    assert.equal(countries.US.gdpPerCapitaUsd, 80000);
    assert.equal(countries.US.savingsInvestmentGap, -3);
    assert.equal(countries.US.year, Number(YEAR));

    assert.ok(countries.GB, 'GBR → GB');
    assert.equal(countries.GB.savingsInvestmentGap, -3.5);

    // Aggregates dropped (no entry for WEOWORLD).
    assert.ok(!('WEOWORLD' in countries));
    assert.ok(!('WW' in countries));
  });

  it('buildGrowthCountries omits countries with no usable data', () => {
    const countries = buildGrowthCountries({
      realGdpGrowth: { USA: { '1970': 2 } }, // year falls outside weoYears window
    });
    assert.ok(!('US' in countries), 'no IMF series for current window → no entry');
  });

  it('validate accepts 190+ countries and rejects partial snapshots', () => {
    const countries = {};
    for (let i = 0; i < 200; i++) countries[`X${i}`] = { realGdpGrowthPct: 1, year: 2025 };
    assert.equal(validateGrowth({ countries }), true);

    const partial = {};
    for (let i = 0; i < 170; i++) partial[`X${i}`] = { realGdpGrowthPct: 1, year: 2025 };
    assert.equal(validateGrowth({ countries: partial }), false, 'rejects 170 countries (dozens missing)');

    assert.equal(validateGrowth({ countries: {} }), false);
    assert.equal(validateGrowth(null), false);
  });
});

describe('seed-imf-labor', () => {
  it('uses the v1 labor canonical key with 35-day TTL', () => {
    assert.equal(LABOR_KEY, 'economic:imf:labor:v1');
    assert.equal(LABOR_TTL, 35 * 24 * 3600);
  });

  it('buildLaborCountries surfaces unemployment and population per ISO2 (LP raw persons → millions)', () => {
    // Plan 002 review fix: IMF SDMX `LP` returns Population in PERSONS
    // (raw count), not millions. Mock here matches real upstream shape:
    // US ≈ 333.3M people = 333_300_000 raw. The seeder now divides by 1e6
    // so the field name (populationMillions) matches its semantic.
    const countries = buildLaborCountries({
      unemployment: { USA: { [YEAR]: 4.1 }, FRA: { [YEAR]: 7.5 } },
      population:   { USA: { [YEAR]: 333_300_000 }, FRA: { [YEAR]: 67_900_000 }, ZAF: { [YEAR]: 60_200_000 } },
    });
    assert.deepEqual(countries.US, {
      unemploymentPct: 4.1, populationMillions: 333.3, year: Number(YEAR),
    });
    assert.deepEqual(countries.FR, {
      unemploymentPct: 7.5, populationMillions: 67.9, year: Number(YEAR),
    });
    // South Africa: only population (no LUR); still included.
    assert.deepEqual(countries.ZA, {
      unemploymentPct: null, populationMillions: 60.2, year: Number(YEAR),
    });
  });

  it('validate accepts 190+ countries and rejects partial snapshots', () => {
    const countries = {};
    for (let i = 0; i < 200; i++) countries[`X${i}`] = { populationMillions: 10, year: 2025 };
    assert.equal(validateLabor({ countries }), true);

    const partial = {};
    for (let i = 0; i < 170; i++) partial[`X${i}`] = { populationMillions: 10, year: 2025 };
    assert.equal(validateLabor({ countries: partial }), false, 'rejects 170 countries (dozens missing)');

    const sparse = {};
    for (let i = 0; i < 50; i++) sparse[`X${i}`] = { unemploymentPct: 5, year: 2025 };
    assert.equal(validateLabor({ countries: sparse }), false);
  });
});

describe('seed-imf-external', () => {
  it('uses the v1 external canonical key with 35-day TTL', () => {
    assert.equal(EXTERNAL_KEY, 'economic:imf:external:v1');
    assert.equal(EXTERNAL_TTL, 35 * 24 * 3600);
  });

  it('buildExternalCountries maps current account + volume changes and nulls out legacy BX/BM fields', () => {
    // BX/BM (export/import levels in USD) were removed 2026-04 — WEO coverage
    // dropped to ~10 countries on those indicators, collapsing the result
    // below the validate floor. Fields remain on the output as explicit null
    // so downstream consumers see a deliberate gap rather than a missing key.
    const countries = buildExternalCountries({
      currentAccount: { USA: { [YEAR]: -800 }, DEU: { [YEAR]: 250 } },
      importVol:      { USA: { [YEAR]: 4.2 } },
      exportVol:      { USA: { [YEAR]: 3.1 } },
    });
    assert.equal(countries.US.exportsUsd, null);
    assert.equal(countries.US.importsUsd, null);
    assert.equal(countries.US.tradeBalanceUsd, null);
    assert.equal(countries.US.currentAccountUsd, -800);
    assert.equal(countries.US.importVolumePctChg, 4.2);
    assert.equal(countries.US.exportVolumePctChg, 3.1);

    // Germany has only currentAccount — still included.
    assert.equal(countries.DE.currentAccountUsd, 250);
    assert.equal(countries.DE.importVolumePctChg, null);
  });

  it('buildExternalCountries drops countries with no usable indicator data', () => {
    const countries = buildExternalCountries({
      currentAccount: { USA: { [YEAR]: -800 } },
      importVol: {},
      exportVol: {},
    });
    assert.equal(Object.keys(countries).length, 1);
    assert.ok(countries.US);
  });

  it('validate gates >=180 country coverage (relaxed from 190 after BX/BM removal)', () => {
    const countries = {};
    for (let i = 0; i < 200; i++) countries[`X${i}`] = { currentAccountUsd: 1, year: 2025 };
    assert.equal(validateExternal({ countries }), true);

    // 180 is the new minimum (BCA ~209 / TM ~189 / TX ~190; union floor).
    const at180 = {};
    for (let i = 0; i < 180; i++) at180[`X${i}`] = { currentAccountUsd: 1, year: 2025 };
    assert.equal(validateExternal({ countries: at180 }), true, 'exactly 180 passes');

    const partial = {};
    for (let i = 0; i < 170; i++) partial[`X${i}`] = { currentAccountUsd: 1, year: 2025 };
    assert.equal(validateExternal({ countries: partial }), false, 'rejects 170 countries');

    assert.equal(validateExternal({ countries: {} }), false);
  });
});
