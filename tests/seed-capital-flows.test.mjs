// Pins the capital-flows seeder: SDMX parsing (IMF 3.0 and BIS 1.0 shapes),
// BOP quarterly/annual building, BIS bilateral aggregation, the PIP mirror,
// assembly and validation. Fully offline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseImfSdmx,
  parseBisSdmx,
  buildBopCountry,
  stockAndFlow,
  buildBankByCountry,
  buildPortfolioByCountry,
  parseWorldBankGdp,
  assembleCapitalFlows,
  isBisCountry,
  toIso2,
  validate,
  capitalFlowsContentMeta,
  CANONICAL_KEY,
} from '../scripts/seed-capital-flows.mjs';
import { nextQuarter } from '../scripts/_capital-flow-episodes.mjs';

function quarters(start, n) {
  const out = [start];
  while (out.length < n) out.push(nextQuarter(out.at(-1)));
  return out;
}

// Quarterly BOP rows in parsed form for one country. `inflow(i)` and
// `outflow(i)` give the total for quarter i, split evenly across D_F/P_F/O_F.
function bopRows(iso3, periods, inflow, outflow, freq = 'Q') {
  const rows = [];
  for (const [i, period] of periods.entries()) {
    for (const ind of ['D_F', 'P_F', 'O_F']) {
      rows.push({ COUNTRY: iso3, BOP_ACCOUNTING_ENTRY: 'L_NIL_T', INDICATOR: ind, UNIT: 'USD', FREQUENCY: freq, period, value: (inflow(i) * 1e9) / 3 });
      rows.push({ COUNTRY: iso3, BOP_ACCOUNTING_ENTRY: 'A_NFA_T', INDICATOR: ind, UNIT: 'USD', FREQUENCY: freq, period, value: (outflow(i) * 1e9) / 3 });
    }
    rows.push({ COUNTRY: iso3, BOP_ACCOUNTING_ENTRY: 'NETCD_T', INDICATOR: 'EO', UNIT: 'USD', FREQUENCY: freq, period, value: -1e9 });
  }
  return rows;
}

const wobble = (i) => ((i * 7) % 5) - 2;

describe('code filters', () => {
  it('maps ISO3 to ISO2 and rejects aggregates', () => {
    assert.equal(toIso2('GBR'), 'GB');
    assert.equal(toIso2('G001'), null);
    assert.equal(toIso2('U150'), null);
  });
  it('accepts only real ISO2 BIS countries', () => {
    assert.equal(isBisCountry('AE'), true);
    assert.equal(isBisCountry('5A'), false);
    assert.equal(isBisCountry('5J'), false);
    assert.equal(isBisCountry('ZZ'), false);
  });
});

describe('parseImfSdmx', () => {
  it('flattens SDMX 3.0 series keys and observation periods', () => {
    const json = { data: {
      dataSets: [{ structure: 0, series: { '0:1:0:0:0': { observations: { 0: ['1500000000', 0], 1: ['', 0], 2: ['-2.5e9'] } } } }],
      structures: [{ dimensions: {
        series: [
          { id: 'COUNTRY', values: [{ id: 'GBR' }] },
          { id: 'BOP_ACCOUNTING_ENTRY', values: [{ id: 'A_NFA_T' }, { id: 'L_NIL_T' }] },
          { id: 'INDICATOR', values: [{ id: 'P_F' }] },
          { id: 'UNIT', values: [{ id: 'USD' }] },
          { id: 'FREQUENCY', values: [{ id: 'Q' }] },
        ],
        observation: [{ id: 'TIME_PERIOD', values: [{ value: '2025-Q1' }, { value: '2025-Q2' }, { value: '2025-Q3' }] }],
      } }],
    } };
    const rows = parseImfSdmx(json);
    assert.equal(rows.length, 2, 'blank observation dropped');
    assert.deepEqual(rows[0], { COUNTRY: 'GBR', BOP_ACCOUNTING_ENTRY: 'L_NIL_T', INDICATOR: 'P_F', UNIT: 'USD', FREQUENCY: 'Q', period: '2025-Q1', value: 1.5e9 });
    assert.equal(rows[1].value, -2.5e9);
  });
  it('returns [] for an empty or malformed body', () => {
    assert.deepEqual(parseImfSdmx({}), []);
    assert.deepEqual(parseImfSdmx(null), []);
  });
});

