import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  parseObsValue,
  extractCountryData,
  buildAllCountries,
  validateCoverage,
  mergeSourceRows,
  CANONICAL_KEY,
  COUNTRY_KEY_PREFIX,
  JODI_TTL,
} from '../scripts/seed-jodi-oil.mjs';

const SAMPLE_CSV_HEADER = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE';

function makeRow(overrides = {}) {
  return {
    REF_AREA: 'DE',
    TIME_PERIOD: '2025-11',
    ENERGY_PRODUCT: 'GASDIES',
    FLOW_BREAKDOWN: 'TOTDEMO',
    UNIT_MEASURE: 'KBD',
    OBS_VALUE: '894.454',
    ASSESSMENT_CODE: '1',
    ...overrides,
  };
}

function makeCsv(rows) {
  const lines = [SAMPLE_CSV_HEADER];
  for (const r of rows) {
    lines.push([r.REF_AREA, r.TIME_PERIOD, r.ENERGY_PRODUCT, r.FLOW_BREAKDOWN, r.UNIT_MEASURE, r.OBS_VALUE, r.ASSESSMENT_CODE].join(','));
  }
  return lines.join('\n');
}

describe('CANONICAL_KEY contract', () => {
  it('has expected format energy:jodi-oil:v1:_countries', () => {
    assert.equal(CANONICAL_KEY, 'energy:jodi-oil:v1:_countries');
  });

  it('COUNTRY_KEY_PREFIX is energy:jodi-oil:v1:', () => {
    assert.equal(COUNTRY_KEY_PREFIX, 'energy:jodi-oil:v1:');
  });

  it('JODI_TTL is 35 days in seconds', () => {
    assert.equal(JODI_TTL, 35 * 24 * 3600);
  });
});

describe('parseCsv', () => {
  it('parses header and single data row correctly', () => {
    const csv = makeCsv([makeRow()]);
    const rows = parseCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].REF_AREA, 'DE');
    assert.equal(rows[0].TIME_PERIOD, '2025-11');
    assert.equal(rows[0].ENERGY_PRODUCT, 'GASDIES');
    assert.equal(rows[0].FLOW_BREAKDOWN, 'TOTDEMO');
    assert.equal(rows[0].UNIT_MEASURE, 'KBD');
    assert.equal(rows[0].OBS_VALUE, '894.454');
    assert.equal(rows[0].ASSESSMENT_CODE, '1');
  });

  it('skips empty lines', () => {
    const csv = SAMPLE_CSV_HEADER + '\n\n' + 'DE,2025-11,GASDIES,TOTDEMO,KBD,894.4,1\n\n';
    const rows = parseCsv(csv);
    assert.equal(rows.length, 1);
  });

  it('returns empty array for header-only CSV', () => {
    const rows = parseCsv(SAMPLE_CSV_HEADER);
    assert.equal(rows.length, 0);
  });

  it('strips surrounding quotes from fields', () => {
    const csv = '"REF_AREA","TIME_PERIOD","ENERGY_PRODUCT","FLOW_BREAKDOWN","UNIT_MEASURE","OBS_VALUE","ASSESSMENT_CODE"\n"DE","2025-11","GASDIES","TOTDEMO","KBD","894.4","1"';
    const rows = parseCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].REF_AREA, 'DE');
  });

  it('handles quoted field containing a comma without splitting it', () => {
    const csv = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE\n"DE,extra",2025-11,GASDIES,TOTDEMO,KBD,100,1';
    const rows = parseCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].REF_AREA, 'DE,extra');
    assert.equal(rows[0].OBS_VALUE, '100');
  });

  it('handles escaped double-quote inside quoted field', () => {
    const csv = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE\n"DE""X",2025-11,GASDIES,TOTDEMO,KBD,100,1';
    const rows = parseCsv(csv);
    assert.equal(rows[0].REF_AREA, 'DE"X');
  });
});

