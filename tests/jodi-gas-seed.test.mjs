import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_KEY,
  MIN_COUNTRIES,
  FLOW_MAP,
  parseObsValue,
  parseCsvRows,
  buildCountryRecords,
  validateGasCountries,
  buildLngVulnerabilityIndex,
} from '../scripts/seed-jodi-gas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');

describe('CANONICAL_KEY', () => {
  it('is energy:jodi-gas:v1:_countries', () => {
    assert.equal(CANONICAL_KEY, 'energy:jodi-gas:v1:_countries');
  });
});

describe('parseObsValue', () => {
  it('parses numeric string', () => {
    assert.equal(parseObsValue('95000'), 95000);
  });

  it('parses integer', () => {
    assert.equal(parseObsValue(14200), 14200);
  });

  it('returns null for dash', () => {
    assert.equal(parseObsValue('-'), null);
  });

  it('returns null for x (suppressed)', () => {
    assert.equal(parseObsValue('x'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseObsValue(''), null);
  });

  it('returns null for null', () => {
    assert.equal(parseObsValue(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(parseObsValue(undefined), null);
  });

  it('returns null for non-numeric string', () => {
    assert.equal(parseObsValue('N/A'), null);
  });

  it('parses zero', () => {
    assert.equal(parseObsValue('0'), 0);
  });
});

const SAMPLE_CSV_HEADER = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE';

function makeRow(area, period, flow, unit, obs, assess) {
  return `${area},${period},NATGAS,${flow},${unit},${obs},${assess}`;
}

describe('parseCsvRows', () => {
  it('filters to TJ unit only', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '95000', '1'),
      makeRow('DE', '2025-10', 'IMPLNG', 'MTOE', '2.27', '1'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].area, 'DE');
  });

  it('filters to known flow codes only', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '95000', '1'),
      makeRow('DE', '2025-10', 'UNKNOWNFLOW', 'TJ', '100', '1'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].flow, 'IMPLNG');
  });

  it('excludes assessment_code 3 (null/uncertain)', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '95000', '1'),
      makeRow('DE', '2025-10', 'IMPPIP', 'TJ', '380000', '3'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].flow, 'IMPLNG');
  });

  it('includes assessment_code 1 and 2', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '95000', '1'),
      makeRow('DE', '2025-10', 'IMPPIP', 'TJ', '380000', '2'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows.length, 2);
  });

  it('maps flow code to correct field name', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '95000', '1'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows[0].flow, 'IMPLNG');
    assert.equal(FLOW_MAP['IMPLNG'], 'lngImportsTj');
  });

  it('handles dash OBS_VALUE as null', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', '-', '1'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows[0].obs, null);
  });

  it('handles x OBS_VALUE as null', () => {
    const csv = [
      SAMPLE_CSV_HEADER,
      makeRow('DE', '2025-10', 'IMPLNG', 'TJ', 'x', '1'),
    ].join('\n');
    const rows = parseCsvRows(csv);
    assert.equal(rows[0].obs, null);
  });

  it('returns empty array for empty csv', () => {
    assert.deepEqual(parseCsvRows(''), []);
  });
});

describe('buildCountryRecords', () => {
  function makeRows(area, period, flowObs, assess = '1') {
    return flowObs.map(([flow, obs]) => ({
      area,
      period,
      flow,
      obs: parseObsValue(String(obs)),
    }));
  }

  it('computes lngShareOfImports correctly', () => {
    const rows = makeRows('DE', '2025-10', [
      ['IMPLNG',   '95000'],
      ['TOTIMPSB', '475000'],
    ]);
    const records = buildCountryRecords(rows);
    assert.equal(records.length, 1);
    assert.equal(records[0].iso2, 'DE');
    assert.equal(records[0].lngShareOfImports, 0.2);
  });

  it('lngShareOfImports is null when totalImports is 0', () => {
    const rows = makeRows('DE', '2025-10', [
      ['IMPLNG',   '95000'],
      ['TOTIMPSB', '0'],
    ]);
    const records = buildCountryRecords(rows);
    assert.equal(records[0].lngShareOfImports, null);
  });

  it('lngShareOfImports is null when totalImports is null', () => {
    const rows = makeRows('DE', '2025-10', [
      ['IMPLNG',   '95000'],
    ]);
    const records = buildCountryRecords(rows);
    assert.equal(records[0].lngShareOfImports, null);
  });

  it('lngShareOfImports is null when lngImports is null', () => {
    const rows = makeRows('DE', '2025-10', [
      ['IMPLNG',   '-'],
      ['TOTIMPSB', '475000'],
    ]);
    const records = buildCountryRecords(rows);
    assert.equal(records[0].lngShareOfImports, null);
  });

  it('assessment_code 3 rows are excluded so field becomes null', () => {
    const rows = [
      { area: 'FR', period: '2025-10', flow: 'IMPLNG', obs: null },
      { area: 'FR', period: '2025-10', flow: 'TOTIMPSB', obs: 200000 },
    ];
    const records = buildCountryRecords(rows);
    assert.equal(records[0].lngImportsTj, null);
  });

  it('picks most recent period per country', () => {
    const rows = [
      { area: 'US', period: '2025-10', flow: 'IMPLNG', obs: 100 },
      { area: 'US', period: '2025-09', flow: 'IMPLNG', obs: 80 },
    ];
    const records = buildCountryRecords(rows);
    assert.equal(records[0].dataMonth, '2025-10');
    assert.equal(records[0].lngImportsTj, 100);
  });

  it('includes seededAt ISO string', () => {
    const rows = [{ area: 'GB', period: '2025-10', flow: 'INDPROD', obs: 50000 }];
    const records = buildCountryRecords(rows);
    assert.ok(typeof records[0].seededAt === 'string');
    assert.ok(!isNaN(Date.parse(records[0].seededAt)));
  });

  it('maps all FLOW_MAP codes to correct record fields', () => {
    const flowObs = Object.keys(FLOW_MAP).map(f => [f, '1000']);
    const rows = makeRows('NO', '2025-10', flowObs);
    const records = buildCountryRecords(rows);
    assert.equal(records.length, 1);
    for (const [flow, field] of Object.entries(FLOW_MAP)) {
      assert.equal(records[0][field], 1000, `Field ${field} (from ${flow}) should be 1000`);
    }
  });
});