describe('parseBisSdmx', () => {
  it('flattens SDMX-JSON 1.0 and drops NaN', () => {
    const json = { data: {
      dataSets: [{ series: { '0:0:0': { observations: { 0: ['84683.0'], 1: ['NaN'] } } } }],
      structure: { dimensions: {
        series: [
          { id: 'L_MEASURE', values: [{ id: 'S' }] },
          { id: 'L_REP_CTY', values: [{ id: 'GB' }] },
          { id: 'L_CP_COUNTRY', values: [{ id: 'AE' }] },
        ],
        observation: [{ id: 'TIME_PERIOD', values: [{ id: '2025-Q3' }, { id: '2025-Q4' }] }],
      } },
    } };
    assert.deepEqual(parseBisSdmx(json), [{ L_MEASURE: 'S', L_REP_CTY: 'GB', L_CP_COUNTRY: 'AE', period: '2025-Q3', value: 84683 }]);
  });
});

describe('buildBopCountry', () => {
  it('quarterly: classifies a sustained collapse in inflows as a current stop', () => {
    const periods = quarters('2014-Q1', 50); // to 2026-Q2
    const rows = bopRows('GBR', periods, (i) => 100 + wobble(i) - (i >= 46 ? 400 : 0), (i) => 100 + wobble(i));
    const bop = buildBopCountry({ quarterlyRows: rows, gdpUsd: 4e12, nowYear: 2026 });
    assert.equal(bop.frequency, 'quarterly');
    assert.equal(bop.latestPeriod, '2026-Q2');
    assert.equal(bop.state.inflow, 'stop');
    assert.equal(bop.state.outflow, null);
    assert.ok(bop.state.inflowZ < -2);
    assert.equal(bop.state.basis, 'derived');
    assert.equal(bop.episodes.stop.at(-1).end, '2026-Q2');
    assert.equal(bop.series.length, 12);
    const last = bop.series.at(-1);
    assert.equal(last.period, '2026-Q2');
    assert.equal(last.errorsOmissions, -1);
    assert.ok(Math.abs(last.inflows.total - (100 + wobble(49) - 400)) < 0.02);
    // trailing 4q % of GDP is consistent with the USD sum
    assert.ok(Math.abs(bop.trailing4q.inflowsPctGdp - (bop.trailing4q.inflowsUsdBn * 1e9 * 100) / 4e12) < 0.01);
  });

  it('falls back to annual when quarterly data is missing or stale', () => {
    const stale = bopRows('ARE', quarters('2005-Q1', 40), () => 10, () => 10); // ends 2014
    const annual = bopRows('ARE', ['2023', '2024', '2025'], (i) => [107.1, 124.7, 140.6][i], (i) => [112.9, 175.3, 196.7][i], 'A');
    const bop = buildBopCountry({ quarterlyRows: stale, annualRows: annual, gdpUsd: 552e9, nowYear: 2026 });
    assert.equal(bop.frequency, 'annual');
    assert.equal(bop.latestPeriod, '2025');
    assert.equal(bop.state, null);
    assert.equal(bop.episodes, null);
    assert.equal(bop.latestYear.inflowsUsdBn, 140.6);
    assert.equal(bop.latestYear.netUsdBn, -56.1);
    assert.equal(bop.latestYear.inflowsYoyPct, 12.75);
  });

  it('returns null with no usable data', () => {
    assert.equal(buildBopCountry({ nowYear: 2026 }), null);
  });
});

describe('BIS bank positions', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const F = (period, value, extra) => ({ L_MEASURE: 'F', period, value, ...extra });

  it('stockAndFlow sums the last four consecutive adjusted flows', () => {
    const rows = [S('2026-Q1', 80269), F('2025-Q2', 1000), F('2025-Q3', 5485.6), F('2025-Q4', -11178.9), F('2026-Q1', 7478.7)];
    const r = stockAndFlow(rows);
    assert.equal(r.period, '2026-Q1');
    assert.equal(r.stockUsdBn, 80.27);
    assert.equal(r.flow4qUsdBn, 2.79);
  });

  it('stockAndFlow refuses a gapped flow window', () => {
    const r = stockAndFlow([F('2025-Q1', 1), F('2025-Q2', 1), F('2025-Q4', 1), F('2026-Q1', 1)]);
    assert.equal(r.flow4qUsdBn, null);
  });

  it('buildBankByCountry: totals per counterparty, top bank locations and depositor origins', () => {
    const tot = (pos, sector, cp, s) => [S('2026-Q1', s, { L_REP_CTY: '5A', L_POSITION: pos, L_CP_SECTOR: sector, L_CP_COUNTRY: cp })];
    const totals = [
      ...tot('L', 'N', 'AE', 193200), ...tot('L', 'H', 'AE', 80400), ...tot('C', 'N', 'AE', 120000),
      ...tot('L', 'N', '5J', 1e9), // aggregate counterparty dropped
    ];
    const pair = (rep, cp, s) => S('2026-Q1', s, { L_REP_CTY: rep, L_POSITION: 'L', L_CP_SECTOR: 'N', L_CP_COUNTRY: cp });
    const bilateral = [pair('GB', 'AE', 44800), pair('CH', 'AE', 30000), pair('US', 'AE', 10000), pair('5A', 'AE', 193200), pair('GB', 'GB', 5)];
    const { byCountry, latestPeriod } = buildBankByCountry(totals, bilateral);
    assert.equal(latestPeriod, '2026-Q1');
    assert.equal(byCountry['5J'], undefined);
    const ae = byCountry.AE;
    assert.equal(ae.nonBankDepositsAbroad.stockUsdBn, 193.2);
    assert.equal(ae.householdDepositsAbroad.stockUsdBn, 80.4);
    assert.equal(ae.nonBankBorrowingFromAbroad.stockUsdBn, 120);
    assert.deepEqual(ae.topBankLocations.map((x) => x.iso2), ['GB', 'CH', 'US']);
    assert.equal(ae.reportsToBis, false, 'UAE is not a BIS reporter');
  });
});