describe('parseObsValue', () => {
  it('parses valid number string', () => {
    assert.equal(parseObsValue('894.454'), 894.454);
  });

  it('parses integer string', () => {
    assert.equal(parseObsValue('100'), 100);
  });

  it('returns null for dash', () => {
    assert.equal(parseObsValue('-'), null);
  });

  it('returns null for x', () => {
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

  it('returns null for na', () => {
    assert.equal(parseObsValue('na'), null);
  });

  it('returns null for NaN string', () => {
    assert.equal(parseObsValue('abc'), null);
  });
});

describe('extractCountryData schema', () => {
  function makeFullRows(iso2 = 'DE', month = '2025-11', code = '1') {
    const secondaryProducts = ['GASOLINE', 'GASDIES', 'JETKERO', 'RESFUEL', 'LPG'];
    const secondaryFlows = ['TOTDEMO', 'REFGROUT', 'TOTIMPSB', 'TOTEXPSB'];
    const primaryFlows = ['INDPROD', 'REFINOBS', 'TOTIMPSB', 'TOTEXPSB'];
    const rows = [];
    for (const prod of secondaryProducts) {
      for (const flow of secondaryFlows) {
        rows.push(makeRow({ REF_AREA: iso2, TIME_PERIOD: month, ENERGY_PRODUCT: prod, FLOW_BREAKDOWN: flow, OBS_VALUE: '100', ASSESSMENT_CODE: code }));
      }
    }
    for (const flow of primaryFlows) {
      rows.push(makeRow({ REF_AREA: iso2, TIME_PERIOD: month, ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: flow, OBS_VALUE: '200', ASSESSMENT_CODE: code }));
    }
    return rows;
  }

  it('returns null when no KBD rows for country', () => {
    const result = extractCountryData([], 'DE');
    assert.equal(result, null);
  });

  it('returns null when all rows have assessment_code=3', () => {
    const rows = makeFullRows('DE', '2025-11', '3');
    const result = extractCountryData(rows, 'DE');
    assert.equal(result, null);
  });

  it('includes all 6 product keys in output', () => {
    const rows = makeFullRows('DE');
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null, 'Should return data');
    assert.ok('gasoline' in result, 'gasoline key missing');
    assert.ok('diesel' in result, 'diesel key missing');
    assert.ok('jet' in result, 'jet key missing');
    assert.ok('fuelOil' in result, 'fuelOil key missing');
    assert.ok('lpg' in result, 'lpg key missing');
    assert.ok('crude' in result, 'crude key missing');
  });

  it('includes correct sub-fields for secondary products', () => {
    const rows = makeFullRows('DE');
    const result = extractCountryData(rows, 'DE');
    assert.ok('demandKbd' in result.gasoline);
    assert.ok('refOutputKbd' in result.gasoline);
    assert.ok('importsKbd' in result.gasoline);
    assert.ok('exportsKbd' in result.gasoline);
  });

  it('includes correct sub-fields for crude', () => {
    const rows = makeFullRows('DE');
    const result = extractCountryData(rows, 'DE');
    assert.ok('productionKbd' in result.crude);
    assert.ok('refineryIntakeKbd' in result.crude);
    assert.ok('importsKbd' in result.crude);
    assert.ok('exportsKbd' in result.crude);
  });

  it('includes iso2, dataMonth, seededAt', () => {
    const rows = makeFullRows('DE');
    const result = extractCountryData(rows, 'DE');
    assert.equal(result.iso2, 'DE');
    assert.equal(result.dataMonth, '2025-11');
    assert.ok(typeof result.seededAt === 'string');
  });

  it('assessment_code=3 fields become null', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '894', ASSESSMENT_CODE: '3' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'REFGROUT', OBS_VALUE: '500', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.diesel.demandKbd, null, 'code=3 TOTDEMO should be null');
    assert.equal(result.diesel.refOutputKbd, 500, 'code=1 REFGROUT should have value');
  });

  it('anomaly cap: TOTDEMO > 10000 for non-US becomes null', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '15000', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.diesel.demandKbd, null, 'anomalous demand should be null for DE');
  });

  it('anomaly cap does NOT apply to US', () => {
    const rows = [
      makeRow({ REF_AREA: 'US', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '12000', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'US');
    assert.ok(result !== null);
    assert.equal(result.diesel.demandKbd, 12000, 'US high demand should not be capped');
  });

  it('picks most recent month with valid assessment code', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '800', ASSESSMENT_CODE: '1' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '900', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.equal(result.dataMonth, '2025-11');
    assert.equal(result.diesel.demandKbd, 900);
  });

  it('skips month with only code=3 rows and uses earlier month', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '900', ASSESSMENT_CODE: '3' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '800', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.dataMonth, '2025-10');
    assert.equal(result.diesel.demandKbd, 800);
  });

  it('assessment_code=2 (estimated) is accepted', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '850', ASSESSMENT_CODE: '2' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.diesel.demandKbd, 850);
  });

  it('skips crude-only months and falls back to prior-year month with secondary data', () => {
    const rows = [
      // Current-year month: crude only (simulates failed secondary/currentYear.csv)
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'INDPROD', OBS_VALUE: '500', ASSESSMENT_CODE: '1' }),
      // Prior-year month: has both crude and secondary product data
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2024-11', ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'INDPROD', OBS_VALUE: '490', ASSESSMENT_CODE: '1' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2024-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '820', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null, 'Should find a valid month');
    assert.equal(result.dataMonth, '2024-11', 'Should use prior-year month with secondary data');
    assert.equal(result.diesel.demandKbd, 820, 'Should have non-null secondary product data');
  });

  it('returns null when no month has secondary product data', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'INDPROD', OBS_VALUE: '500', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.equal(result, null, 'Should return null when only crude rows are present');
  });
});

