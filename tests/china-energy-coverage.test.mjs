import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSpineEntry } from '../scripts/seed-energy-spine.mjs';
import {
  hasJodiGasMeasurements,
  hasJodiOilMeasurements,
} from '../server/worldmonitor/intelligence/v1/get-country-energy-profile.ts';

const oilModule = await import('../scripts/seed-jodi-oil.mjs');
const gasModule = await import('../scripts/seed-jodi-gas.mjs');

function oilRecord(overrides = {}) {
  return {
    iso2: 'CN',
    dataMonth: '2026-05',
    gasoline: { demandKbd: 3200, importsKbd: 120 },
    diesel: { demandKbd: 4100, importsKbd: 90 },
    crude: { importsKbd: 11_200 },
    seededAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

function gasRecord(overrides = {}) {
  return {
    iso2: 'CN',
    dataMonth: '2026-05',
    totalDemandTj: 1_100_000,
    lngImportsTj: 280_000,
    pipeImportsTj: 190_000,
    seededAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('China JODI content validation', () => {
  it('exports dedicated oil and gas validators', () => {
    assert.equal(typeof oilModule.assessChinaOilCoverage, 'function');
    assert.equal(typeof gasModule.assessChinaGasCoverage, 'function');
  });

  it('accepts present, recent China oil and gas records', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');
    const oil = oilModule.assessChinaOilCoverage([oilRecord()], now);
    const gas = gasModule.assessChinaGasCoverage([gasRecord()], now);

    assert.deepEqual(oil, { ok: true, reason: null, dataMonth: '2026-05', ageMonths: 2 });
    assert.deepEqual(gas, { ok: true, reason: null, dataMonth: '2026-05', ageMonths: 2 });
  });

  it('rejects globally broad snapshots that omit China', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');
    const otherCountries = Array.from({ length: 60 }, (_, index) => ({
      ...gasRecord({ iso2: `X${index}` }),
    }));

    assert.deepEqual(
      oilModule.assessChinaOilCoverage([oilRecord({ iso2: 'US' })], now),
      { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null },
    );
    assert.deepEqual(
      gasModule.assessChinaGasCoverage(otherCountries, now),
      { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null },
    );
  });

  it('rejects stale source months even when seededAt is fresh', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');
    const freshFetch = '2026-07-13T00:00:00.000Z';

    assert.deepEqual(
      oilModule.assessChinaOilCoverage([oilRecord({ dataMonth: '2025-12', seededAt: freshFetch })], now),
      { ok: false, reason: 'china-stale', dataMonth: '2025-12', ageMonths: 7 },
    );
    assert.deepEqual(
      gasModule.assessChinaGasCoverage([gasRecord({ dataMonth: '2025-12', seededAt: freshFetch })], now),
      { ok: false, reason: 'china-stale', dataMonth: '2025-12', ageMonths: 7 },
    );
  });

  it('rejects malformed/future source months and payloads with no measurements', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');

    assert.equal(oilModule.assessChinaOilCoverage([oilRecord({ dataMonth: 'not-a-month' })], now).reason, 'china-invalid-month');
    assert.equal(gasModule.assessChinaGasCoverage([gasRecord({ dataMonth: '2026-08' })], now).reason, 'china-invalid-month');
    assert.equal(
      oilModule.assessChinaOilCoverage([oilRecord({ gasoline: {}, diesel: {}, crude: {} })], now).reason,
      'china-no-measurements',
    );
    assert.equal(
      gasModule.assessChinaGasCoverage([gasRecord({ totalDemandTj: null, lngImportsTj: null, pipeImportsTj: null })], now).reason,
      'china-no-measurements',
    );
  });
});

describe('China energy spine availability', () => {
  it('marks empty JODI payloads unavailable and preserves unknown values as null', () => {
    const spine = buildSpineEntry('CN', {
      mix: null,
      jodiOil: { dataMonth: '2026-05', gasoline: {}, diesel: {}, crude: {} },
      jodiGas: { dataMonth: '2026-05', totalDemandTj: null, lngImportsTj: null, pipeImportsTj: null },
      ieaStocks: null,
    });

    assert.equal(spine.coverage.hasJodiOil, false);
    assert.equal(spine.coverage.hasJodiGas, false);
    assert.equal(spine.oil.crudeImportsKbd, null);
    assert.equal(spine.oil.gasolineDemandKbd, null);
    assert.equal(spine.gas.totalDemandTj, null);
    assert.equal(spine.gas.lngImportsTj, null);
  });

  it('treats legitimate zeroes as available measurements', () => {
    const spine = buildSpineEntry('CN', {
      mix: null,
      jodiOil: { dataMonth: '2026-05', crude: { importsKbd: 0 } },
      jodiGas: { dataMonth: '2026-05', totalDemandTj: 100, lngImportsTj: 0, pipeImportsTj: 0 },
      ieaStocks: null,
    });

    assert.equal(spine.coverage.hasJodiOil, true);
    assert.equal(spine.coverage.hasJodiGas, true);
    assert.equal(spine.oil.crudeImportsKbd, 0);
    assert.equal(spine.gas.lngImportsTj, 0);
    assert.equal(spine.shockInputs.comtradeReporterCode, '156');
  });

  it('reports oil and gas availability independently for partial China coverage', () => {
    const spine = buildSpineEntry('CN', {
      mix: null,
      jodiOil: oilRecord(),
      jodiGas: null,
      ieaStocks: null,
    });

    assert.equal(spine.coverage.hasJodiOil, true);
    assert.equal(spine.coverage.hasJodiGas, false);
    assert.equal(spine.oil.crudeImportsKbd, 11_200);
    assert.equal(spine.gas.totalDemandTj, null);
  });

  it('uses the same truthful measurement predicates in the direct API fallback', () => {
    assert.equal(hasJodiOilMeasurements(null), false);
    assert.equal(hasJodiOilMeasurements({ dataMonth: '2026-05', gasoline: {}, crude: {} }), false);
    assert.equal(hasJodiOilMeasurements({ dataMonth: '2026-05', crude: { importsKbd: 0 } }), true);

    assert.equal(hasJodiGasMeasurements(null), false);
    assert.equal(hasJodiGasMeasurements({ dataMonth: '2026-05', totalDemandTj: null }), false);
    assert.equal(hasJodiGasMeasurements({ dataMonth: '2026-05', lngImportsTj: 0 }), true);
  });
});
