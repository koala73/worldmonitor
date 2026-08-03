import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  validateCoverage,
  mergeSourceRows,
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
        ...demandRows('CN', '2025-04', { GASDIES: 600, GASOLINE: 600, JETKERO: 600 }, '3'),
      ], 'CN', '2026-04'),
      null,
      'assessment code 3 is not an observation',
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