describe('buildAllCountries', () => {
  it('returns array with one entry per country', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', ASSESSMENT_CODE: '1' }),
      makeRow({ REF_AREA: 'FR', ASSESSMENT_CODE: '1' }),
      makeRow({ REF_AREA: 'DE', ASSESSMENT_CODE: '1', FLOW_BREAKDOWN: 'REFGROUT' }),
    ];
    const countries = buildAllCountries(rows);
    const iso2s = countries.map(c => c.iso2);
    assert.ok(iso2s.includes('DE'));
    assert.ok(iso2s.includes('FR'));
  });

  it('filters out rows with UNIT_MEASURE != KBD', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', UNIT_MEASURE: 'KB', ASSESSMENT_CODE: '1' }),
    ];
    const countries = buildAllCountries(rows);
    assert.equal(countries.length, 0);
  });
});

describe('mergeSourceRows', () => {
  it('throws when both secondary files are empty', () => {
    assert.throws(
      () => mergeSourceRows('primary-data', 'primary-data', '', ''),
      /Both secondary JODI CSV files failed/,
    );
  });

  it('throws when both secondary files are empty even with valid primary CSV', () => {
    const primaryCsv = makeCsv([makeRow({ ENERGY_PRODUCT: 'CRUDEOIL' })]);
    assert.throws(
      () => mergeSourceRows(primaryCsv, primaryCsv, '', ''),
      /Both secondary JODI CSV files failed/,
    );
  });

  it('proceeds when current-year secondary succeeds but prior-year fails', () => {
    const primaryCsv = makeCsv([makeRow({ ENERGY_PRODUCT: 'CRUDEOIL' })]);
    const secondaryCsv = makeCsv([makeRow({ ENERGY_PRODUCT: 'GASDIES' })]);
    const rows = mergeSourceRows(primaryCsv, '', secondaryCsv, '');
    assert.ok(rows.length > 0);
  });

  it('proceeds when only prior-year secondary is available', () => {
    const primaryCsv = makeCsv([makeRow({ ENERGY_PRODUCT: 'CRUDEOIL' })]);
    const secondaryPriorCsv = makeCsv([makeRow({ ENERGY_PRODUCT: 'GASDIES' })]);
    const rows = mergeSourceRows(primaryCsv, '', '', secondaryPriorCsv);
    assert.ok(rows.length > 0);
  });

  it('filters out non-KBD rows from merged result', () => {
    const secondaryCsv = makeCsv([makeRow({ UNIT_MEASURE: 'KB' }), makeRow({ UNIT_MEASURE: 'KBD' })]);
    const rows = mergeSourceRows('', '', secondaryCsv, '');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].UNIT_MEASURE, 'KBD');
  });
});

describe('validateCoverage', () => {
  it('returns true when 40+ countries provided', () => {
    const countries = Array.from({ length: 40 }, (_, i) => ({ iso2: `C${i}` }));
    assert.equal(validateCoverage(countries), true);
  });

  it('returns false when fewer than 40 countries', () => {
    const countries = Array.from({ length: 39 }, (_, i) => ({ iso2: `C${i}` }));
    assert.equal(validateCoverage(countries), false);
  });

  it('returns false for empty array', () => {
    assert.equal(validateCoverage([]), false);
  });
});
