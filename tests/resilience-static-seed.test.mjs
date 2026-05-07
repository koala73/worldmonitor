import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESILIENCE_STATIC_INDEX_KEY,
  RESILIENCE_STATIC_META_KEY,
  RESILIENCE_STATIC_SOURCE_VERSION,
  buildFailureRefreshKeys,
  buildFaoAggregate,
  buildManifest,
  buildTradeToGdpMap,
  countryRedisKey,
  createCountryResolvers,
  finalizeCountryPayloads,
  gpiUrlForYear,
  resolveGpiCsv,
  buildAquastatWbMap,
  parseEurostatEnergyDataset,
  parseFsinRows,
  parseGpiRows,
  parseRsfRanking,
  recoverFailedDatasets,
  resolveIso2,
  shouldSkipSeedYear,
  transformWhoPhysicianDensity,
} from '../scripts/seed-resilience-static.mjs';

// Helpers for inline CSV construction
function csvRows(header, rows) {
  return [header, ...rows].join('\n');
}

// Builds a minimal GPI CSV with `count` real ISO3 codes so parseGpiRows clears the 50-country guard.
// Uses a fixed list of well-known ISO3 codes; the resolver falls back to built-in maps.
const GPI_ISO3_POOL = [
  'NOR','USA','YEM','DEU','FRA','GBR','JPN','CHN','IND','BRA',
  'ZAF','NGA','KEN','EGY','SAU','IRN','IRQ','AFG','SYR','SDN',
  'ETH','SOM','COD','MMR','VEN','COL','MEX','ARG','CHL','PER',
  'TUR','UKR','RUS','POL','SWE','DNK','FIN','NLD','BEL','CHE',
  'AUT','CZE','HUN','ROU','BGR','GRC','PRT','ESP','ITA','CAN',
  'AUS','NZL','THA','IDN','PHL','VNM','BGD','PAK','LKA','MAR',
];
function makeGpiCsv(count = 55) {
  const header = 'code,rank,index_over,year';
  const rows = GPI_ISO3_POOL.slice(0, count).map((iso3, i) =>
    `${iso3},${i + 1},${(1.1 + i * 0.03).toFixed(3)},2025`,
  );
  return csvRows(header, rows);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function makeResolvers() {
  return createCountryResolvers(
    {
      norway: 'NO',
      'united states': 'US',
      yemen: 'YE',
      'cape verde': 'CV',
    },
    { NOR: 'NO', USA: 'US', YEM: 'YE', CPV: 'CV' },
  );
}

describe('resilience static seed country normalization', () => {
  const resolvers = makeResolvers();

  it('resolves explicit fixture countries from ISO3 and aliases', () => {
    assert.equal(resolveIso2({ iso3: 'NOR' }, resolvers), 'NO');
    assert.equal(resolveIso2({ iso3: 'USA' }, resolvers), 'US');
    assert.equal(resolveIso2({ iso3: 'YEM' }, resolvers), 'YE');
    assert.equal(resolveIso2({ name: 'Cape Verde' }, resolvers), 'CV');
    assert.equal(resolveIso2({ name: 'OECS' }, resolvers), null);
  });
});

describe('resilience static seed CSV parsers', () => {
  describe('parseGpiRows', () => {
    it('parses GPI CSV with standard columns and uses row year field', () => {
      const csv = makeGpiCsv();
      const result = parseGpiRows(csv, 2025);
      assert.ok(result.size >= 50, `expected >=50 entries, got ${result.size}`);
      const no = result.get('NO');
      assert.ok(no != null, 'NO should resolve from NOR');
      assert.equal(no.source, 'gpi-voh');
      assert.equal(no.year, 2025);
      assert.ok(no.score > 0);
      assert.ok(no.rank > 0);
    });

    it('falls back to resolvedYear when row.year is absent', () => {
      const header = 'code,rank,index_over';
      const rows = GPI_ISO3_POOL.slice(0, 55).map((iso3, i) => `${iso3},${i + 1},${(1.1 + i * 0.03).toFixed(3)}`);
      const csv = csvRows(header, rows);
      const result = parseGpiRows(csv, 2024);
      assert.equal(result.get('NO')?.year, 2024, 'should use resolvedYear when row.year is missing');
    });

    it('throws when fewer than 50 valid countries parse', () => {
      const csv = csvRows('code,rank,index_over,year', ['NOR,1,1.100,2025', 'USA,2,1.200,2025']);
      assert.throws(() => parseGpiRows(csv, 2025), /only 2 countries/);
    });

    it('gpiUrlForYear produces the expected path', () => {
      const url = gpiUrlForYear(2025);
      assert.match(url, /visionofhumanity\.org/);
      assert.match(url, /\/2025\/06\/GPI_2025_2025\.csv/);
    });

    it('resolveGpiCsv falls back to prior year on 404, without proxying the 404 URL', async () => {
      const notFound = Object.assign(new Error('HTTP 404'), { status: 404 });
      const fallbackCsv = makeGpiCsv();
      const proxiedUrls = [];
      const directFetch = async (url) => {
        if (url.includes('2026')) throw notFound;
        return { text: fallbackCsv };
      };
      const retryFetch = async (url) => {
        proxiedUrls.push(url);
        return { text: fallbackCsv };
      };
      const { resolvedYear, csvText } = await resolveGpiCsv(2026, { directFetch, retryFetch });
      assert.equal(resolvedYear, 2025, '404 on current year must resolve to prior year');
      assert.equal(csvText, fallbackCsv);
      assert.ok(proxiedUrls.every(url => !url.includes('2026')), '2026 URL must never be sent to proxy/retry — only 2025 fallback may use it');
    });

    it('resolveGpiCsv propagates non-404 errors without falling back', async () => {
      const serverError = Object.assign(new Error('HTTP 503'), { status: 503 });
      const directFetch = async () => { throw serverError; };
      await assert.rejects(
        () => resolveGpiCsv(2026, { directFetch }),
        (err) => err.status === 503,
        'non-404 HTTP errors must propagate as dataset failures, not swallowed as missing year',
      );
    });
  });

  describe('parseFsinRows', () => {
    it('parses new-schema column names (Phase 3+ #) and outputs peopleInCrisis + phase', () => {
      const csv = csvRows(
        'Country (ISO3),Phase 3+ #,Phase 4 #,Phase 5 #,Period',
        ['YEM,13500000,6200000,161000,2025-03'],
      );
      const result = parseFsinRows(csv);
      const ye = result.get('YE');
      assert.ok(ye != null, 'YE should be present');
      // phase3plus (13.5M) maps to peopleInCrisis — this is what scoreFoodWater() reads.
      assert.equal(ye.peopleInCrisis, 13500000);
      assert.equal(ye.phase, 'IPC Phase 5', 'Phase 5 present → highest active phase is 5');
      assert.equal(ye.year, 2025);
      assert.equal(ye.source, 'hdx-ipc');
    });

    it('parses legacy-schema column names (Phase 3+ number current)', () => {
      const csv = csvRows(
        'Country,Phase 3+ number current,Phase 4 number current,Phase 5 number current,reference_year',
        ['SOM,7800000,3100000,0,2024'],
      );
      const result = parseFsinRows(csv);
      const so = result.get('SO');
      assert.ok(so != null, 'SO should be present');
      assert.equal(so.peopleInCrisis, 7800000);
      assert.equal(so.phase, 'IPC Phase 4', 'Phase 5=0 → highest active phase is 4');
      assert.equal(so.year, 2024);
    });

    it('skips rows with zero or null phase values (IPC only lists active crises)', () => {
      // HDX IPC data only includes countries with active food crises.
      // Empty cells (→ safeNum('')=0) and missing columns should both be skipped.
      const csv = csvRows(
        'Country (ISO3),Phase 3+ #,Phase 4 #,Phase 5 #,Period',
        ['NOR,0,0,0,2025-01', 'YEM,13500000,6200000,161000,2025-03'],
      );
      const result = parseFsinRows(csv);
      assert.ok(!result.has('NO'), 'NO should be skipped (all phases are zero)');
      assert.ok(result.has('YE'));
    });

    it('throws when no usable rows parsed', () => {
      const csv = csvRows('Country (ISO3),Phase 3+ #', ['UNKNOWN,100']);
      assert.throws(() => parseFsinRows(csv), /no usable rows/);
    });
  });

  describe('buildFaoAggregate', () => {
    const seededAt = '2026-04-13T08:00:00.000Z';
    const seedYear = 2026;

    it('returns a detectFoodCrisis-compatible shape with countries keyed by ISO2', () => {
      const faoMap = new Map([
        ['SS', { source: 'hdx-ipc', year: 2025, peopleInCrisis: 7700000, phase: 'IPC Phase 4' }],
        ['YE', { source: 'hdx-ipc', year: 2024, peopleInCrisis: 17000000, phase: 'IPC Phase 3' }],
      ]);
      const aggregate = buildFaoAggregate(faoMap, seedYear, seededAt);

      assert.equal(aggregate.source, 'hdx-ipc');
      assert.equal(aggregate.seedYear, 2026);
      assert.equal(aggregate.fetchedAt, seededAt);
      assert.equal(aggregate.count, 2);
      assert.deepEqual(Object.keys(aggregate.countries).sort(), ['SS', 'YE']);
      assert.equal(aggregate.countries.SS.ipcPhase, 4);
      assert.equal(aggregate.countries.SS.phase, 'IPC Phase 4');
      assert.equal(aggregate.countries.SS.peopleInCrisis, 7700000);
      assert.equal(aggregate.countries.YE.ipcPhase, 3);
    });

    it('includes only Phase 3+ countries (IPC crisis threshold)', () => {
      const faoMap = new Map([
        ['SS', { source: 'hdx-ipc', peopleInCrisis: 7700000, phase: 'IPC Phase 4' }],
        ['KE', { source: 'hdx-ipc', peopleInCrisis: 500000, phase: 'IPC Phase 2' }],
      ]);
      const aggregate = buildFaoAggregate(faoMap, seedYear, seededAt);
      assert.equal(aggregate.count, 1);
      assert.ok('SS' in aggregate.countries);
      assert.ok(!('KE' in aggregate.countries), 'Phase 2 country must be excluded');
    });

    it('skips entries with unparseable phase strings', () => {
      const faoMap = new Map([
        ['SS', { source: 'hdx-ipc', phase: 'IPC Phase 3' }],
        ['AA', { source: 'hdx-ipc', phase: null }],
        ['BB', { source: 'hdx-ipc', phase: 'Unknown' }],
      ]);
      const aggregate = buildFaoAggregate(faoMap, seedYear, seededAt);
      assert.equal(aggregate.count, 1);
      assert.deepEqual(Object.keys(aggregate.countries), ['SS']);
    });

    it('returns an empty aggregate when the input map is empty', () => {
      const aggregate = buildFaoAggregate(new Map(), seedYear, seededAt);
      assert.equal(aggregate.count, 0);
      assert.deepEqual(aggregate.countries, {});
      assert.equal(aggregate.seedYear, 2026);
    });

    it('is readable by backtest-resilience-outcomes.mjs::detectFoodCrisis (contract)', async () => {
      // Locks the contract between this seeder and the downstream validator.
      // If detectFoodCrisis is refactored, or the aggregate shape drifts, this
      // fails loudly instead of silently returning 0 positive events in the
      // weekly validation cron.
      const { detectFoodCrisis } = await import('../scripts/backtest-resilience-outcomes.mjs');
      const faoMap = new Map([
        ['SS', { source: 'hdx-ipc', year: 2025, peopleInCrisis: 7700000, phase: 'IPC Phase 4' }],
        ['YE', { source: 'hdx-ipc', year: 2024, peopleInCrisis: 17000000, phase: 'IPC Phase 3' }],
        ['KE', { source: 'hdx-ipc', peopleInCrisis: 500000, phase: 'IPC Phase 2' }],
      ]);
      const aggregate = buildFaoAggregate(faoMap, seedYear, seededAt);
      const labels = detectFoodCrisis(aggregate, ['SS', 'YE', 'KE', 'NO']);
      assert.equal(labels.get('SS'), true);
      assert.equal(labels.get('YE'), true);
      assert.equal(labels.get('KE'), undefined, 'Phase 2 must not be labeled crisis');
      assert.equal(labels.get('NO'), undefined, 'non-IPC country must not be labeled');
    });
  });

  describe('buildAquastatWbMap', () => {
    it('produces the { source, value, indicator, year } shape scoreAquastatValue() reads', () => {
      const input = new Map([
        ['NO', { value: 5.2, year: 2022 }],
        ['YE', { value: 99.1, year: 2021 }],
      ]);
      const result = buildAquastatWbMap(input);
      const no = result.get('NO');
      assert.ok(no != null);
      assert.equal(no.source, 'worldbank-aquastat');
      assert.equal(no.value, 5.2);
      assert.equal(no.indicator, 'water stress');
      assert.equal(no.year, 2022);
      assert.equal(result.get('YE')?.value, 99.1);
    });

    it('throws when input map is empty', () => {
      assert.throws(() => buildAquastatWbMap(new Map()), /no usable rows/);
    });

    it('output indicator keyword matches scoreAquastatValue stress branch', () => {
      // scoreAquastatValue() checks indicator.includes('stress') -> normalizeLowerBetter(0,100)
      // If this keyword changes the scorer breaks silently. Pin it here.
      const result = buildAquastatWbMap(new Map([['DE', { value: 10, year: 2022 }]]));
      assert.ok(result.get('DE')?.indicator?.includes('stress'), 'indicator must include "stress" to route correctly in scoreAquastatValue()');
    });
  });

  describe('transformWhoPhysicianDensity', () => {
    it('converts HWF_0001 from per-10k to per-1k and renames the field', () => {
      const merged = new Map([
        ['NO', {
          source: 'who-gho',
          indicators: {
            physiciansPer10k: { indicator: 'HWF_0001', value: 25.0, year: 2022 },
            uhcIndex: { indicator: 'UHC_INDEX_REPORTED', value: 81, year: 2021 },
          },
        }],
        ['YE', {
          source: 'who-gho',
          indicators: {
            physiciansPer10k: { indicator: 'HWF_0001', value: 1.0, year: 2020 },
          },
        }],
      ]);

      transformWhoPhysicianDensity(merged);

      const no = merged.get('NO');
      assert.ok(no.indicators.physiciansPer1k != null, 'physiciansPer1k should be created');
      assert.equal(no.indicators.physiciansPer1k.value, 2.5, '25.0 / 10 = 2.5');
      assert.equal(no.indicators.physiciansPer1k.indicator, 'HWF_0001');
      assert.equal(no.indicators.physiciansPer1k.year, 2022);
      assert.equal(no.indicators.physiciansPer10k, undefined, 'physiciansPer10k should be deleted');
      assert.equal(no.indicators.uhcIndex.value, 81, 'other indicators should be untouched');

      const ye = merged.get('YE');
      assert.equal(ye.indicators.physiciansPer1k.value, 0.1, '1.0 / 10 = 0.1');
    });

    it('handles records without physiciansPer10k gracefully', () => {
      const merged = new Map([
        ['US', {
          source: 'who-gho',
          indicators: {
            healthExpPerCapitaUsd: { indicator: 'GHED_CHE_pc_US_SHA2011', value: 12555, year: 2021 },
          },
        }],
      ]);

      transformWhoPhysicianDensity(merged);

      const us = merged.get('US');
      assert.equal(us.indicators.physiciansPer1k, undefined, 'no physiciansPer1k when source data is absent');
      assert.equal(us.indicators.healthExpPerCapitaUsd.value, 12555, 'healthExpPerCapitaUsd should be untouched');
      assert.equal(us.indicators.healthExpPerCapitaUsd.indicator, 'GHED_CHE_pc_US_SHA2011');
    });
  });

  describe('buildTradeToGdpMap', () => {
    it('produces { source, tradeToGdpPct, year } shape for known countries', () => {
      const input = new Map([
        ['NO', { value: 70.5, year: 2023 }],
        ['US', { value: 25.3, year: 2023 }],
        ['SG', { value: 318.2, year: 2023 }],
      ]);
      const result = buildTradeToGdpMap(input);
      assert.equal(result.size, 3);
      const no = result.get('NO');
      assert.ok(no != null);
      assert.equal(no.source, 'worldbank');
      assert.equal(no.tradeToGdpPct, 70.5);
      assert.equal(no.year, 2023);
      assert.equal(result.get('SG')?.tradeToGdpPct, 318.2);
    });

    it('throws when input map is empty', () => {
      assert.throws(() => buildTradeToGdpMap(new Map()), /no usable rows/);
    });
  });
});

describe('resilience static seed parsers', () => {
  it('parses RSF ranking rows and skips aggregate entries', () => {
    const html = `
      <div class="field__item">|Rank|Country|Note|Differential|
      |3|Norway|6,52|-2 (1)|
      |32|United States|18,22|+15 (47)|
      |34|OECS|19,72|-9 (25)|
      |169|Yemen|69,22|+2 (171)|</div>
    `;

    const rows = parseRsfRanking(html);
    assert.deepEqual([...rows.keys()].sort(), ['NO', 'US', 'YE']);
    assert.deepEqual(rows.get('NO'), {
      source: 'rsf-ranking',
      rank: 3,
      score: 6.52,
      differential: '-2 (1)',
      year: null,
    });
    assert.equal(rows.get('US').rank, 32);
    assert.equal(rows.get('YE').score, 69.22);
  });

  it('parses Eurostat energy dependency and keeps the latest TOTAL series value', () => {
    const dataset = {
      id: ['freq', 'siec', 'unit', 'geo', 'time'],
      size: [1, 2, 1, 2, 2],
      dimension: {
        freq: { category: { index: { A: 0 } } },
        siec: { category: { index: { TOTAL: 0, C0110: 1 } } },
        unit: { category: { index: { PC: 0 } } },
        geo: { category: { index: { NO: 0, US: 1 } } },
        time: { category: { index: { 2023: 0, 2024: 1 } } },
      },
      value: {
        0: -15.2,
        1: -13.3,
        2: 7.9,
        3: 8.5,
        5: 999.0,
      },
    };

    const parsed = parseEurostatEnergyDataset(dataset);
    assert.deepEqual(parsed.get('NO'), {
      source: 'eurostat-nrg_ind_id',
      energyImportDependency: {
        value: -13.3,
        year: 2024,
        source: 'eurostat',
      },
    });
    assert.equal(parsed.get('US').energyImportDependency.value, 8.5);
  });
});

describe('resilience static seed payload assembly', () => {
  it('merges sparse datasets into the canonical per-country shape with coverage', () => {
    const payloads = finalizeCountryPayloads({
      wgi: new Map([
        ['NO', { source: 'worldbank-wgi', indicators: { 'GE.EST': { value: 1.8, year: 2024 } } }],
        ['US', { source: 'worldbank-wgi', indicators: { 'GE.EST': { value: 1.1, year: 2024 } } }],
      ]),
      infrastructure: new Map([
        ['NO', { source: 'worldbank-infrastructure', indicators: { 'EG.ELC.ACCS.ZS': { value: 100, year: 2024 } } }],
      ]),
      gpi: new Map(),
      rsf: new Map([
        ['YE', { source: 'rsf-ranking', rank: 169, score: 69.22, differential: '+2 (171)', year: null }],
      ]),
      who: new Map([
        ['US', { source: 'who-gho', indicators: { uhcIndex: { indicator: 'UHC_INDEX_REPORTED', value: 81, year: 2021 } } }],
      ]),
      fao: new Map(),
      aquastat: new Map(),
      iea: new Map([
        ['NO', { source: 'eurostat-nrg_ind_id', energyImportDependency: { value: -13.3, year: 2024, source: 'eurostat' } }],
      ]),
      tradeToGdp: new Map([
        ['NO', { source: 'worldbank', tradeToGdpPct: 70.5, year: 2023 }],
      ]),
      appliedTariffRate: new Map(),
    }, 2026, '2026-04-03T12:00:00.000Z');

    assert.deepEqual([...payloads.keys()].sort(), ['NO', 'US', 'YE']);

    assert.deepEqual(payloads.get('NO'), {
      wgi: { source: 'worldbank-wgi', indicators: { 'GE.EST': { value: 1.8, year: 2024 } } },
      infrastructure: { source: 'worldbank-infrastructure', indicators: { 'EG.ELC.ACCS.ZS': { value: 100, year: 2024 } } },
      gpi: null,
      rsf: null,
      who: null,
      fao: null,
      aquastat: null,
      iea: { source: 'eurostat-nrg_ind_id', energyImportDependency: { value: -13.3, year: 2024, source: 'eurostat' } },
      tradeToGdp: { source: 'worldbank', tradeToGdpPct: 70.5, year: 2023 },
      fxReservesMonths: null,
      appliedTariffRate: null,
      coverage: { availableDatasets: 4, totalDatasets: 11, ratio: 0.364 },
      seedYear: 2026,
      seededAt: '2026-04-03T12:00:00.000Z',
    });

    assert.equal(payloads.get('US').coverage.availableDatasets, 2);
    assert.equal(payloads.get('YE').coverage.availableDatasets, 1);
  });

  it('builds a manifest and the failure refresh key set from the country list', () => {
    const countryPayloads = new Map([
      ['US', { coverage: { availableDatasets: 2 } }],
      ['NO', { coverage: { availableDatasets: 3 } }],
      ['YE', { coverage: { availableDatasets: 1 } }],
    ]);
    const manifest = buildManifest(countryPayloads, ['aquastat', 'gpi'], 2026, '2026-04-03T12:00:00.000Z');

    assert.deepEqual(manifest, {
      countries: ['NO', 'US', 'YE'],
      recordCount: 3,
      failedDatasets: ['aquastat', 'gpi'],
      seedYear: 2026,
      seededAt: '2026-04-03T12:00:00.000Z',
      sourceVersion: RESILIENCE_STATIC_SOURCE_VERSION,
    });

    assert.deepEqual(buildFailureRefreshKeys(manifest), [
      RESILIENCE_STATIC_INDEX_KEY,
      RESILIENCE_STATIC_META_KEY,
      countryRedisKey('NO'),
      countryRedisKey('US'),
      countryRedisKey('YE'),
    ]);
  });

  it('skips reruns only after a successful snapshot for the same seed year and source version', () => {
    const v = RESILIENCE_STATIC_SOURCE_VERSION;
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v }, 2026), true);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: [] }, 2026), true);
    assert.equal(shouldSkipSeedYear({ status: 'error', seedYear: 2026, recordCount: 150, sourceVersion: v }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2025, recordCount: 150, sourceVersion: v }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: 'resilience-static-v1' }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150 }, 2026), false);
  });

  it('shouldSkipSeedYear returns false when failedDatasets is non-empty (partial success must retry)', () => {
    const v = RESILIENCE_STATIC_SOURCE_VERSION;
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: ['fxReservesMonths'] }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: ['aquastat', 'fao'] }, 2026), false);
  });
});