describe('buildPortfolioByCountry (PIP mirror)', () => {
  const row = (holder, issuer, period, usdBn) => ({ COUNTRY: holder, ACCOUNTING_ENTRY: 'A', INDICATOR: 'P_TOTINV_P_USD', SECTOR: 'S1', COUNTERPART_SECTOR: 'S1', COUNTERPART_COUNTRY: issuer, FREQUENCY: 'A', period, value: usdBn * 1e9 });
  it('sums holders, ranks them, and compares the same reporters year on year', () => {
    const rows = [
      row('USA', 'ARE', '2025', 51.1), row('SAU', 'ARE', '2025', 15.4), row('GBR', 'ARE', '2025', 7.1),
      row('USA', 'ARE', '2024', 40), row('GBR', 'ARE', '2024', 5.3), row('CHN', 'ARE', '2024', 9), // CHN missing in 2025 → excluded from change
      row('G001', 'ARE', '2025', 999), // aggregate holder dropped
      row('USA', 'GBR', '2025', 1500), row('USA', 'GBR', '2024', 1400), row('GBR', 'GBR', '2025', 1),
      row('SAU', 'GBR', '2025', 10), row('SAU', 'GBR', '2024', 9),
      row('FRA', 'GBR', '2025', 3), // keeps 2025 reporter count at 4 of 2024's 4
    ];
    const { byCountry, year } = buildPortfolioByCountry(rows);
    assert.equal(year, 2025);
    const ae = byCountry.AE;
    assert.equal(ae.foreignHoldingsUsdBn, 73.6);
    assert.equal(ae.reporterCount, 3);
    assert.deepEqual(ae.topHolders.map((h) => h.iso2), ['US', 'SA', 'GB']);
    // matched reporters: USA 51.1 vs 40, GBR 7.1 vs 5.3 → 58.2 / 45.3 − 1
    assert.equal(ae.foreignHoldingsPrevYearUsdBn, 45.3);
    assert.equal(ae.changePct, 28.48);
    assert.equal(byCountry.US.holdingsAbroadUsdBn, 1551.1);
    assert.deepEqual(byCountry.US.topDestinations.map((d) => d.iso2), ['GB', 'AE']);
  });

  it('steps back a year when the newest year is thinly reported', () => {
    const rows = [
      row('USA', 'ARE', '2024', 40), row('SAU', 'ARE', '2024', 10), row('GBR', 'ARE', '2024', 5), row('FRA', 'ARE', '2024', 2), row('DEU', 'ARE', '2024', 1),
      row('USA', 'ARE', '2025', 50),
    ];
    assert.equal(buildPortfolioByCountry(rows).year, 2024);
  });
});

describe('parseWorldBankGdp', () => {
  it('keeps the latest non-null year per country', () => {
    const pages = [[{ pages: 1 }, [
      { countryiso3code: 'ARE', date: '2025', value: null },
      { countryiso3code: 'ARE', date: '2024', value: 552.3e9 },
      { countryiso3code: 'ARE', date: '2023', value: 514e9 },
      { countryiso3code: 'EUU', date: '2024', value: 1e13 },
    ]]];
    assert.deepEqual(parseWorldBankGdp(pages), { AE: { value: 552.3e9, year: 2024 } });
  });
});

