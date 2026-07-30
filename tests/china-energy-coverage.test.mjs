import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildSpineEntry } from '../scripts/seed-energy-spine.mjs';
import { withRetry } from '../scripts/_seed-utils.mjs';
import {
  buildResponseFromSpine,
  getObservedJodiGasMeasurements,
  getObservedJodiOilMeasurements,
  hasJodiGasMeasurements,
  hasJodiOilMeasurements,
} from '../server/worldmonitor/intelligence/v1/get-country-energy-profile.ts';

const oilModule = await import('../scripts/seed-jodi-oil.mjs');
const gasModule = await import('../scripts/seed-jodi-gas.mjs');
const require = createRequire(import.meta.url);
const measurementFields = require('../scripts/shared/jodi-measurement-fields.json');

function recordWithMeasurement(path, value = 1) {
  const record = { dataMonth: '2026-05' };
  const parts = path.split('.');
  let current = record;
  for (const part of parts.slice(0, -1)) {
    current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
  return record;
}

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

  it('drives the seeder gates from the public-profile measurement catalogue', () => {
    const now = new Date('2026-07-13T00:00:00.000Z');

    for (const path of measurementFields.oil) {
      const record = { iso2: 'CN', ...recordWithMeasurement(path, 0) };
      assert.equal(oilModule.assessChinaOilCoverage([record], now).ok, true, `oil field ${path}`);
    }
    for (const path of measurementFields.gas) {
      const record = { iso2: 'CN', ...recordWithMeasurement(path, 0) };
      assert.equal(gasModule.assessChinaGasCoverage([record], now).ok, true, `gas field ${path}`);
    }

    assert.equal(
      oilModule.assessChinaOilCoverage([{ iso2: 'CN', dataMonth: '2026-05', crude: { productionKbd: 1 } }], now).reason,
      'china-no-measurements',
    );
    assert.equal(
      gasModule.assessChinaGasCoverage([{ iso2: 'CN', dataMonth: '2026-05', productionTj: 1 }], now).reason,
      'china-no-measurements',
    );
  });

  it('reports global and China oil coverage failures together', () => {
    const reason = oilModule.formatCoverageFailureReason({
      hasGlobalCoverage: false,
      countryCount: 50,
      chinaCoverage: { ok: false, reason: 'china-stale', dataMonth: '2025-12' },
    });

    assert.match(reason, /only 50 countries, need >=40/);
    assert.match(reason, /China JODI oil coverage failed: china-stale \(dataMonth=2025-12\)/);
  });

  it('preserves prior gas country keys and does not retry deterministic China rejection', async () => {
    const ttlExtensions = [];
    let attempts = 0;

    await assert.rejects(
      () => withRetry(
        async () => {
          attempts++;
          return gasModule.enforceChinaGasCoverage(
            [gasRecord({ iso2: 'US' })],
            new Date('2026-07-13T00:00:00.000Z'),
            {
              readSnapshot: async () => ['US', 'CN', 'invalid'],
              extendTtl: async (keys, ttlSeconds) => { ttlExtensions.push({ keys, ttlSeconds }); },
            },
          );
        },
        3,
        0,
      ),
      (error) => {
        assert.match(error.message, /China JODI gas coverage failed: china-missing/);
        assert.equal(error.nonRetryable, true);
        return true;
      },
    );

    assert.equal(attempts, 1, 'deterministic coverage rejection must not redownload the JODI ZIP');
    assert.deepEqual(ttlExtensions, [{
      keys: ['energy:jodi-gas:v1:US', 'energy:jodi-gas:v1:CN'],
      ttlSeconds: gasModule.GAS_TTL,
    }]);
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

    assert.deepEqual(
      getObservedJodiOilMeasurements({ dataMonth: '2026-05', crude: { importsKbd: 0 }, gasoline: { demandKbd: null } }),
      ['crude.importsKbd'],
    );
    assert.deepEqual(
      getObservedJodiGasMeasurements({ dataMonth: '2026-05', lngImportsTj: 0, totalDemandTj: null }),
      ['lngImportsTj'],
    );
  });

  it('exposes per-field presence for partial API responses without breaking scalar defaults', () => {
    const response = buildResponseFromSpine({
      coverage: { hasJodiOil: true, hasJodiGas: true },
      sources: { jodiOilMonth: '2026-05', jodiGasMonth: '2026-05' },
      oil: { crudeImportsKbd: 0, gasolineDemandKbd: null },
      gas: { lngImportsTj: 0, totalDemandTj: null },
    }, null, null, null, null);

    assert.equal(response.crudeImportsKbd, 0, 'legitimate zero remains a numeric zero');
    assert.equal(response.gasolineDemandKbd, 0, 'legacy scalar default remains backward-compatible');
    assert.deepEqual(response.jodiOilObservedMeasurements, ['crude.importsKbd']);
    assert.deepEqual(response.jodiGasObservedMeasurements, ['lngImportsTj']);
  });

  it('derives both spine and API availability from the shared measurement field catalogue', () => {
    for (const path of measurementFields.oil) {
      const record = recordWithMeasurement(path);
      const spine = buildSpineEntry('CN', { mix: null, jodiOil: record, jodiGas: null, ieaStocks: null });
      assert.equal(spine.coverage.hasJodiOil, true, `spine oil field ${path}`);
      assert.equal(hasJodiOilMeasurements(record), true, `API oil field ${path}`);
    }

    for (const path of measurementFields.gas) {
      const record = recordWithMeasurement(path, 0);
      const spine = buildSpineEntry('CN', { mix: null, jodiOil: null, jodiGas: record, ieaStocks: null });
      assert.equal(spine.coverage.hasJodiGas, true, `spine gas field ${path}`);
      assert.equal(hasJodiGasMeasurements(record), true, `API gas field ${path}`);
    }
  });
});
