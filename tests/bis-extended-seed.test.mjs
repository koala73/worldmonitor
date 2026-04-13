import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseBisCSV,
  selectBestSeriesByCountry,
  buildDsr,
  buildPropertyPrices,
  quarterToDate,
  KEYS,
} from '../scripts/seed-bis-extended.mjs';

// Minimal BIS-style SDMX CSV fixture covering:
//   - Two DSR series per country (one private/adjusted → preferred, one
//     households/unadjusted → deprioritised) so selectBestSeriesByCountry
//     has to use dimension prefs to pick.
//   - A real-index SPP series plus a YoY-pct series — the real-index
//     variant (UNIT_MEASURE=628, PP_VALUATION=R) must win.
//   - Missing values (`.`) and empty rows — must be discarded.
const DSR_CSV = [
  'FREQ,BORROWERS_CTY,DSR_BORROWERS,DSR_ADJUST,TIME_PERIOD,OBS_VALUE',
  'Q,US,P,A,2023-Q2,9.8',
  'Q,US,P,A,2023-Q3,10.1',
  'Q,US,P,A,2023-Q4,10.4',
  'Q,US,H,U,2023-Q2,7.5',
  'Q,US,H,U,2023-Q3,7.6',
  'Q,GB,P,A,2023-Q3,8.2',
  'Q,GB,P,A,2023-Q4,.',
  'Q,GB,P,A,2023-Q4,8.5',
  '',
].join('\n');

const SPP_CSV = [
  'FREQ,REF_AREA,UNIT_MEASURE,PP_VALUATION,TIME_PERIOD,OBS_VALUE',
  'Q,US,628,R,2022-Q4,100.0',
  'Q,US,628,R,2023-Q1,101.2',
  'Q,US,628,R,2023-Q2,102.5',
  'Q,US,628,R,2023-Q3,103.0',
  'Q,US,628,R,2023-Q4,104.1',
  'Q,US,628,R,2024-Q4,108.5',
  'Q,US,771,R,2023-Q3,5.4', // YoY-change variant — must not be chosen
  'Q,XM,628,R,2023-Q4,99.0',
  'Q,XM,628,R,2024-Q4,100.5',
].join('\n');

describe('seed-bis-extended parser', () => {
  it('exports the canonical Redis keys', () => {
    assert.equal(KEYS.dsr, 'economic:bis:dsr:v1');
    assert.equal(KEYS.spp, 'economic:bis:property-residential:v1');
    assert.equal(KEYS.cpp, 'economic:bis:property-commercial:v1');
  });

  it('maps BIS quarter strings to first day of the quarter', () => {
    assert.equal(quarterToDate('2023-Q3'), '2023-07-01');
    assert.equal(quarterToDate('2024-Q1'), '2024-01-01');
    assert.equal(quarterToDate('2024-Q4'), '2024-10-01');
    // Non-quarterly strings pass through unchanged (monthly or daily BIS periods).
    assert.equal(quarterToDate('2024-06'), '2024-06');
  });

  it('parses CSV rows and drops blank lines', () => {
    const rows = parseBisCSV(DSR_CSV);
    assert.ok(rows.length >= 7, 'expected at least 7 non-empty rows');
    assert.equal(rows[0].TIME_PERIOD, '2023-Q2');
    assert.equal(rows[0].BORROWERS_CTY, 'US');
  });

  it('buildDsr prefers DSR_BORROWERS=P / DSR_ADJUST=A and returns latest+QoQ', () => {
    const rows = parseBisCSV(DSR_CSV);
    const entries = buildDsr(rows);
    const us = entries.find(e => e.countryCode === 'US');
    assert.ok(us, 'expected US entry');
    // The adjusted-private series wins, so latest must be 10.4 not 7.6.
    assert.equal(us.dsrPct, 10.4);
    assert.equal(us.previousDsrPct, 10.1);
    assert.equal(us.period, '2023-Q4');
    assert.equal(us.date, '2023-10-01');
    assert.ok(us.change !== null);
  });

  it('buildPropertyPrices picks the real-index series (628/R) and computes YoY', () => {
    const rows = parseBisCSV(SPP_CSV);
    const entries = buildPropertyPrices(rows, 'residential');
    const us = entries.find(e => e.countryCode === 'US');
    assert.ok(us, 'expected US entry');
    assert.equal(us.indexValue, 108.5); // latest observation
    assert.equal(us.period, '2024-Q4');
    assert.equal(us.kind, 'residential');
    // YoY: 108.5 / 104.1 − 1 ≈ 4.2%.
    assert.ok(us.yoyChange !== null && Math.abs(us.yoyChange - 4.2) < 0.2, `yoyChange=${us.yoyChange}`);
    // Euro Area (XM) should also come through.
    const xm = entries.find(e => e.countryCode === 'XM');
    assert.ok(xm, 'expected XM entry');
    assert.equal(xm.kind, 'residential');
  });

  it('selectBestSeriesByCountry ignores series with no usable observations', () => {
    const rows = [
      { FREQ: 'Q', REF_AREA: 'US', UNIT_MEASURE: '628', PP_VALUATION: 'R', TIME_PERIOD: '2023-Q1', OBS_VALUE: '.' },
      { FREQ: 'Q', REF_AREA: 'US', UNIT_MEASURE: '628', PP_VALUATION: 'R', TIME_PERIOD: '2023-Q2', OBS_VALUE: '' },
    ];
    const out = selectBestSeriesByCountry(rows, { countryColumns: ['REF_AREA'], prefs: { PP_VALUATION: 'R' } });
    assert.equal(out.size, 0);
  });
});
