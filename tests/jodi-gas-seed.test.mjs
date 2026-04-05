import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_KEY,
  MIN_COUNTRIES,
  FLOW_MAP,
  parseObsValue,
  parseCsvRows,
  buildCountryRecords,
  validateGasCountries,
} from '../scripts/seed-jodi-gas.mjs';

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