describe('recoverFailedDatasets', () => {
  // Fixtures use the post-fix schema: peopleInCrisis + phase.
  // These are the fields scoreFoodWater() reads from staticRecord.fao.
  const existingFao = { source: 'hdx-ipc', year: 2025, peopleInCrisis: 4_500_000, phase: 'IPC Phase 5' };
  const existingSo  = { source: 'hdx-ipc', year: 2025, peopleInCrisis: 3_000_000, phase: 'IPC Phase 3' };
  // Fixture uses the WB shape that scoreAquastatValue() reads: { value, indicator, year }.
  const existingAquastat = { source: 'worldbank-aquastat', value: 75.3, indicator: 'water stress', year: 2022 };

  function makeDatasetMaps(faoOverride = new Map()) {
    return {
      wgi: new Map([['YE', { source: 'worldbank-wgi' }]]),
      infrastructure: new Map(), gpi: new Map(), rsf: new Map(),
      who: new Map(), fao: faoOverride, aquastat: new Map(), iea: new Map(),
      tradeToGdp: new Map(),
    };
  }

  it('injects prior fao values when FSIN fails and a prior snapshot exists', async () => {
    const maps = makeDatasetMaps();
    await recoverFailedDatasets(maps, ['fao'], {
      readIndex: async () => ({ countries: ['YE', 'SO'] }),
      readPipeline: async () => [
        { result: JSON.stringify({ fao: existingFao, wgi: { source: 'worldbank-wgi' } }) },
        { result: JSON.stringify({ fao: existingSo, wgi: null }) },
      ],
    });
    assert.deepEqual(maps.fao.get('YE'), existingFao, 'YE fao should be recovered');
    assert.deepEqual(maps.fao.get('SO'), existingSo, 'SO fao should be recovered');
    // Verify recovered shape has the fields scoreFoodWater() reads.
    // If this fails, a FSIN failover would silently produce null for the crisis sub-metric.
    assert.ok(typeof maps.fao.get('YE').peopleInCrisis === 'number', 'recovered fao must have peopleInCrisis for scoreFoodWater()');
    assert.ok(typeof maps.fao.get('YE').phase === 'string', 'recovered fao must have phase string for scoreFoodWater()');
  });

  it('does not overwrite a partial fao success with prior data', async () => {
    const freshFao = { source: 'hdx-ipc', year: 2026, peopleInCrisis: 5_000_000, phase: 'IPC Phase 3' };
    const maps = makeDatasetMaps(new Map([['YE', freshFao]]));
    await recoverFailedDatasets(maps, ['fao'], {
      readIndex: async () => ({ countries: ['YE'] }),
      readPipeline: async () => [{ result: JSON.stringify({ fao: existingFao }) }],
    });
    assert.deepEqual(maps.fao.get('YE'), freshFao, 'fresh partial data should not be replaced');
  });

  it('warns but does not throw when no prior snapshot exists (first-run tolerance)', async () => {
    const maps = makeDatasetMaps();
    await assert.doesNotReject(() => recoverFailedDatasets(maps, ['fao'], {
      readIndex: async () => null,
      readPipeline: async () => [],
    }));
    assert.equal(maps.fao.size, 0, 'fao stays empty — no prior data to recover');
  });

  it('throws when Redis index read fails, so caller blocks publish', async () => {
    const maps = makeDatasetMaps();
    await assert.rejects(
      () => recoverFailedDatasets(maps, ['fao'], {
        readIndex: async () => { throw new Error('ECONNRESET'); },
        readPipeline: async () => [],
      }),
      /Redis index read also failed.*ECONNRESET/,
    );
  });

  it('throws when Redis pipeline read fails, so caller blocks publish', async () => {
    const maps = makeDatasetMaps();
    await assert.rejects(
      () => recoverFailedDatasets(maps, ['fao'], {
        readIndex: async () => ({ countries: ['YE'] }),
        readPipeline: async () => { throw new Error('timeout'); },
      }),
      /Redis pipeline read also failed.*timeout/,
    );
  });

  it('recovers aquastat with WB shape { value, indicator, year } that scoreAquastatValue() reads', async () => {
    const maps = makeDatasetMaps();
    await recoverFailedDatasets(maps, ['aquastat'], {
      readIndex: async () => ({ countries: ['DE'] }),
      readPipeline: async () => [
        { result: JSON.stringify({ aquastat: existingAquastat }) },
      ],
    });
    const de = maps.aquastat.get('DE');
    assert.deepEqual(de, existingAquastat, 'DE aquastat should be recovered');
    assert.ok(typeof de.value === 'number', 'recovered aquastat must have numeric value for scoreAquastatValue()');
    assert.ok(typeof de.indicator === 'string', 'recovered aquastat must have indicator string for scoreAquastatValue()');
  });
});

