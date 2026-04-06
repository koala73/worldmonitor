import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESILIENCE_STATIC_INDEX_KEY,
  RESILIENCE_STATIC_META_KEY,
  buildFailureRefreshKeys,
  buildManifest,
  countryRedisKey,
  createCountryResolvers,
  finalizeCountryPayloads,
  gpiUrlForYear,
  buildAquastatWbMap,
  parseEurostatEnergyDataset,
  parseFsinRows,
  parseGpiRows,
  parseRsfRanking,
  recoverFailedDatasets,
  resolveIso2,
  shouldSkipSeedYear,
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
      coverage: { availableDatasets: 3, totalDatasets: 8, ratio: 0.375 },
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
      sourceVersion: 'resilience-static-v1',
    });

    assert.deepEqual(buildFailureRefreshKeys(manifest), [
      RESILIENCE_STATIC_INDEX_KEY,
      RESILIENCE_STATIC_META_KEY,
      countryRedisKey('NO'),
      countryRedisKey('US'),
      countryRedisKey('YE'),
    ]);
  });

  it('skips reruns only after a successful snapshot for the same seed year', () => {
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150 }, 2026), true);
    assert.equal(shouldSkipSeedYear({ status: 'error', seedYear: 2026, recordCount: 150 }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2025, recordCount: 150 }, 2026), false);
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

  it('registers annual seed-health monitoring for resilience static', () => {
    assert.match(seedHealthSrc, /'resilience:static':\s+\{ key: 'seed-meta:resilience:static',\s+intervalMin: 288000 \}/);
  });
});
