import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildSpineEntry } from '../scripts/seed-energy-spine.mjs';
import {
  MAX_JODI_CONTENT_AGE_MIN,
  MIN_JODI_CONTENT_AGE_COUNTRIES,
  buildChinaRowDiagnostic,
  jodiDatasetContentMeta,
} from '../scripts/shared/jodi-content-age.mjs';
import { monthPeriodEnd } from '../scripts/shared/jodi-demand-change.mjs';
import { __testing__ as healthTesting } from '../api/health.js';
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

  it('reports the country-floor shortfall that is the only oil publish refusal', () => {
    const reason = oilModule.formatCoverageFailureReason({ countryCount: 39 });

    assert.match(reason, /only 39 countries with usable measurements, need >=40/);
    assert.doesNotMatch(reason, /China/i, 'China must never appear in a publish refusal');
  });
});

// Issue #6395. On 2026-08-10 both JODI files still carried China, but every
// China row was ASSESSMENT_CODE 3 ("null/uncertain"), which both parsers
// correctly discard — so China resolved to `china-missing` and the China gate
// discarded 51 oil and 63 gas country payloads that had parsed cleanly. One
// country must never withhold the rest of the dataset.
describe('JODI publishes the rest of the world without China (#6395)', () => {
  const NOW = new Date('2026-08-10T00:00:00.000Z');
  const GAS_CSV_HEADER = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE';

  /** A world file where China reports only unusable (code 3) rows. */
  function gasCsvWithChinaCode3(countryCount) {
    const lines = [GAS_CSV_HEADER];
    for (let index = 0; index < countryCount; index++) {
      const iso2 = `X${String(index).padStart(2, '0')}`;
      lines.push(`${iso2},2026-05,NATGAS,IMPLNG,TJ,95000,1`);
      lines.push(`${iso2},2026-05,NATGAS,TOTIMPSB,TJ,380000,1`);
    }
    for (const flow of ['IMPLNG', 'TOTIMPSB', 'TOTDEMO']) {
      lines.push(`CN,2026-05,NATGAS,${flow},TJ,1200000,3`);
    }
    return lines.join('\n');
  }

  function oilRowsWithChinaCode3(countryCount) {
    const rows = [];
    for (let index = 0; index < countryCount; index++) {
      rows.push({
        REF_AREA: `X${String(index).padStart(2, '0')}`,
        TIME_PERIOD: '2026-05',
        ENERGY_PRODUCT: 'GASDIES',
        FLOW_BREAKDOWN: 'TOTDEMO',
        UNIT_MEASURE: 'KBD',
        OBS_VALUE: '894.4',
        ASSESSMENT_CODE: '1',
      });
    }
    for (const product of ['GASDIES', 'GASOLINE', 'JETKERO']) {
      rows.push({
        REF_AREA: 'CN',
        TIME_PERIOD: '2026-05',
        ENERGY_PRODUCT: product,
        FLOW_BREAKDOWN: 'TOTDEMO',
        UNIT_MEASURE: 'KBD',
        OBS_VALUE: '3200',
        ASSESSMENT_CODE: '3',
      });
    }
    return rows;
  }

  it('gas: keeps every other country when China parses to nothing usable', () => {
    const records = gasModule.buildGasRecordsFromCsv(gasCsvWithChinaCode3(63), NOW);

    assert.equal(records.length, 63, 'the 63 parsed countries must survive the run');
    assert.equal(records.some((record) => record.iso2 === 'CN'), false);
    assert.equal(
      gasModule.validateGasCountries(records.map((record) => record.iso2)),
      true,
      'runSeed validateFn is the only gas publish gate and it must pass',
    );
    assert.equal(gasModule.assessChinaGasCoverage(records, NOW).reason, 'china-missing');
  });

  it('oil: publishes when China is unusable and refuses only below the country floor', () => {
    const publishable = oilModule.prepareOilPublish({
      allRows: oilRowsWithChinaCode3(45),
      previousMeta: null,
      now: NOW,
    });

    assert.equal(publishable.refusalReason, null, 'an unusable China row must not refuse the publish');
    assert.equal(publishable.countries.length, 45);
    assert.equal(publishable.chinaCoverage.reason, 'china-missing');
    assert.equal(publishable.metaPayload.recordCount, 45);
    assert.equal(publishable.metaPayload.chinaRow.ok, false);

    const refused = oilModule.prepareOilPublish({
      allRows: oilRowsWithChinaCode3(39),
      previousMeta: null,
      now: NOW,
    });

    assert.match(refused.refusalReason, /only 39 countries with usable measurements, need >=40/);
    assert.doesNotMatch(refused.refusalReason, /China/i);
  });

  it('oil: records the content-age trio the replacement staleness alarm reads', () => {
    const { metaPayload } = oilModule.prepareOilPublish({
      allRows: oilRowsWithChinaCode3(45),
      previousMeta: null,
      now: NOW,
    });

    assert.equal(metaPayload.newestItemAt, Date.parse(monthPeriodEnd('2026-05')));
    assert.equal(metaPayload.oldestItemAt, Date.parse(monthPeriodEnd('2026-05')));
    assert.equal(metaPayload.maxContentAgeMin, MAX_JODI_CONTENT_AGE_MIN);
  });

  it('the country floor counts countries that carry a measurement, not rows that parsed', () => {
    // 45 countries reach the file, but only 39 report a usable value. Before
    // #6395 an unusable China row was the incidental canary for this; the floor
    // itself has to catch it now.
    const rows = oilRowsWithChinaCode3(39);
    for (let index = 0; index < 6; index++) {
      rows.push({
        REF_AREA: `E${String(index).padStart(2, '0')}`,
        TIME_PERIOD: '2026-05',
        ENERGY_PRODUCT: 'GASDIES',
        FLOW_BREAKDOWN: 'TOTDEMO',
        UNIT_MEASURE: 'KBD',
        OBS_VALUE: '-',
        ASSESSMENT_CODE: '1',
      });
    }

    const refused = oilModule.prepareOilPublish({ allRows: rows, previousMeta: null, now: NOW });
    assert.equal(refused.parsedCount, 45, 'all 45 countries still parse');
    assert.match(refused.refusalReason, /only 39 countries with usable measurements/);
    assert.equal(refused.countries.some((country) => country.iso2.startsWith('E')), false);

    // Gas drops the same shape rather than publishing an all-null record over
    // that country's last-good key.
    const gasCsv = [
      GAS_CSV_HEADER,
      ...Array.from({ length: 55 }, (_, index) => {
        const iso2 = `X${String(index).padStart(2, '0')}`;
        return `${iso2},2026-05,NATGAS,IMPLNG,TJ,95000,1`;
      }),
      // Reports a flow, but with no readable value — a row, not coverage.
      'ZZ,2026-05,NATGAS,IMPLNG,TJ,-,1',
    ].join('\n');
    const gasRecords = gasModule.buildGasRecordsFromCsv(gasCsv, NOW);
    assert.equal(gasRecords.length, 55);
    assert.equal(gasRecords.some((record) => record.iso2 === 'ZZ'), false);
  });

  it('dates the China gap once and carries that date across later runs', () => {
    const firstSeen = Date.UTC(2026, 5, 1);
    const absent = { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null };

    const first = buildChinaRowDiagnostic(absent, null, firstSeen);
    assert.deepEqual(first, {
      ok: false,
      reason: 'china-missing',
      dataMonth: null,
      ageMonths: null,
      unavailableSince: firstSeen,
    });

    const later = buildChinaRowDiagnostic(absent, first, Date.UTC(2026, 7, 10));
    assert.equal(later.unavailableSince, firstSeen, 'the gap must not look new on every tick');

    const recovered = buildChinaRowDiagnostic(
      { ok: true, reason: null, dataMonth: '2026-06', ageMonths: 2 },
      later,
      Date.UTC(2026, 8, 10),
    );
    assert.deepEqual(recovered, {
      ok: true,
      reason: null,
      dataMonth: '2026-06',
      ageMonths: 2,
      unavailableSince: null,
    });
  });

  const hasMeasurement = (record) => record.usable === true;
  const reporters = (dataMonth, count, usable = true) =>
    Array.from({ length: count }, () => ({ dataMonth, usable }));

  it('dates dataset content age from the newest month that carries a measurement', () => {
    const contentMeta = jodiDatasetContentMeta([
      ...reporters('2026-01', 3),
      ...reporters('2025-11', 3),
      // A newer month whose every field parsed to null proves the download
      // happened, never that the file still holds current observations.
      ...reporters('2026-05', 5, false),
      ...reporters('not-a-month', 5),
      // Mis-dated countries must not vouch for the whole file's freshness.
      ...reporters('2027-03', 5),
    ], hasMeasurement, NOW);

    assert.deepEqual(contentMeta, {
      newestItemAt: Date.parse(monthPeriodEnd('2026-01')),
      oldestItemAt: Date.parse(monthPeriodEnd('2025-11')),
    });
    assert.equal(jodiDatasetContentMeta(reporters('2026-01', 5, false), hasMeasurement, NOW), null);
    assert.equal(jodiDatasetContentMeta(reporters('2027-03', 5), hasMeasurement, NOW), null);
    assert.equal(jodiDatasetContentMeta(null, hasMeasurement, NOW), null);
  });

  it('dates content age when called with epoch ms, which is what runSeed passes', () => {
    // runSeed invokes the hook as `contentMeta(data, startMs)` — a NUMBER
    // (scripts/_seed-utils.mjs). This helper used to demand `now instanceof
    // Date` and return null for anything else, and a null newestItemAt is read
    // as STALE_CONTENT by api/health.js. jodiGas and lngVulnerability were
    // therefore permanently stale no matter how current the file was (#6799).
    //
    // Every other test here passes `NOW`, a Date — which is exactly why the
    // real call shape was never exercised.
    const records = reporters('2026-01', 3);
    const fromDate = jodiDatasetContentMeta(records, hasMeasurement, NOW);
    const fromEpochMs = jodiDatasetContentMeta(records, hasMeasurement, NOW.getTime());

    assert.ok(fromDate, 'fixture must produce a datable month');
    assert.deepEqual(fromEpochMs, fromDate, 'epoch ms and Date must agree');

    // The future-month rejection has to survive the number path too, or the
    // fix would trade a false stale for a file dated by mis-stamped rows.
    assert.equal(
      jodiDatasetContentMeta(reporters('2027-03', 5), hasMeasurement, NOW.getTime()),
      null,
    );
    // A genuinely unusable clock still refuses to date the file.
    assert.equal(jodiDatasetContentMeta(records, hasMeasurement, Number.NaN), null);
    assert.equal(jodiDatasetContentMeta(records, hasMeasurement, null), null);
  });

  it('one fast reporter cannot date a file everyone else stopped updating', () => {
    // JODI carries a long reporting tail — a single country sitting on a
    // current month while the leading cohort is frozen must not read as fresh.
    const frozenFileWithOneLeader = [
      ...reporters('2026-06', MIN_JODI_CONTENT_AGE_COUNTRIES - 1),
      ...reporters('2025-09', 40),
    ];

    assert.equal(
      jodiDatasetContentMeta(frozenFileWithOneLeader, hasMeasurement, NOW).newestItemAt,
      Date.parse(monthPeriodEnd('2025-09')),
      'the quorum month dates the file, not the leader',
    );
    assert.equal(
      jodiDatasetContentMeta(
        [...reporters('2026-06', MIN_JODI_CONTENT_AGE_COUNTRIES), ...reporters('2025-09', 40)],
        hasMeasurement,
        NOW,
      ).newestItemAt,
      Date.parse(monthPeriodEnd('2026-06')),
      'once a quorum reports the newer month, the file is dated by it',
    );
  });

  it('gas reads its previous run to age the gap, and re-dates it when it cannot', async () => {
    const records = gasModule.buildGasRecordsFromCsv(gasCsvWithChinaCode3(63), NOW);
    const firstSeen = Date.parse('2026-06-01T00:00:00.000Z');

    const carried = await gasModule.buildGasChinaRowDiagnostic(records, NOW, {
      readPreviousMeta: async () => ({
        chinaRow: { ok: false, reason: 'china-missing', unavailableSince: firstSeen },
      }),
    });
    assert.equal(carried.reason, 'china-missing');
    assert.equal(carried.unavailableSince, firstSeen);

    // Documented best-effort behaviour: with no readable previous record the
    // gap can only be dated from this run.
    const unreadable = await gasModule.buildGasChinaRowDiagnostic(records, NOW, {
      readPreviousMeta: async () => null,
    });
    assert.equal(unreadable.unavailableSince, NOW.getTime());
  });

  it('a frozen upstream file reads STALE_CONTENT instead of publishing silently', () => {
    const { classifyKey, STANDALONE_KEYS, SEED_META } = healthTesting;
    const now = Date.parse('2026-08-10T00:00:00.000Z');
    const key = STANDALONE_KEYS.jodiGas;
    const metaKey = SEED_META.jodiGas.key;

    const classify = (newestMonth) => classifyKey('jodiGas', key, {}, {
      keyStrens: new Map([[key, 4096]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 63,
        newestItemAt: Date.parse(monthPeriodEnd(newestMonth)),
        oldestItemAt: Date.parse(monthPeriodEnd('2024-01')),
        maxContentAgeMin: MAX_JODI_CONTENT_AGE_MIN,
        chinaRow: {
          ok: false,
          reason: 'china-missing',
          dataMonth: null,
          ageMonths: null,
          unavailableSince: Date.parse('2026-06-01T00:00:00.000Z'),
        },
      })]]),
      keyMetaErrors: new Map(),
      now,
    });

    // The observed 2026-08-10 state: gas has not moved past 2026-01.
    const frozen = classify('2026-01');
    assert.equal(frozen.status, 'STALE_CONTENT');
    // The China gap rides along on every verdict, named, so an operator never
    // has to read Railway logs to learn which country dropped out.
    assert.deepEqual(frozen.chinaRow, {
      ok: false,
      reason: 'china-missing',
      dataMonth: null,
      ageMonths: null,
      unavailableSince: Date.parse('2026-06-01T00:00:00.000Z'),
    });

    // ...and a live upstream stays OK: an absent China alone never warns.
    const current = classify('2026-06');
    assert.equal(current.status, 'OK');
    assert.equal(current.chinaRow.reason, 'china-missing');
  });

  it('bounds the chinaRow relay so a producer cannot put arbitrary values on a public endpoint', () => {
    const { classifyKey, STANDALONE_KEYS, SEED_META } = healthTesting;
    const now = Date.parse('2026-08-10T00:00:00.000Z');
    const key = STANDALONE_KEYS.jodiGas;
    const metaKey = SEED_META.jodiGas.key;

    const classifyWith = (meta, name = 'jodiGas', dataKey = key, metaK = metaKey) =>
      classifyKey(name, dataKey, {}, {
        keyStrens: new Map([[dataKey, 4096]]),
        keyErrors: new Map(),
        keyMetaValues: new Map([[metaK, JSON.stringify({
          fetchedAt: now - 60_000,
          recordCount: 63,
          newestItemAt: Date.parse(monthPeriodEnd('2026-06')),
          oldestItemAt: Date.parse(monthPeriodEnd('2024-01')),
          maxContentAgeMin: MAX_JODI_CONTENT_AGE_MIN,
          ...meta,
        })]]),
        keyMetaErrors: new Map(),
        now,
      });

    // Free-text reason, junk month, non-numeric age, and a string timestamp all
    // collapse to null rather than reaching the wire.
    const junk = classifyWith({
      chinaRow: {
        ok: false,
        reason: 'whatever the producer felt like writing',
        dataMonth: 'not-a-month',
        ageMonths: 'lots',
        unavailableSince: 'yesterday',
      },
    });
    assert.deepEqual(junk.chinaRow, {
      ok: false,
      reason: null,
      dataMonth: null,
      ageMonths: null,
      unavailableSince: null,
    });

    // A healthy China row never carries an outage start date.
    const healthy = classifyWith({
      chinaRow: {
        ok: true,
        reason: null,
        dataMonth: '2026-05',
        ageMonths: 3,
        unavailableSince: Date.parse('2026-06-01T00:00:00.000Z'),
      },
    });
    assert.deepEqual(healthy.chinaRow, {
      ok: true,
      reason: null,
      dataMonth: '2026-05',
      ageMonths: 3,
      unavailableSince: null,
    });

    // A non-object block, and a key that never opted in, publish nothing.
    assert.equal(classifyWith({ chinaRow: 'china-missing' }).chinaRow, undefined);
    assert.equal(classifyWith({}).chinaRow, undefined);
    assert.equal(
      classifyWith(
        { chinaRow: { ok: false, reason: 'china-missing' } },
        'eiaPetroleum',
        STANDALONE_KEYS.eiaPetroleum,
        SEED_META.eiaPetroleum.key,
      ).chinaRow,
      undefined,
      'only the three JODI-backed checks opt in',
    );

    // A producer that reported status:'error' never got as far as assessing
    // China; last run's verdict must not be relayed as this run's.
    const errored = classifyWith({ status: 'error', chinaRow: { ok: false, reason: 'china-missing' } });
    assert.equal(errored.chinaRow, undefined);
  });

  it('keeps the named China gap out of the anonymous compact body', () => {
    const { healthResponseBody } = healthTesting;
    const chinaRow = { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null, unavailableSince: 1 };
    const snapshot = {
      status: 'DEGRADED',
      summary: {},
      checkedAt: '2026-08-10T00:00:00.000Z',
      checks: { jodiGas: { status: 'STALE_CONTENT', records: 57, chinaRow } },
    };

    // Same rule the contentFreshness/decisionGroups scrub follows: the STATUS
    // is public, the named entity behind it is operator-only.
    const compact = healthResponseBody(snapshot, true);
    assert.equal(compact.problems.jodiGas.status, 'STALE_CONTENT');
    assert.equal(compact.problems.jodiGas.chinaRow, undefined);
    // ...and a cached compact snapshot written before the rule is scrubbed too.
    assert.equal(
      healthResponseBody({ ...snapshot, checks: undefined, problems: { jodiGas: { status: 'STALE_CONTENT', chinaRow } } }, true)
        .problems.jodiGas.chinaRow,
      undefined,
    );
    // The operator view keeps it.
    assert.deepEqual(healthResponseBody(snapshot, false).checks.jodiGas.chinaRow, chinaRow);
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