describe('resilience static health registrations', () => {
  const healthSrc = readFileSync(join(root, 'api', 'health.js'), 'utf8');
  const seedHealthSrc = readFileSync(join(root, 'api', 'seed-health.js'), 'utf8');

  it('registers the manifest key and seed-meta in health.js', () => {
    assert.match(healthSrc, /resilienceStaticIndex:\s+'resilience:static:index:v1'/);
    assert.match(healthSrc, /seed-meta:resilience:static/);
  });

  it('registers the FAO aggregate key with empty-data tolerance in health.js', () => {
    // buildFaoAggregate writes `resilience:static:fao` during the annual
    // static seed. Health must know about the key (STANDALONE_KEYS) AND
    // tolerate count=0 (EMPTY_DATA_OK_KEYS) — a year with no countries in
    // IPC Phase 3+ is theoretically valid, not a paging event.
    assert.match(healthSrc, /resilienceStaticFao:\s+'resilience:static:fao'/);
    assert.match(healthSrc, /'resilienceStaticFao'/);
  });

  it('registers SEED_META for resilienceStaticFao so empty data degrades to STALE_SEED, not silent OK', () => {
    // Without a SEED_META entry, the STANDALONE_KEYS health branch leaves
    // seedStale=null and treats an empty/missing key in EMPTY_DATA_OK_KEYS
    // as plain OK — which would mask the exact "nothing wrote the key"
    // state this seeder is designed to fix. Must share the static seeder's
    // heartbeat (seed-meta:resilience:static) since the aggregate is
    // written in the same Redis pipeline.
    assert.match(
      healthSrc,
      /resilienceStaticFao:\s*\{\s*key:\s*'seed-meta:resilience:static'/,
      'resilienceStaticFao must appear in SEED_META pointing at seed-meta:resilience:static',
    );
  });

  it('registers annual seed-health monitoring for resilience static', () => {
    assert.match(seedHealthSrc, /'resilience:static':\s+\{ key: 'seed-meta:resilience:static',\s+intervalMin: 288000 \}/);
  });
});