describe('validateGasCountries', () => {
  it('returns true when country count >= 50', () => {
    const arr = Array.from({ length: 50 }, (_, i) => `C${i}`);
    assert.equal(validateGasCountries(arr), true);
  });

  it('returns false when country count < 50', () => {
    const arr = Array.from({ length: 49 }, (_, i) => `C${i}`);
    assert.equal(validateGasCountries(arr), false);
  });

  it('returns false for empty array', () => {
    assert.equal(validateGasCountries([]), false);
  });

  it('returns false for non-array', () => {
    assert.equal(validateGasCountries(null), false);
    assert.equal(validateGasCountries({}), false);
    assert.equal(validateGasCountries(undefined), false);
  });

  it('MIN_COUNTRIES is 50', () => {
    assert.equal(MIN_COUNTRIES, 50);
  });
});

describe('buildLngVulnerabilityIndex', () => {
  function makeMembers(overrides = []) {
    return overrides.map(o => ({
      iso2: 'XX',
      lngShareOfImports: null,
      lngImportsTj: null,
      pipeImportsTj: null,
      dataMonth: '2025-10',
      ...o,
    }));
  }

  it('returns object with top20LngDependent and top20PipelineDependent', () => {
    const result = buildLngVulnerabilityIndex([], '2025-10', '2026-04-06T00:00:00.000Z');
    assert.ok('top20LngDependent' in result);
    assert.ok('top20PipelineDependent' in result);
  });

  it('includes updatedAt and dataMonth', () => {
    const updatedAt = '2026-04-06T00:00:00.000Z';
    const result = buildLngVulnerabilityIndex([], '2025-10', updatedAt);
    assert.equal(result.updatedAt, updatedAt);
    assert.equal(result.dataMonth, '2025-10');
  });

  it('top20LngDependent is sorted by lngShareOfImports descending', () => {
    const members = makeMembers([
      { iso2: 'JP', lngShareOfImports: 0.5, lngImportsTj: 100, pipeImportsTj: 100 },
      { iso2: 'KR', lngShareOfImports: 0.9, lngImportsTj: 200, pipeImportsTj: 50 },
      { iso2: 'DE', lngShareOfImports: 0.2, lngImportsTj: 50,  pipeImportsTj: 200 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    const shares = result.top20LngDependent.map(e => e.lngShareOfImports);
    assert.deepEqual(shares, [0.9, 0.5, 0.2]);
  });

  it('top20PipelineDependent is sorted by lngShareOfImports ascending', () => {
    const members = makeMembers([
      { iso2: 'JP', lngShareOfImports: 0.5, lngImportsTj: 100, pipeImportsTj: 100 },
      { iso2: 'BY', lngShareOfImports: 0.0, lngImportsTj: 0,   pipeImportsTj: 300 },
      { iso2: 'DE', lngShareOfImports: 0.2, lngImportsTj: 50,  pipeImportsTj: 200 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    const shares = result.top20PipelineDependent.map(e => e.lngShareOfImports);
    assert.deepEqual(shares, [0.0, 0.2, 0.5]);
  });

  it('excludes entries with zero or null lngImportsTj from top20LngDependent', () => {
    const members = makeMembers([
      { iso2: 'JP', lngShareOfImports: 0.9, lngImportsTj: 0,    pipeImportsTj: 100 },
      { iso2: 'KR', lngShareOfImports: 0.8, lngImportsTj: null, pipeImportsTj: 100 },
      { iso2: 'AU', lngShareOfImports: 0.7, lngImportsTj: 500,  pipeImportsTj: 100 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20LngDependent.length, 1);
    assert.equal(result.top20LngDependent[0].iso2, 'AU');
  });

  it('excludes entries with zero or null pipeImportsTj from top20PipelineDependent', () => {
    const members = makeMembers([
      { iso2: 'BY', lngShareOfImports: 0.0, lngImportsTj: 0,   pipeImportsTj: 0    },
      { iso2: 'RU', lngShareOfImports: 0.1, lngImportsTj: 50,  pipeImportsTj: null },
      { iso2: 'UA', lngShareOfImports: 0.2, lngImportsTj: 100, pipeImportsTj: 300  },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20PipelineDependent.length, 1);
    assert.equal(result.top20PipelineDependent[0].iso2, 'UA');
  });

  it('excludes entries with null lngShareOfImports from both lists', () => {
    const members = makeMembers([
      { iso2: 'XX', lngShareOfImports: null, lngImportsTj: 500, pipeImportsTj: 300 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20LngDependent.length, 0);
    assert.equal(result.top20PipelineDependent.length, 0);
  });

  it('caps each list at 20 entries', () => {
    const members = makeMembers(
      Array.from({ length: 30 }, (_, i) => ({
        iso2: `C${i}`,
        lngShareOfImports: (30 - i) / 30,
        lngImportsTj: 1000 + i,
        pipeImportsTj: 500 + i,
      })),
    );
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20LngDependent.length, 20);
    assert.equal(result.top20PipelineDependent.length, 20);
  });

  it('top20LngDependent entries have iso2, lngShareOfImports, lngImportsTj fields', () => {
    const members = makeMembers([
      { iso2: 'JP', lngShareOfImports: 1.0, lngImportsTj: 4200000, pipeImportsTj: 0 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20LngDependent.length, 1);
    const entry = result.top20LngDependent[0];
    assert.equal(entry.iso2, 'JP');
    assert.equal(entry.lngShareOfImports, 1.0);
    assert.equal(entry.lngImportsTj, 4200000);
    assert.ok(!('pipeImportsTj' in entry));
  });

  it('top20PipelineDependent entries have iso2, lngShareOfImports, pipeImportsTj fields', () => {
    const members = makeMembers([
      { iso2: 'BY', lngShareOfImports: 0.0, lngImportsTj: 0, pipeImportsTj: 380000 },
    ]);
    const result = buildLngVulnerabilityIndex(members, '2025-10', '2026-04-06T00:00:00.000Z');
    assert.equal(result.top20PipelineDependent.length, 1);
    const entry = result.top20PipelineDependent[0];
    assert.equal(entry.iso2, 'BY');
    assert.equal(entry.lngShareOfImports, 0.0);
    assert.equal(entry.pipeImportsTj, 380000);
    assert.ok(!('lngImportsTj' in entry));
  });
});

// ---------------------------------------------------------------------------
// Golden fixture: upstream CSV format regression guard
// ---------------------------------------------------------------------------

describe('golden fixture (JODI Gas CSV)', () => {
  const csv = readFileSync(resolve(FIXTURE_DIR, 'jodi-gas-sample.csv'), 'utf-8');

  it('parseCsvRows returns rows from the fixture', () => {
    const rows = parseCsvRows(csv);
    assert.ok(rows.length >= 1, `expected >=1 row, got ${rows.length}`);
  });

  it('parsed rows have expected shape (area, period, flow, obs)', () => {
    const rows = parseCsvRows(csv);
    for (const row of rows) {
      assert.ok('area' in row, 'area field missing');
      assert.ok('period' in row, 'period field missing');
      assert.ok('flow' in row, 'flow field missing');
      assert.ok('obs' in row, 'obs field missing');
    }
  });

  it('buildCountryRecords produces DE with expected gas flow fields', () => {
    const rows = parseCsvRows(csv);
    const records = buildCountryRecords(rows);
    const de = records.find(r => r.iso2 === 'DE');
    assert.ok(de != null, 'DE record missing');
    assert.ok('lngImportsTj' in de, 'lngImportsTj missing');
    assert.ok('pipeImportsTj' in de, 'pipeImportsTj missing');
    assert.ok('totalDemandTj' in de, 'totalDemandTj missing');
    assert.ok('productionTj' in de, 'productionTj missing');
    assert.ok('closingStockTj' in de, 'closingStockTj missing');
    assert.ok('totalImportsTj' in de, 'totalImportsTj missing');
  });

  it('JP record has non-null lngImportsTj', () => {
    const rows = parseCsvRows(csv);
    const records = buildCountryRecords(rows);
    const jp = records.find(r => r.iso2 === 'JP');
    assert.ok(jp != null, 'JP record missing');
    assert.ok(typeof jp.lngImportsTj === 'number', 'JP lngImportsTj should be a number');
  });

  it('lngShareOfImports is computed for DE', () => {
    const rows = parseCsvRows(csv);
    const records = buildCountryRecords(rows);
    const de = records.find(r => r.iso2 === 'DE');
    assert.ok(de != null);
    assert.ok(typeof de.lngShareOfImports === 'number', 'lngShareOfImports should be computed');
    assert.ok(de.lngShareOfImports > 0 && de.lngShareOfImports < 1, 'lngShareOfImports should be between 0 and 1');
  });
});
