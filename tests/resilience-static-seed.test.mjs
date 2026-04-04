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
  parseEurostatEnergyDataset,
  parseRsfRanking,
  resolveIso2,
  shouldSkipSeedYear,
} from '../scripts/seed-resilience-static.mjs';

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