describe('assembleCapitalFlows + validate', () => {
  it('joins sources by ISO2 and reports coverage and latest periods', () => {
    const periods = quarters('2014-Q1', 50);
    const data = assembleCapitalFlows({
      bopQuarterlyRows: bopRows('GBR', periods, (i) => 100 + wobble(i), (i) => 100 + wobble(i)),
      bopAnnualRows: bopRows('ARE', ['2024', '2025'], () => 120, () => 180, 'A'),
      bank: { byCountry: { AE: { reportsToBis: false }, GB: { reportsToBis: true } }, latestPeriod: '2026-Q1' },
      portfolio: { byCountry: { AE: { year: 2025 } }, year: 2025 },
      gdp: { GB: { value: 4e12, year: 2025 } },
      nowYear: 2026,
      seededAt: '2026-10-18T00:00:00.000Z',
    });
    assert.deepEqual(Object.keys(data.countries), ['AE', 'GB']);
    assert.equal(data.countries.GB.bop.frequency, 'quarterly');
    assert.equal(data.countries.AE.bop.frequency, 'annual');
    assert.equal(data.countries.GB.gdpUsdBn, 4000);
    assert.deepEqual(data.latest, { bopQuarter: '2026-Q2', bopNewestQuarter: '2026-Q2', bopYear: '2025', bisQuarter: '2026-Q1', pipYear: 2025 });
    assert.equal(data.coverage.bopQuarterly, 1);
    assert.equal(data.coverage.bisReporters, 1);
    assert.equal(data.units, 'USD billions');
    assert.ok(data.method.caveat.includes('residence'));
    assert.ok(capitalFlowsContentMeta(data).newestItemAt > 0);
    assert.equal(validate(data), false, 'two countries is below the floor');
  });

  it('validate accepts a full-coverage payload', () => {
    const countries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`C${i}`, {}]));
    assert.equal(validate({ countries, coverage: { bopQuarterly: 140, bopAnnualOnly: 50, bisCounterparties: 200, bisReporters: 30, portfolioCountries: 200 } }), true);
    assert.equal(validate({ countries, coverage: { bopQuarterly: 10, bopAnnualOnly: 50, bisCounterparties: 200, bisReporters: 30, portfolioCountries: 200 } }), false);
  });

  it('uses the v1 canonical key', () => {
    assert.equal(CANONICAL_KEY, 'economic:capital-flows:v1');
  });
});

describe('review regressions', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const F = (period, value, extra) => ({ L_MEASURE: 'F', period, value, ...extra });

  it('state, z and episodes agree with latestPeriod when one side runs a quarter ahead', () => {
    const periods = quarters('2014-Q1', 50); // to 2026-Q2
    const rows = bopRows('GBR', periods, (i) => 100 + wobble(i) - (i >= 45 ? 400 : 0), (i) => 100 + wobble(i))
      // outflows incomplete in 2026-Q2 → latest common quarter is 2026-Q1
      .filter((r) => !(r.period === '2026-Q2' && r.BOP_ACCOUNTING_ENTRY === 'A_NFA_T' && r.INDICATOR === 'O_F'));
    const bop = buildBopCountry({ quarterlyRows: rows, gdpUsd: 4e12, nowYear: 2026 });
    assert.equal(bop.latestPeriod, '2026-Q1');
    assert.equal(bop.state.inflow, 'stop');
    assert.ok(bop.episodes.stop.at(-1).end <= '2026-Q1');
    assert.equal(bop.series.at(-1).period, '2026-Q1');
  });

  it('trailing 4q totals refuse a quarter gap', () => {
    const periods = quarters('2014-Q1', 50).filter((p) => p !== '2025-Q3');
    const rows = bopRows('GBR', periods, (i) => 100 + wobble(i), (i) => 100 + wobble(i));
    const bop = buildBopCountry({ quarterlyRows: rows, gdpUsd: 4e12, nowYear: 2026 });
    assert.equal(bop.trailing4q.inflowsUsdBn, null);
    assert.equal(bop.trailing4q.inflowsPctGdp, null);
  });

  it('annual YoY needs the adjacent year', () => {
    const annual = bopRows('ARE', ['2022', '2025'], (i) => [100, 140][i], (i) => [100, 190][i], 'A');
    const bop = buildBopCountry({ annualRows: annual, nowYear: 2026 });
    assert.equal(bop.latestYear.inflowsYoyPct, null);
  });

  it('BIS flow window must end at the stock quarter', () => {
    const r = stockAndFlow([S('2026-Q1', 1000), F('2025-Q1', 1), F('2025-Q2', 1), F('2025-Q3', 1), F('2025-Q4', 1)]);
    assert.equal(r.period, '2026-Q1');
    assert.equal(r.flow4qUsdBn, null);
  });

  it('validate rejects a payload missing the annual BOP or the BIS bilateral view', () => {
    const countries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`C${i}`, {}]));
    const ok = { bopQuarterly: 140, bopAnnualOnly: 50, bisCounterparties: 200, bisReporters: 30, portfolioCountries: 200 };
    assert.equal(validate({ countries, coverage: ok }), true);
    assert.equal(validate({ countries, coverage: { ...ok, bopAnnualOnly: 0 } }), false);
    assert.equal(validate({ countries, coverage: { ...ok, bisReporters: 0 } }), false);
  });
});
