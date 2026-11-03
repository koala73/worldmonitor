import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv,
  parseObsValue,
  extractCountryData,
  buildAllCountries,
  assessOilDemandChange,
  computeOilDemandChange,
  jodiSourceYears,
  jodiCsvCandidates,
  fetchCsv,
  fetchYearCsv,
  validateCoverage,
  mergeSourceRows,
  prepareOilPublish,
  readPreviousOilMeta,
  CANONICAL_KEY,
  COUNTRY_KEY_PREFIX,
  JODI_TTL,
} from '../scripts/seed-jodi-oil.mjs';
import { monthPeriodEnd } from '../scripts/shared/jodi-demand-change.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');

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

  it('JODI_TTL is 70 days in seconds', () => {
    assert.equal(JODI_TTL, 70 * 24 * 3600);
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

  // JODI code 3 is "data has not been assessed", not "missing": Saudi Arabia,
  // Kazakhstan, Nigeria, Venezuela and others publish their crude exports
  // under it. Unassessed values are kept; only non-numeric cells are absent.
  it('keeps a country whose rows are all assessment_code=3 (not assessed, still reported)', () => {
    const rows = makeFullRows('DE', '2025-11', '3');
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.dataMonth, '2025-11');
    assert.equal(result.crude.exportsKbd, 200);
    assert.equal(result.diesel.demandKbd, 100);
  });

  it('returns null when every cell is a non-numeric placeholder (the UAE since 2019)', () => {
    const rows = makeFullRows('AE', '2026-07', '3').map((r) => ({ ...r, OBS_VALUE: '-' }));
    assert.equal(extractCountryData(rows, 'AE'), null);
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

  it('assessment_code=3 fields keep their reported value', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '894', ASSESSMENT_CODE: '3' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'REFGROUT', OBS_VALUE: '500', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.diesel.demandKbd, 894, 'code=3 TOTDEMO is unassessed, not missing');
    assert.equal(result.diesel.refOutputKbd, 500, 'code=1 REFGROUT should have value');
  });

  it('Saudi crude exports published under code 3 survive (raw JODI 2026-05 row)', () => {
    const rows = [
      makeRow({ REF_AREA: 'SA', TIME_PERIOD: '2026-05', ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'TOTEXPSB', OBS_VALUE: '3434.9032', ASSESSMENT_CODE: '3' }),
      makeRow({ REF_AREA: 'SA', TIME_PERIOD: '2026-05', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTEXPSB', OBS_VALUE: '650', ASSESSMENT_CODE: '3' }),
    ];
    const result = extractCountryData(rows, 'SA');
    assert.ok(result !== null);
    assert.equal(result.crude.exportsKbd, 3434.9032);
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

  it('uses the newest month even when its values are unassessed (code=3)', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '900', ASSESSMENT_CODE: '3' }),
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '800', ASSESSMENT_CODE: '1' }),
    ];
    const result = extractCountryData(rows, 'DE');
    assert.ok(result !== null);
    assert.equal(result.dataMonth, '2025-11');
    assert.equal(result.diesel.demandKbd, 900);
  });

  it('skips a month of placeholder cells and uses the earlier reported month', () => {
    const rows = [
      makeRow({ REF_AREA: 'DE', TIME_PERIOD: '2025-11', ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '-', ASSESSMENT_CODE: '3' }),
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

// ---------------------------------------------------------------------------
// Country refinery yields: trailing-12-month product output ÷ refinery intake
// ---------------------------------------------------------------------------

describe('refinery yields from the trailing 12 JODI months', () => {
  // Real JODI KBD rows (public annual files read 2026-10-28), cut to the flows
  // the yield window reads for JP, KR, DE, US, CN, CA and IN.
  const windowRows = parseCsv(readFileSync(resolve(FIXTURE_DIR, 'energy-shock/jodi-oil-refinery-window-2026-10-28.csv'), 'utf-8'));
  // Expected values were computed independently from the same fixture (Python).
  const MEASURED = {
    JP: { startMonth: '2025-09', endMonth: '2026-08', gasoline: 0.3065, diesel: 0.316, jet: 0.0887, fuelOil: 0.0904, lpg: 0.0287, naphtha: 0.0945 },
    KR: { startMonth: '2025-09', endMonth: '2026-08', gasoline: 0.1777, diesel: 0.336, jet: 0.1504, fuelOil: 0.0873, lpg: 0.0306, naphtha: 0.2831 },
    DE: { startMonth: '2025-09', endMonth: '2026-08', gasoline: 0.2827, diesel: 0.4886, jet: 0.0641, fuelOil: 0.0444, lpg: 0.0389, naphtha: 0.1045 },
    US: { startMonth: '2025-09', endMonth: '2026-08', gasoline: 0.4981, diesel: 0.3022, jet: 0.1164, fuelOil: 0.019, lpg: 0.0211, naphtha: 0.0084 },
    IN: { startMonth: '2025-04', endMonth: '2026-03', gasoline: 0.2109, diesel: 0.4537, jet: 0.0639, fuelOil: 0.0308, lpg: 0.0768, naphtha: 0.0868 },
  };

  for (const [iso2, expected] of Object.entries(MEASURED)) {
    it(`${iso2}: product output ÷ crude refinery intake over ${expected.startMonth}–${expected.endMonth}`, () => {
      const row = extractCountryData(windowRows, iso2);
      const { startMonth, endMonth, ...products } = expected;
      assert.equal(row.dataMonth, endMonth);
      assert.deepEqual(
        { ...row.refineryYields, products: undefined },
        { basis: 'crude_refinery_intake', intakeIssue: null, startMonth, endMonth, months: 12, products: undefined },
      );
      assert.deepEqual(row.refineryYields.products, products);
    });
  }

  it('stores naphtha as a product, with the same four flows as the others', () => {
    const kr = extractCountryData(windowRows, 'KR');
    assert.deepEqual(Object.keys(kr.naphtha).sort(), ['demandKbd', 'exportsKbd', 'importsKbd', 'refOutputKbd']);
    for (const field of ['demandKbd', 'refOutputKbd', 'importsKbd']) {
      assert.ok(kr.naphtha[field] > 0, `KR naphtha ${field} = ${kr.naphtha[field]}`);
    }
  });

  it('CN: JODI refinery intake is a balancing item, so total refinery output is the denominator', () => {
    const cn = extractCountryData(windowRows, 'CN');
    assert.equal(cn.refineryYields.basis, 'total_refinery_output');
    assert.equal(cn.refineryYields.intakeIssue, 'balancing_item');
    assert.deepEqual(cn.refineryYields.products, { gasoline: 0.232, diesel: 0.2517, jet: null, fuelOil: 0.048, lpg: 0.1084, naphtha: 0.1318 });
  });

  it('CA: total output at 2.2x crude intake is not a credible crude-intake basis', () => {
    const ca = extractCountryData(windowRows, 'CA');
    assert.equal(ca.refineryYields.basis, 'total_refinery_output');
    assert.equal(ca.refineryYields.intakeIssue, 'implausible_output_ratio');
    assert.equal(ca.refineryYields.products.gasoline, 0.27, 'not the 60.5% a crude-only denominator gives');
  });

  // Synthetic 12-month windows ending 2026-06 for the rule's edges.
  const months = (n, end = '2026-06') => Array.from({ length: n }, (_, i) => {
    const [y, m] = end.split('-').map(Number);
    const idx = y * 12 + m - 1 - i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
  function windowFixture({ count = 12, intake = 1000, total = 1050, gasoline = 250, balancedMonths = 0, extra = [] } = {}) {
    const rows = [];
    months(count).forEach((month, i) => {
      const add = (product, flow, value) => rows.push(makeRow({ REF_AREA: 'XX', TIME_PERIOD: month, ENERGY_PRODUCT: product, FLOW_BREAKDOWN: flow, OBS_VALUE: String(value), ASSESSMENT_CODE: '1' }));
      add('GASOLINE', 'REFGROUT', gasoline);
      add('GASOLINE', 'TOTDEMO', 300);
      if (total != null) add('TOTPRODS', 'REFGROUT', total);
      if (intake != null) {
        add('CRUDEOIL', 'REFINOBS', intake);
        add('CRUDEOIL', 'INDPROD', 100);
        add('CRUDEOIL', 'TOTEXPSB', 0);
        // A balanced month reports intake as exactly production + imports - exports.
        add('CRUDEOIL', 'TOTIMPSB', i < balancedMonths ? intake - 100 : intake - 100 + 40);
      }
    });
    return [...rows, ...extra];
  }

  it('sums over the window only: an older month cannot move the yield', () => {
    const old = makeRow({ REF_AREA: 'XX', TIME_PERIOD: '2025-06', ENERGY_PRODUCT: 'GASOLINE', FLOW_BREAKDOWN: 'REFGROUT', OBS_VALUE: '900', ASSESSMENT_CODE: '1' });
    const oldIntake = makeRow({ REF_AREA: 'XX', TIME_PERIOD: '2025-06', ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'REFINOBS', OBS_VALUE: '1000', ASSESSMENT_CODE: '1' });
    const row = extractCountryData(windowFixture({ extra: [old, oldIntake] }), 'XX');
    assert.equal(row.refineryYields.startMonth, '2025-07');
    assert.equal(row.refineryYields.products.gasoline, 0.25);
  });

  it('balancing rule: 9 of 12 balanced months flag the intake, 8 of 12 do not', () => {
    assert.equal(extractCountryData(windowFixture({ balancedMonths: 9 }), 'XX').refineryYields.intakeIssue, 'balancing_item');
    const eight = extractCountryData(windowFixture({ balancedMonths: 8 }), 'XX').refineryYields;
    assert.equal(eight.basis, 'crude_refinery_intake');
    assert.equal(eight.intakeIssue, null);
  });

  it('plausibility band: output at 1.5x intake keeps the intake basis, 1.6x does not', () => {
    assert.equal(extractCountryData(windowFixture({ total: 1500 }), 'XX').refineryYields.basis, 'crude_refinery_intake');
    assert.equal(extractCountryData(windowFixture({ total: 1600 }), 'XX').refineryYields.intakeIssue, 'implausible_output_ratio');
    assert.equal(extractCountryData(windowFixture({ total: 700 }), 'XX').refineryYields.intakeIssue, 'implausible_output_ratio');
  });

  it('one month of total output cannot reject twelve months of intake', () => {
    // Greptile on #9788: a single 1.6x month used to flip the basis to total
    // output, which then had too few months, so every yield went to the median.
    const rows = windowFixture({ total: null, extra: [makeRow({ REF_AREA: 'XX', TIME_PERIOD: '2026-06', ENERGY_PRODUCT: 'TOTPRODS', FLOW_BREAKDOWN: 'REFGROUT', OBS_VALUE: '1600', ASSESSMENT_CODE: '1' })] });
    const yields = extractCountryData(rows, 'XX').refineryYields;
    assert.equal(yields.basis, 'crude_refinery_intake');
    assert.equal(yields.intakeIssue, null);
    assert.equal(yields.products.gasoline, 0.25);
  });

  it('unreported intake falls back to total output; no denominator at all publishes no yields', () => {
    const noIntake = extractCountryData(windowFixture({ intake: null, total: 1000 }), 'XX').refineryYields;
    assert.equal(noIntake.basis, 'total_refinery_output');
    assert.equal(noIntake.intakeIssue, 'unreported');
    assert.equal(noIntake.products.gasoline, 0.25);
    assert.equal(extractCountryData(windowFixture({ intake: null, total: null }), 'XX').refineryYields, null);
  });

  it('a product with fewer than 6 paired months, or a yield above 100%, is null; the others stay measured', () => {
    assert.equal(extractCountryData(windowFixture({ count: 5 }), 'XX').refineryYields, null, '5 months of intake is not a window');
    const sparseJet = months(5).map((month) => makeRow({ REF_AREA: 'XX', TIME_PERIOD: month, ENERGY_PRODUCT: 'JETKERO', FLOW_BREAKDOWN: 'REFGROUT', OBS_VALUE: '80', ASSESSMENT_CODE: '1' }));
    const row = extractCountryData(windowFixture({ extra: sparseJet }), 'XX');
    assert.equal(row.refineryYields.products.jet, null);
    assert.equal(row.refineryYields.products.gasoline, 0.25);
    assert.equal(extractCountryData(windowFixture({ gasoline: 1200, total: 1300 }), 'XX').refineryYields.products.gasoline, null);
  });

  it('product trade: pre-crisis baseline (2025-02–2026-01) and current flows (latest 3 months, none before 2026-03)', () => {
    // Expected averages computed independently from the fixture (Python).
    const kr = extractCountryData(windowRows, 'KR').productTrade;
    assert.deepEqual({ ...kr.preCrisisBaseline, products: undefined }, { startMonth: '2025-02', endMonth: '2026-01', months: 12, products: undefined });
    assert.deepEqual(kr.preCrisisBaseline.products.gasoline, { demandKbd: 268.9, importsKbd: 0, exportsKbd: 298.3 });
    assert.deepEqual(kr.preCrisisBaseline.products.diesel, { demandKbd: 439.6, importsKbd: 0, exportsKbd: 571.7 });
    assert.deepEqual(kr.preCrisisBaseline.products.jet, { demandKbd: 157.7, importsKbd: 0, exportsKbd: 252.8 });
    assert.deepEqual(kr.preCrisisBaseline.products.naphtha, { demandKbd: 1193.3, importsKbd: 650.5, exportsKbd: 95.7 });
    assert.deepEqual({ ...kr.currentFlows, products: undefined }, { startMonth: '2026-06', endMonth: '2026-08', months: 3, products: undefined });
    assert.deepEqual(kr.currentFlows.products.jet, { demandKbd: 159.1, importsKbd: 0, exportsKbd: 328.7 });
    assert.deepEqual(kr.currentFlows.products.naphtha, { demandKbd: 1058.4, importsKbd: 390.3, exportsKbd: 27.9 });

    const jp = extractCountryData(windowRows, 'JP').productTrade;
    assert.deepEqual(jp.preCrisisBaseline.products.naphtha, { demandKbd: 589, importsKbd: 390.7, exportsKbd: 4.4 });
    assert.deepEqual(jp.currentFlows.products.diesel, { demandKbd: 643.5, importsKbd: 14, exportsKbd: 99.4 });
  });

  it('product trade: India ends 2026-03, so current flows is that one month; unreported imports stay null', () => {
    const india = extractCountryData(windowRows, 'IN').productTrade;
    assert.deepEqual({ ...india.currentFlows, products: undefined }, { startMonth: '2026-03', endMonth: '2026-03', months: 1, products: undefined });
    assert.deepEqual(india.currentFlows.products.diesel, { demandKbd: 2122.4, importsKbd: 0.7, exportsKbd: 468.9 });
    assert.deepEqual(india.preCrisisBaseline.products.gasoline, { demandKbd: 975.8, importsKbd: null, exportsKbd: 396.8 });
    assert.deepEqual(india.preCrisisBaseline.products.naphtha, { demandKbd: 289, importsKbd: 33.2, exportsKbd: 152.1 });
  });

  it('product trade: a window needs half its months per flow; no current window before 2026-03; no data is null', () => {
    const tradeRows = (monthsList, flow = 'TOTEXPSB', value = '100') => monthsList.map((month) => makeRow({ REF_AREA: 'XX', TIME_PERIOD: month, ENERGY_PRODUCT: 'GASOLINE', FLOW_BREAKDOWN: flow, OBS_VALUE: value, ASSESSMENT_CODE: '1' }));
    const pre = ['2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
    const five = extractCountryData([...tradeRows(pre), ...tradeRows(['2026-06'], 'TOTDEMO')], 'XX').productTrade;
    assert.equal(five.preCrisisBaseline.months, 5);
    assert.equal(five.preCrisisBaseline.products.gasoline.exportsKbd, null, '5 of 12 months is not a baseline');
    const six = extractCountryData([...tradeRows([...pre, '2025-07']), ...tradeRows(['2026-06'], 'TOTDEMO')], 'XX').productTrade;
    assert.equal(six.preCrisisBaseline.products.gasoline.exportsKbd, 100);
    assert.equal(six.currentFlows.products.gasoline.demandKbd, 100);
    assert.equal(six.currentFlows.products.gasoline.exportsKbd, null, 'no exports reported in 2026-04..06');
    const early = extractCountryData(tradeRows(['2025-12', '2026-01', '2026-02'], 'TOTDEMO'), 'XX').productTrade;
    assert.equal(early.currentFlows, null, 'a data month before 2026-03 has no current-flows window');
    assert.equal(early.preCrisisBaseline.months, 2);
    assert.equal(extractCountryData(tradeRows(['2026-07'], 'TOTDEMO'), 'XX').productTrade.preCrisisBaseline, null);
  });

  it('naphtha does not join the demand-change basket', () => {
    const rows = [];
    for (const month of ['2025-06', '2026-06']) {
      for (const product of ['GASOLINE', 'GASDIES', 'JETKERO', 'NAPHTHA']) {
        rows.push(makeRow({ REF_AREA: 'XX', TIME_PERIOD: month, ENERGY_PRODUCT: product, FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '100', ASSESSMENT_CODE: '1' }));
      }
    }
    const row = extractCountryData(rows, 'XX');
    assert.equal(row.naphtha.demandKbd, 100);
    assert.deepEqual(row.demandChange.products, ['diesel', 'gasoline', 'jet']);
  });
});

// ---------------------------------------------------------------------------
// Observed year-over-year oil-product demand change (#6067)
// ---------------------------------------------------------------------------

describe('monthPeriodEnd', () => {
  it('returns the last instant of the observation period in UTC', () => {
    assert.equal(monthPeriodEnd('2026-04'), '2026-04-30T23:59:59.999Z');
    assert.equal(monthPeriodEnd('2026-12'), '2026-12-31T23:59:59.999Z');
    assert.equal(monthPeriodEnd('2024-02'), '2024-02-29T23:59:59.999Z', 'leap February');
    assert.equal(monthPeriodEnd('2025-02'), '2025-02-28T23:59:59.999Z');
  });

  it('rejects malformed or out-of-range periods', () => {
    assert.equal(monthPeriodEnd('2026-13'), null);
    assert.equal(monthPeriodEnd('2026-00'), null);
    assert.equal(monthPeriodEnd('2026'), null);
    assert.equal(monthPeriodEnd('0001-01'), null);
    assert.equal(monthPeriodEnd(null), null);
  });
});

describe('jodiSourceYears', () => {
  it('covers the year-over-year comparison month across the calendar rollover', () => {
    // In January the newest usable China month is still in the prior year, so
    // its comparison month sits two calendar files back. Downloading only the
    // current and prior years would make the change unpublishable for months.
    assert.deepEqual(jodiSourceYears(new Date('2026-01-15T00:00:00.000Z')), {
      currentYear: 2026,
      priorYear: 2025,
      lookbackYear: 2024,
    });
    assert.deepEqual(jodiSourceYears(new Date('2026-09-15T00:00:00.000Z')), {
      currentYear: 2026,
      priorYear: 2025,
      lookbackYear: 2024,
    });
  });
});

describe('computeOilDemandChange', () => {
  function demandRows(iso2, month, values, code = '1') {
    return Object.entries(values).map(([product, value]) => makeRow({
      REF_AREA: iso2,
      TIME_PERIOD: month,
      ENERGY_PRODUCT: product,
      FLOW_BREAKDOWN: 'TOTDEMO',
      OBS_VALUE: String(value),
      ASSESSMENT_CODE: code,
    }));
  }

  it('publishes a same-month year-over-year change with its own period end', () => {
    const rows = [
      ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 400, JETKERO: 200 }),
      ...demandRows('CN', '2025-04', { GASDIES: 550, GASOLINE: 450, JETKERO: 200 }),
    ];
    const change = computeOilDemandChange(rows, 'CN', '2026-04');
    assert.ok(change !== null);
    assert.equal(change.basis, 'year_over_year');
    assert.equal(change.observationPeriod, '2026-04');
    assert.equal(change.priorObservationPeriod, '2025-04');
    assert.equal(change.periodEnd, '2026-04-30T23:59:59.999Z');
    assert.equal(change.priorPeriodEnd, '2025-04-30T23:59:59.999Z');
    assert.deepEqual(change.products, ['diesel', 'gasoline', 'jet']);
    assert.equal(change.unit, '% change');
    assert.equal(change.currentDemandKbd, 1200);
    assert.equal(change.priorDemandKbd, 1200);
    assert.equal(change.percentChange, 0);
  });

  it('signs the change in the direction of demand', () => {
    const up = computeOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
      ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
    ], 'CN', '2026-04');
    assert.equal(up.percentChange, 10);

    const down = computeOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 900, GASOLINE: 900, JETKERO: 900 }),
      ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
    ], 'CN', '2026-04');
    assert.equal(down.percentChange, -10);
  });

  it('refuses a change when the product set differs between vintages', () => {
    // Fuel oil is reported only in the current month: a widening product set
    // must not read as a demand surge.
    const widened = computeOilDemandChange([
      ...demandRows('CN', '2026-04', {
        GASDIES: 600, GASOLINE: 600, JETKERO: 600, RESFUEL: 600,
      }),
      ...demandRows('CN', '2025-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
    ], 'CN', '2026-04');
    assert.equal(widened, null);

    // ...and a narrowing set must not read as a collapse.
    const narrowed = computeOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
      ...demandRows('CN', '2025-04', {
        GASDIES: 600, GASOLINE: 600, JETKERO: 600, RESFUEL: 600,
      }),
    ], 'CN', '2026-04');
    assert.equal(narrowed, null);

    // Same cardinality, different membership: a swapped product is not a
    // comparable basket either.
    const swapped = computeOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
      ...demandRows('CN', '2025-04', { GASDIES: 600, GASOLINE: 600, RESFUEL: 600 }),
    ], 'CN', '2026-04');
    assert.equal(swapped, null);
  });

  it('refuses a change when the comparison month is absent or not twelve months back', () => {
    assert.equal(
      computeOilDemandChange(demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }), 'CN', '2026-04'),
      null,
      'no comparison month at all',
    );
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2026-03', { GASDIES: 500, GASOLINE: 500, JETKERO: 500 }),
      ], 'CN', '2026-04'),
      null,
      'an adjacent month is a seasonal comparison, not the published basis',
    );
  });

  it('refuses a change built on unusable observations', () => {
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2025-04', { GASDIES: '-', GASOLINE: '-', JETKERO: '-' }, '3'),
      ], 'CN', '2026-04'),
      null,
      'a placeholder cell is not an observation',
    );
    assert.ok(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2025-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }, '3'),
      ], 'CN', '2026-04') !== null,
      'an unassessed (code 3) number is still an observation',
    );
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2025-04', { GASDIES: 15000, GASOLINE: 600, JETKERO: 600 }),
      ], 'CN', '2026-04'),
      null,
      'anomaly-capped prior demand is not an observation',
    );
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2025-04', { GASDIES: 0, GASOLINE: 0, JETKERO: 0 }),
      ], 'CN', '2026-04'),
      null,
      'a zero prior gives no defined percentage change',
    );
  });

  it('refuses a basket too narrow to be a national direction', () => {
    // A single surviving product is that product's move, not the country's.
    for (const basket of [
      { GASDIES: 1100 },
      { GASDIES: 1100, GASOLINE: 1100 },
    ]) {
      const prior = Object.fromEntries(Object.keys(basket).map((k) => [k, 1000]));
      assert.equal(
        computeOilDemandChange([
          ...demandRows('CN', '2026-04', basket),
          ...demandRows('CN', '2025-04', prior),
        ], 'CN', '2026-04'),
        null,
        `${Object.keys(basket).length} product(s) is not a national basket`,
      );
    }

    // Three products clear the bar.
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
        ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ], 'CN', '2026-04').percentChange,
      10,
    );
  });

  it('refuses a physically implausible move the per-product cap let through', () => {
    // Each product stays under ANOMALY_DEMAND_KBD, but the national move is a
    // tripling — a unit or reporting glitch, not an activity direction.
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 3000, GASOLINE: 3000, JETKERO: 3000 }),
        ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ], 'CN', '2026-04'),
      null,
      'a +200% year-over-year move is not a real national demand change',
    );
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 1, GASOLINE: 1, JETKERO: 1 }),
        ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ], 'CN', '2026-04'),
      null,
      'a near-total collapse is not a real national demand change',
    );

    // A large but plausible move is still published, in both directions.
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 1400, GASOLINE: 1400, JETKERO: 1400 }),
        ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ], 'CN', '2026-04').percentChange,
      40,
    );
    assert.equal(
      computeOilDemandChange([
        ...demandRows('CN', '2026-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }),
        ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ], 'CN', '2026-04').percentChange,
      -40,
    );
  });

  it('explains why a refused comparison was not published', () => {
    const assessment = assessOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 3000, GASOLINE: 3000, JETKERO: 3000 }),
      ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
    ], 'CN', '2026-04');
    assert.equal(assessment.change, null);
    assert.match(assessment.reason, /exceeds ±50%/);

    const missingPrior = assessOilDemandChange(
      demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
      'CN',
      '2026-04',
    );
    assert.equal(missingPrior.change, null);
    assert.match(missingPrior.reason, /baskets differ/);
  });

  it('ignores other countries and non-KBD rows', () => {
    const change = computeOilDemandChange([
      ...demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
      ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
      ...demandRows('DE', '2026-04', { GASDIES: 9999, GASOLINE: 9999, JETKERO: 9999 }),
      makeRow({
        REF_AREA: 'CN',
        TIME_PERIOD: '2025-04',
        ENERGY_PRODUCT: 'RESFUEL',
        FLOW_BREAKDOWN: 'TOTDEMO',
        UNIT_MEASURE: 'KB',
        OBS_VALUE: '400',
      }),
    ], 'CN', '2026-04');
    assert.equal(change.percentChange, 10);
    assert.deepEqual(change.products, ['diesel', 'gasoline', 'jet']);
  });

  it('attaches the change to the seeded country payload, or null when unobservable', () => {
    const withChange = extractCountryData([
      ...demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
      ...demandRows('CN', '2025-04', { GASDIES: 1000, GASOLINE: 1000, JETKERO: 1000 }),
    ], 'CN');
    assert.equal(withChange.dataMonth, '2026-04');
    assert.equal(withChange.demandChange.percentChange, 10);

    const withoutChange = extractCountryData(
      demandRows('CN', '2026-04', { GASDIES: 1100, GASOLINE: 1100, JETKERO: 1100 }),
      'CN',
    );
    assert.equal(withoutChange.demandChange, null);
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

  it('keeps only kb/d and closing-stock rows, with a year file the size of JODI\'s inside a 128 MB heap', () => {
    // A secondary year file is ~637k rows across five units, of which only
    // KBD and KBBL closing stocks are read. Building every row first held
    // ~640 MB of heap for the six files and, once the 2026 files downloaded,
    // pushed JODI-Oil past the 1 GB Railway container (measured 2026-10-29).
    const moduleUrl = new URL('../scripts/seed-jodi-oil.mjs', import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)});
      // 2,124 copies of a 300-row block: 637,200 rows, five units in equal shares.
      const units = ['CONVBBL', 'KBBL', 'KBD', 'KL', 'KTONS'];
      const flows = ['TOTDEMO', 'CLOSTLV', 'REFGROUT', 'TOTEXPSB', 'TOTIMPSB'];
      const block = Array.from({ length: 300 }, (_, i) => 'A' + (i % 90) + ',2025-' + String((i % 12) + 1).padStart(2, '0') + ',GASDIES,' + flows[Math.floor(i / 5) % 5] + ',' + units[i % 5] + ',' + (i % 997) + '.125,1\\n').join('');
      const text = 'REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE\\n' + block.repeat(2124);
      const rows = m.mergeSourceRows('', '', text, '');
      process.stdout.write(JSON.stringify({ rows: rows.length, units: [...new Set(rows.map((r) => r.UNIT_MEASURE))].sort() }));`;
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr.slice(-400));
    // Per block: 60 KBD rows plus 12 KBBL rows on the CLOSTLV flow.
    assert.deepEqual(JSON.parse(child.stdout), { rows: 72 * 2124, units: ['KBBL', 'KBD'] });
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

  it('merges the lookback-year secondary file so a year-over-year comparison survives the calendar rollover', () => {
    // Early in a calendar year the newest usable month still sits in the prior
    // year, and its comparison month lives one file further back. Without that
    // file the demand change is structurally unpublishable for months.
    const currentYear = makeCsv([
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'GASDIES', OBS_VALUE: '1100' }),
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'GASOLINE', OBS_VALUE: '1100' }),
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2025-10', ENERGY_PRODUCT: 'JETKERO', OBS_VALUE: '1100' }),
    ]);
    const lookbackYear = makeCsv([
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2024-10', ENERGY_PRODUCT: 'GASDIES', OBS_VALUE: '1000' }),
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2024-10', ENERGY_PRODUCT: 'GASOLINE', OBS_VALUE: '1000' }),
      makeRow({ REF_AREA: 'CN', TIME_PERIOD: '2024-10', ENERGY_PRODUCT: 'JETKERO', OBS_VALUE: '1000' }),
    ]);

    const withoutLookback = extractCountryData(mergeSourceRows('', '', currentYear, ''), 'CN');
    assert.equal(withoutLookback.dataMonth, '2025-10');
    assert.equal(withoutLookback.demandChange, null, 'no comparison month is reachable');

    const withLookback = extractCountryData(
      mergeSourceRows('', '', currentYear, '', lookbackYear),
      'CN',
    );
    assert.equal(withLookback.dataMonth, '2025-10');
    assert.equal(withLookback.demandChange.priorObservationPeriod, '2024-10');
    assert.equal(withLookback.demandChange.percentChange, 10);
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

// ---------------------------------------------------------------------------
// Golden fixture: upstream CSV format regression guard
// ---------------------------------------------------------------------------

describe('golden fixture (JODI Oil CSV)', () => {
  const csv = readFileSync(resolve(FIXTURE_DIR, 'jodi-oil-sample.csv'), 'utf-8');

  it('parseCsv returns rows with expected columns', () => {
    const rows = parseCsv(csv);
    assert.ok(rows.length >= 1, 'expected at least 1 row');
    const first = rows[0];
    assert.ok('REF_AREA' in first, 'REF_AREA column missing');
    assert.ok('TIME_PERIOD' in first, 'TIME_PERIOD column missing');
    assert.ok('ENERGY_PRODUCT' in first, 'ENERGY_PRODUCT column missing');
    assert.ok('FLOW_BREAKDOWN' in first, 'FLOW_BREAKDOWN column missing');
    assert.ok('UNIT_MEASURE' in first, 'UNIT_MEASURE column missing');
    assert.ok('OBS_VALUE' in first, 'OBS_VALUE column missing');
    assert.ok('ASSESSMENT_CODE' in first, 'ASSESSMENT_CODE column missing');
  });

  it('extractCountryData returns diesel and gasoline fields for DE', () => {
    const rows = parseCsv(csv);
    const de = extractCountryData(rows, 'DE');
    assert.ok(de !== null, 'DE should have data');
    assert.ok('diesel' in de, 'diesel key missing');
    assert.ok('gasoline' in de, 'gasoline key missing');
    assert.ok('crude' in de, 'crude key missing');
    assert.equal(de.iso2, 'DE');
    assert.ok(typeof de.dataMonth === 'string');
  });

  it('extractCountryData returns jet field for JP', () => {
    const rows = parseCsv(csv);
    const jp = extractCountryData(rows, 'JP');
    assert.ok(jp !== null, 'JP should have data');
    assert.ok('jet' in jp, 'jet key missing');
    assert.ok(jp.jet.demandKbd !== null, 'JP jet demandKbd should have a value');
  });

  it('secondary product sub-fields are numbers or null', () => {
    const rows = parseCsv(csv);
    const de = extractCountryData(rows, 'DE');
    assert.ok(de !== null);
    for (const prod of ['diesel', 'gasoline']) {
      for (const field of ['demandKbd', 'refOutputKbd', 'importsKbd', 'exportsKbd']) {
        const val = de[prod][field];
        assert.ok(val === null || typeof val === 'number', `${prod}.${field} should be number|null, got ${typeof val}`);
      }
    }
  });
});

describe('JODI current-year source resolution (#6799)', () => {
  // JODI publishes every past year as `<kind>/<year>.csv`, but named the 2026
  // files `<kind>/<kind>year<year>.csv`. The seeder asked only for the first
  // shape, got a 404, and its `.catch(() => '')` turned that into "publish from
  // last year's file" — so production served December 2025 oil data from
  // January to August 2026 while reporting recordCount 50 and a fresh
  // fetchedAt. Nothing on the seed clock could see it; only the content clock
  // added in #6395 eventually surfaced it.

  it('offers both published filename conventions, plain name first', () => {
    assert.deepEqual(jodiCsvCandidates('primary', 2026), [
      'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/primary/2026.csv',
      'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/primary/primaryyear2026.csv',
    ]);
    assert.deepEqual(jodiCsvCandidates('secondary', 2026), [
      'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/secondary/2026.csv',
      'https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/secondary/secondaryyear2026.csv',
    ]);
  });

  it('falls through to the second convention when the first 404s', async () => {
    const asked = [];
    const fetchCsv = async (url) => {
      asked.push(url);
      if (url.endsWith('/2026.csv')) throw new Error('HTTP 404');
      return 'REF_AREA,TIME_PERIOD\nDE,2026-05\n';
    };
    const result = await fetchYearCsv('primary', 2026, { fetchCsv, retries: 0 });

    assert.equal(result.ok, true);
    assert.equal(result.text, 'REF_AREA,TIME_PERIOD\nDE,2026-05\n');
    assert.match(result.url, /primaryyear2026\.csv$/);
    assert.equal(asked.length, 2, 'must try the plain name before the prefixed one');
  });

  it('stops at the first convention that answers', async () => {
    const asked = [];
    const fetchCsv = async (url) => { asked.push(url); return 'rows'; };
    const result = await fetchYearCsv('secondary', 2025, { fetchCsv, retries: 0 });

    assert.equal(result.ok, true);
    assert.match(result.url, /secondary\/2025\.csv$/);
    assert.equal(asked.length, 1, 'a working plain name must not trigger a second request');
  });

  it('reports a total miss instead of silently returning an empty string', async () => {
    // The silent-empty return is the actual defect: a year that cannot be
    // fetched AT ALL must be distinguishable from a year that is legitimately
    // empty, or the next rename degrades to stale data just as quietly.
    const fetchCsv = async () => { throw new Error('HTTP 404'); };
    const result = await fetchYearCsv('primary', 2026, { fetchCsv, retries: 0 });

    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.match(result.error, /404/);
    assert.deepEqual(result.attempted, jodiCsvCandidates('primary', 2026));
  });
});

// The year files are 7-26 MB and jodidata.org serves them at about 1 MB/s per
// connection, so a fixed 30 s request timeout aborted every 2026 download on
// Railway (2026-10-29). A download is cut only when it stops moving or runs
// past its whole budget.
describe('JODI CSV download timeouts', () => {
  // A body that yields `chunks` pieces `gapMs` apart and errors on abort.
  const trickle = (chunks, gapMs) => async (_url, { signal }) => {
    const body = new ReadableStream({
      async start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        for (let i = 0; i < chunks; i++) {
          await new Promise((r) => setTimeout(r, gapMs));
          if (signal.aborted) return;
          controller.enqueue(new TextEncoder().encode(i === 0 ? 'REF_AREA,TIME_PERIOD\n' : `DE,2026-0${i}\n`));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };

  it('keeps a slow download that never stalls, past the per-chunk limit in total', async () => {
    const text = await fetchCsv('https://jodi.test/a.csv', { fetchImpl: trickle(6, 40), stallMs: 100, budgetMs: 2000 });
    assert.equal(text, 'REF_AREA,TIME_PERIOD\nDE,2026-01\nDE,2026-02\nDE,2026-03\nDE,2026-04\nDE,2026-05\n');
  });

  it('aborts a download that stops sending', async () => {
    const started = Date.now();
    await assert.rejects(
      fetchCsv('https://jodi.test/a.csv', { fetchImpl: trickle(3, 400), stallMs: 100, budgetMs: 5000 }),
      /stalled/,
    );
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });

  it('aborts a download past its whole budget, and does not retry it', async () => {
    const err = await fetchCsv('https://jodi.test/a.csv', { fetchImpl: trickle(50, 30), stallMs: 200, budgetMs: 300 }).catch((e) => e);
    assert.match(err?.message ?? '', /exceeded/);
    assert.equal(err.nonRetryable, true, 'a steady but slow transfer will not finish faster on a retry');
  });

  it('keeps a 404 non-retryable', async () => {
    const err = await fetchCsv('https://jodi.test/2026.csv', { fetchImpl: async () => new Response('missing', { status: 404 }) }).catch((e) => e);
    assert.match(err.message, /HTTP 404/);
    assert.equal(err.nonRetryable, true);
  });
});

// JODI files carry month-end closing stocks (CLOSTLV, thousand barrels) beside
// the kb/d flows. They are the only recurring stock observation for importers
// outside the IEA (India, Taiwan, Thailand, Philippines...).
describe('closing stocks (CLOSTLV)', () => {
  const stock = (product, month, value, area = 'IN') => makeRow({ REF_AREA: area, TIME_PERIOD: month, ENERGY_PRODUCT: product, FLOW_BREAKDOWN: 'CLOSTLV', UNIT_MEASURE: 'KBBL', OBS_VALUE: value });
  const flows = (month, area = 'IN') => [
    makeRow({ REF_AREA: area, TIME_PERIOD: month, ENERGY_PRODUCT: 'GASDIES', FLOW_BREAKDOWN: 'TOTDEMO', OBS_VALUE: '1900' }),
    makeRow({ REF_AREA: area, TIME_PERIOD: month, ENERGY_PRODUCT: 'CRUDEOIL', FLOW_BREAKDOWN: 'TOTIMPSB', OBS_VALUE: '4800' }),
  ];

  it('mergeSourceRows keeps the stock rows, which are in KBBL, not KBD', () => {
    const rows = mergeSourceRows(
      makeCsv([stock('CRUDEOIL', '2026-03', '45280'), makeRow({ FLOW_BREAKDOWN: 'TOTIMPSB', UNIT_MEASURE: 'KTONS' })]), '',
      makeCsv([...flows('2026-03'), stock('TOTPRODS', '2026-03', '95989')]), '',
    );
    assert.equal(rows.filter((r) => r.FLOW_BREAKDOWN === 'CLOSTLV').length, 2);
    assert.ok(!rows.some((r) => r.UNIT_MEASURE === 'KTONS'), 'other non-KBD units stay out');
  });

  it('publishes the latest month reporting both crude and product stocks, in million barrels', () => {
    const rows = [
      ...flows('2026-04'), ...flows('2026-03'),
      stock('CRUDEOIL', '2026-03', '45280'), stock('TOTPRODS', '2026-03', '95989'),
      stock('CRUDEOIL', '2026-04', '44000'), // products not yet filed for April
      stock('CRUDEOIL', '2026-02', '47000'), stock('TOTPRODS', '2026-02', '90000'),
    ];
    assert.deepEqual(extractCountryData(rows, 'IN').stocks, { month: '2026-03', crudeMb: 45.28, productsMb: 95.989 });
  });

  it('falls back to TOTCRUDE when CRUDEOIL carries no stock', () => {
    const rows = [...flows('2026-03'), stock('CRUDEOIL', '2026-03', '-'), stock('TOTCRUDE', '2026-03', '25354'), stock('TOTPRODS', '2026-03', '33166')];
    assert.deepEqual(extractCountryData(rows, 'IN').stocks, { month: '2026-03', crudeMb: 25.354, productsMb: 33.166 });
  });

  it('a zero TOTCRUDE stock is a placeholder, not an empty tank (India files KBBL 0 beside 6,086 kt)', () => {
    const rows = [...flows('2026-03'), stock('CRUDEOIL', '2026-03', '-'), stock('TOTCRUDE', '2026-03', '0'), stock('TOTPRODS', '2026-03', '95989')];
    assert.equal(extractCountryData(rows, 'IN').stocks, null);
  });

  it('is null when no month reports both, or the total is zero, and never reads another country', () => {
    assert.equal(extractCountryData([...flows('2026-03'), stock('CRUDEOIL', '2026-03', '45280')], 'IN').stocks, null);
    assert.equal(extractCountryData([...flows('2026-03'), stock('CRUDEOIL', '2026-03', '0'), stock('TOTPRODS', '2026-03', '0')], 'IN').stocks, null);
    assert.equal(extractCountryData([...flows('2026-03'), stock('CRUDEOIL', '2026-03', '1', 'TH'), stock('TOTPRODS', '2026-03', '1', 'TH')], 'IN').stocks, null);
  });

  it('stock rows never change the flow data month', () => {
    const rows = [...flows('2026-03'), stock('CRUDEOIL', '2026-05', '1'), stock('TOTPRODS', '2026-05', '1'), stock('GASDIES', '2026-05', '1')];
    assert.equal(extractCountryData(rows, 'IN').dataMonth, '2026-03');
  });
});

// IEA days of cover are days of the previous calendar year's net oil imports
// (crude, NGL and feedstocks, and products). Converting them with crude imports
// alone understates a product importer (Australia) and overstates a product
// exporter (Korea).
describe('net oil imports (IEA days basis)', () => {
  const flow = (area, month, product, flowCode, value) => makeRow({ REF_AREA: area, TIME_PERIOD: month, ENERGY_PRODUCT: product, FLOW_BREAKDOWN: flowCode, OBS_VALUE: String(value) });
  const year = (area, y, { crudeImp, crudeExp, prodImp, prodExp }, months = 12, crudeCode = 'TOTCRUDE', crudeImpByMonth = {}) => {
    const rows = [];
    for (let m = 1; m <= months; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      rows.push(flow(area, ym, crudeCode, 'TOTIMPSB', crudeImpByMonth[m] ?? crudeImp), flow(area, ym, crudeCode, 'TOTEXPSB', crudeExp),
        flow(area, ym, 'TOTPRODS', 'TOTIMPSB', prodImp), flow(area, ym, 'TOTPRODS', 'TOTEXPSB', prodExp));
    }
    return rows;
  };
  const current = (area, ym) => [flow(area, ym, 'GASDIES', 'TOTDEMO', 500)];

  it('averages crude plus product net imports over the calendar year before the data month', () => {
    // Australia-like: little crude, large product imports.
    const rows = [...year('AU', 2025, { crudeImp: 150, crudeExp: 20, prodImp: 900, prodExp: 40 }), ...current('AU', '2026-08')];
    assert.deepEqual(extractCountryData(rows, 'AU').netOilImports, [{ year: 2025, kbd: 990, months: 12 }]);
  });

  it('a product exporter nets its exports (Korea-like)', () => {
    const rows = [...year('KR', 2025, { crudeImp: 2800, crudeExp: 0, prodImp: 900, prodExp: 1300 }), ...current('KR', '2026-08')];
    assert.equal(extractCountryData(rows, 'KR').netOilImports[0].kbd, 2400);
  });

  it('uses CRUDEOIL when TOTCRUDE is not reported', () => {
    const rows = [...year('JP', 2025, { crudeImp: 2400, crudeExp: 0, prodImp: 600, prodExp: 300 }, 12, 'CRUDEOIL'), ...current('JP', '2026-08')];
    assert.equal(extractCountryData(rows, 'JP').netOilImports[0].kbd, 2700);
  });

  it('weights each month by its days, not equally', () => {
    // 1,000 kb/d all year except a 2,000 kb/d February: (1000 x 337 + 2000 x 28) / 365.
    const rows = [...year('JP', 2025, { crudeImp: 1000, crudeExp: 0, prodImp: 0, prodExp: 0 }, 12, 'TOTCRUDE', { 2: 2000 }), ...current('JP', '2026-08')];
    assert.equal(extractCountryData(rows, 'JP').netOilImports[0].kbd, 1076.7);
  });

  it('publishes every complete year before the data month, newest first, for the reader to match IEA', () => {
    const rows = [
      ...year('AU', 2024, { crudeImp: 200, crudeExp: 20, prodImp: 800, prodExp: 30 }),
      ...year('AU', 2025, { crudeImp: 150, crudeExp: 20, prodImp: 900, prodExp: 40 }),
      ...current('AU', '2026-01'),
    ];
    assert.deepEqual(extractCountryData(rows, 'AU').netOilImports.map((e) => [e.year, e.kbd]), [[2025, 990], [2024, 950]]);
  });

  it('omits a year with fewer than 9 complete months, or a net-exporting year', () => {
    assert.deepEqual(extractCountryData([...year('AU', 2025, { crudeImp: 150, crudeExp: 20, prodImp: 900, prodExp: 40 }, 8), ...current('AU', '2026-08')], 'AU').netOilImports, []);
    assert.deepEqual(extractCountryData([...year('NO', 2025, { crudeImp: 0, crudeExp: 1500, prodImp: 100, prodExp: 300 }), ...current('NO', '2026-08')], 'NO').netOilImports, []);
  });

  it("counts the data month's own year once it has 9 complete months (IEA in January, JODI at December)", () => {
    const full = [...year('AU', 2025, { crudeImp: 150, crudeExp: 20, prodImp: 900, prodExp: 40 }), ...current('AU', '2025-12')];
    assert.deepEqual(extractCountryData(full, 'AU').netOilImports, [{ year: 2025, kbd: 990, months: 12 }]);
    const partial = [...year('AU', 2025, { crudeImp: 150, crudeExp: 20, prodImp: 900, prodExp: 40 }, 8), ...current('AU', '2025-08')];
    assert.deepEqual(extractCountryData(partial, 'AU').netOilImports, []);
  });

  it('reads the optional lookback primary file, which holds the year IEA counts against each January', () => {
    const csv = makeCsv([makeRow({ REF_AREA: 'AU', TIME_PERIOD: '2024-05', ENERGY_PRODUCT: 'TOTCRUDE', FLOW_BREAKDOWN: 'TOTIMPSB', OBS_VALUE: '150' })]);
    const rows = mergeSourceRows('', '', makeCsv([makeRow({})]), '', '', csv);
    assert.ok(rows.some((r) => r.TIME_PERIOD === '2024-05' && r.ENERGY_PRODUCT === 'TOTCRUDE'));
  });
});

describe('prepareOilPublish refuses an older vintage than the published one', () => {
  const NOW = new Date('2026-10-29T07:32:00.000Z');

  /** Diesel demand for `count` countries, all in `month`. */
  function rowsFor(month, count = 45) {
    const rows = [];
    for (let index = 0; index < count; index++) {
      rows.push({
        REF_AREA: `X${String(index).padStart(2, '0')}`,
        TIME_PERIOD: month,
        ENERGY_PRODUCT: 'GASDIES',
        FLOW_BREAKDOWN: 'TOTDEMO',
        UNIT_MEASURE: 'KBD',
        OBS_VALUE: '894.4',
        ASSESSMENT_CODE: '1',
      });
    }
    return rows;
  }

  const publishedThrough = (month) => ({ newestItemAt: Date.parse(monthPeriodEnd(month)) });

  it('refuses a run whose newest month is older than the snapshot it would replace', () => {
    // 2026-10-29: every 2026 file timed out, so the run built December 2025
    // and overwrote a snapshot dated August 2026.
    const { refusalReason } = prepareOilPublish({
      allRows: rowsFor('2025-12'),
      previousMeta: publishedThrough('2026-08'),
      now: NOW,
    });
    assert.match(refusalReason ?? '', /newest month 2025-12 is older than the published 2026-08/);
  });

  it('publishes the same or a newer vintage', () => {
    for (const month of ['2026-08', '2026-09']) {
      const { refusalReason } = prepareOilPublish({
        allRows: rowsFor(month),
        previousMeta: publishedThrough('2026-08'),
        now: NOW,
      });
      assert.equal(refusalReason, null, month);
    }
  });

  it('publishes when no previous vintage is recorded', () => {
    for (const previousMeta of [null, {}, { newestItemAt: null }, { newestItemAt: 'not a time' }]) {
      const { refusalReason } = prepareOilPublish({ allRows: rowsFor('2025-12'), previousMeta, now: NOW });
      assert.equal(refusalReason, null, JSON.stringify(previousMeta));
    }
  });

  it('reads the previous vintage strictly: a failed read stops the run, a missing key does not', async (t) => {
    const previousDelay = process.env.WM_SEED_RETRY_DELAY_MS;
    process.env.WM_SEED_RETRY_DELAY_MS = '1';
    t.after(() => {
      if (previousDelay === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
      else process.env.WM_SEED_RETRY_DELAY_MS = previousDelay;
    });

    const calls = [];
    // Fails the first `failures` reads, then returns `value`.
    const read = (failures, value = null) => async (key, options) => {
      calls.push({ key, options });
      if (calls.length <= failures) throw new Error('Redis snapshot read failed: HTTP 503');
      return value;
    };

    await assert.rejects(
      readPreviousOilMeta(read(Infinity)),
      /HTTP 503/,
      'a read failure must not pass as "no previous vintage"',
    );
    assert.equal(calls.length, 3, 'a persistent failure is retried twice, then stops the run');

    calls.length = 0;
    assert.deepEqual(await readPreviousOilMeta(read(1, { newestItemAt: 1 })), { newestItemAt: 1 }, 'a transient failure is retried');

    calls.length = 0;
    assert.equal(await readPreviousOilMeta(read(0, null)), null, 'a missing key is a first publish');
    assert.equal(calls.length, 1);
    assert.ok(calls.every(({ key, options }) => key === 'seed-meta:energy:jodi-oil' && options?.strict === true));
  });

  it('keeps the country-floor reason when both gates fail', () => {
    const { refusalReason } = prepareOilPublish({
      allRows: rowsFor('2025-12', 39),
      previousMeta: publishedThrough('2026-08'),
      now: NOW,
    });
    assert.match(refusalReason ?? '', /only 39 countries/);
  });
});
