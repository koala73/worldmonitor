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
  buildBankPairs,
  buildPortfolioPairs,
  buildFdi,
  emptyUpstreams,
  selectBankInstrument,
  publishTransform,
  pairsPayload,
  declarePairRecords,
  CANONICAL_KEY,
  PAIRS_KEY,
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
    assert.equal(ae.publishesBilateral, false, 'UAE banks publish no bilateral breakdown');
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
      bank: { byCountry: { AE: { publishesBilateral: false }, GB: { publishesBilateral: true } }, latestPeriod: '2026-Q1' },
      portfolio: { byCountry: { AE: { year: 2025 } }, year: 2025 },
      gdp: { GB: { value: 4e12, year: 2025 } },
      nowYear: 2026,
      seededAt: '2026-10-18T00:00:00.000Z',
    });
    assert.deepEqual(Object.keys(data.countries), ['AE', 'GB']);
    assert.equal(data.countries.GB.bop.frequency, 'quarterly');
    assert.equal(data.countries.AE.bop.frequency, 'annual');
    assert.equal(data.countries.GB.gdpUsdBn, 4000);
    assert.deepEqual(data.latest, { bopQuarter: '2026-Q2', bopNewestQuarter: '2026-Q2', bopYear: '2025', bisQuarter: '2026-Q1', pipYear: 2025, fdiYear: null });
    assert.equal(data.coverage.bopQuarterly, 1);
    assert.equal(data.coverage.bisReporters, 1);
    assert.equal(data.units, 'USD billions');
    assert.ok(data.method.caveat.includes('residence'));
    assert.ok(capitalFlowsContentMeta(data).newestItemAt > 0);
    assert.equal(validate(data), false, 'two countries is below the floor');
  });

  it('validate accepts a full-coverage payload', () => {
    const countries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`C${i}`, {}]));
    const full = { bopQuarterly: 140, bopAnnualOnly: 50, bisCounterparties: 200, bisReporters: 30, portfolioCountries: 200, bankPairReporters: 30, portfolioPairHolders: 79, fdiPairReporters: 106 };
    assert.equal(validate({ countries, coverage: full }), true);
    assert.equal(validate({ countries, coverage: { ...full, bopQuarterly: 10 } }), false);
    assert.equal(validate({ countries, coverage: { ...full, bankPairReporters: 0 } }), false, 'empty bank matrix');
    assert.equal(validate({ countries, coverage: { ...full, portfolioPairHolders: 0 } }), false, 'empty portfolio matrix');
    assert.equal(validate({ countries, coverage: { ...full, fdiPairReporters: 0 } }), false, 'empty FDI matrix');
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
    const ok = { bopQuarterly: 140, bopAnnualOnly: 50, bisCounterparties: 200, bisReporters: 30, portfolioCountries: 200, bankPairReporters: 30, portfolioPairHolders: 79, fdiPairReporters: 106 };
    assert.equal(validate({ countries, coverage: ok }), true);
    assert.equal(validate({ countries, coverage: { ...ok, bopAnnualOnly: 0 } }), false);
    assert.equal(validate({ countries, coverage: { ...ok, bisReporters: 0 } }), false);
  });
});

describe('bilateral matrices', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const F = (period, value, extra) => ({ L_MEASURE: 'F', period, value, ...extra });
  const pos = (rep, cp, position) => ({ L_REP_CTY: rep, L_CP_COUNTRY: cp, L_POSITION: position, L_CP_SECTOR: 'N' });

  it('buildBankPairs keeps deposits and lending per reporter × counterparty, in USD bn', () => {
    const q = ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1'];
    const rows = [
      S('2026-Q1', 7150, pos('FR', 'SG', 'L')), ...q.map((p) => F(p, 337.5, pos('FR', 'SG', 'L'))),
      S('2026-Q1', 13950, pos('FR', 'SG', 'C')),
      S('2026-Q1', 900, pos('GB', 'FR', 'L')),
      S('2026-Q1', 5, pos('FR', 'FR', 'L')), // self-pair dropped
      S('2026-Q1', 5, pos('5A', 'SG', 'L')), // aggregate reporter dropped
      { ...S('2026-Q1', 5, pos('FR', 'SG', 'L')), L_CP_SECTOR: 'B' }, // banks sector ignored
    ];
    const out = buildBankPairs(rows);
    assert.equal(out.period, '2026-Q1');
    assert.deepEqual(out.quarters, ['2024-Q2', '2024-Q3', '2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1']);
    assert.deepEqual(out.reporters, ['FR', 'GB']);
    assert.deepEqual(out.byReporter.FR.SG.slice(0, 4), [7.15, 1.35, 13.95, null]);
    assert.deepEqual(out.byReporter.FR.SG[4], [null, null, null, null, 0.34, 0.34, 0.34, 0.34], 'deposit flows aligned to quarters');
    assert.equal(out.byReporter.FR.SG[5], null, 'no lending flows reported');
    assert.deepEqual(out.byReporter.GB.FR, [0.9, null, null, null, null, null]);
    assert.equal(out.byReporter.FR.FR, undefined);
  });

  it('buildPortfolioPairs keeps holder × issuer with the prior-year holding', () => {
    const row = (holder, issuer, period, usdBn) => ({ COUNTRY: holder, ACCOUNTING_ENTRY: 'A', INDICATOR: 'P_TOTINV_P_USD', SECTOR: 'S1', COUNTERPART_SECTOR: 'S1', COUNTERPART_COUNTRY: issuer, FREQUENCY: 'A', period, value: usdBn * 1e9 });
    const out = buildPortfolioPairs([
      row('FRA', 'SGP', '2025', 4.4), row('FRA', 'SGP', '2024', 2.81),
      row('SGP', 'USA', '2025', 924.67),
      row('USA', 'FRA', '2025', 500),
    ]);
    assert.equal(out.year, 2025);
    assert.deepEqual(out.holders, ['FR', 'SG', 'US']);
    assert.deepEqual(out.byHolder.FR.SG, [4.4, 2.81]);
    assert.deepEqual(out.byHolder.SG.US, [924.67, null]);
    assert.equal(out.byHolder.SG.FR, undefined, 'Singapore does not itemize France');
  });

  it('publishTransform strips the matrices from the canonical key; pairsPayload carries them', () => {
    const data = { countries: { FR: {} }, pairs: { bank: { reporters: ['FR'], byReporter: {} }, portfolio: { holders: ['FR', 'SG'], byHolder: {} } }, seededAt: 't' };
    assert.equal('pairs' in publishTransform(data), false);
    assert.deepEqual(publishTransform(data).countries, { FR: {} });
    assert.deepEqual(pairsPayload(data), { bank: data.pairs.bank, portfolio: data.pairs.portfolio, seededAt: 't' });
    assert.equal(declarePairRecords(pairsPayload(data)), 3, 'runSeed passes the transformed extra-key payload');
    assert.equal(PAIRS_KEY, 'economic:capital-flows:pairs:v1');
  });
});

describe('buildFdi (IMF DIP)', () => {
  const row = (rep, cp, indicator, period, usdBn, dv = 'O') => ({ COUNTRY: rep, DV_TYPE: dv, INDICATOR: indicator, COUNTERPART_COUNTRY: cp, FREQUENCY: 'A', period, value: usdBn * 1e9 });
  const IN = 'INWD_D_NETLA_FALL_ALL';
  const OUT = 'OTWD_D_NETAL_FALL_ALL';
  it('keeps each reporter\'s inward and outward positions by counterpart, and per-country tops', () => {
    const rows = [
      row('AAA', 'BBB', IN, '2024', 0), // unknown ISO3s are dropped below
      row('USA', 'CHE', OUT, '2024', 212.9), row('USA', 'CHE', IN, '2024', 358.15),
      row('CHE', 'USA', OUT, '2024', 370.33), row('CHE', 'USA', IN, '2024', 186.8),
      row('USA', 'GBR', IN, '2024', 742.74), row('USA', 'GBR', OUT, '2024', 1024.6),
      row('USA', 'CHE', OUT, '2024', 999, 'SCC'), // counterpart-derived copy ignored
      row('USA', 'G001', IN, '2024', 5000), // aggregate dropped
      row('USA', 'CHE', OUT, '2023', 200), row('CHE', 'USA', OUT, '2023', 360),
    ];
    const { pairs, byCountry } = buildFdi(rows);
    assert.equal(pairs.year, 2024);
    assert.deepEqual(pairs.reporters, ['CH', 'US']);
    assert.deepEqual(pairs.byReporter.US.CH, [358.15, 212.9]);
    assert.deepEqual(pairs.byReporter.CH.US, [186.8, 370.33]);
    assert.equal(byCountry.US.inwardUsdBn, 1100.89);
    assert.deepEqual(byCountry.US.topInvestors.map((x) => x.iso2), ['GB', 'CH']);
    assert.deepEqual(byCountry.US.topDestinations.map((x) => x.iso2), ['GB', 'CH']);
  });
});

describe('pair review regressions', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const F = (period, value, extra) => ({ L_MEASURE: 'F', period, value, ...extra });
  const pos = (rep, cp, position) => ({ L_REP_CTY: rep, L_CP_COUNTRY: cp, L_POSITION: position, L_CP_SECTOR: 'N' });
  it('a bank pair whose series ended before the latest quarter carries no current stock or flow', () => {
    const rows = [
      S('2026-Q1', 900, pos('GB', 'FR', 'L')),
      S('2025-Q3', 5000, pos('CH', 'FR', 'L')),
      ...['2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3'].map((p) => F(p, 250, pos('CH', 'FR', 'L'))),
    ];
    const out = buildBankPairs(rows);
    assert.equal(out.period, '2026-Q1');
    assert.equal(out.byReporter.CH.FR[0], null, 'stale stock dropped');
    assert.equal(out.byReporter.CH.FR[1], null, 'stale flow dropped');
    assert.deepEqual(out.byReporter.CH.FR[4], [null, null, 0.25, 0.25, 0.25, 0.25, null, null], 'history kept with its own quarters');
  });
});

describe('emptyUpstreams', () => {
  it('names each empty pull, including one half of a split request', () => {
    assert.deepEqual(emptyUpstreams({ dipInward: [{}], dipOutward: [], bisPairs: [{}] }), ['dipOutward']);
    assert.deepEqual(emptyUpstreams({ a: [{}] }), []);
  });
});

describe('PR review regressions (#9395)', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const tot = (pos, sector, cp, period, s) => S(period, s, { L_REP_CTY: '5A', L_POSITION: pos, L_CP_SECTOR: sector, L_CP_COUNTRY: cp });

  it('quarterly state uses the latest quarter BOTH sides report completely', () => {
    const periods = quarters('2014-Q1', 50); // to 2026-Q2
    const rows = bopRows('GBR', periods, (i) => 100 + wobble(i), (i) => 100 + wobble(i))
      // inflows lack 2026-Q1 (incomplete) but have 2026-Q2; outflows end 2026-Q1
      .filter((r) => !(r.period === '2026-Q1' && r.BOP_ACCOUNTING_ENTRY === 'L_NIL_T' && r.INDICATOR === 'P_F'))
      .filter((r) => !(r.period === '2026-Q2' && r.BOP_ACCOUNTING_ENTRY === 'A_NFA_T'));
    const bop = buildBopCountry({ quarterlyRows: rows, gdpUsd: 4e12, nowYear: 2026 });
    assert.equal(bop.latestPeriod, '2025-Q4', 'last quarter complete on both sides');
    assert.ok(bop.state.inflowZ != null && bop.state.outflowZ != null);
  });

  it('a country that only holds securities abroad has null, not zero, foreign holdings', () => {
    const row = (holder, issuer, period, usdBn) => ({ COUNTRY: holder, ACCOUNTING_ENTRY: 'A', INDICATOR: 'P_TOTINV_P_USD', SECTOR: 'S1', COUNTERPART_SECTOR: 'S1', COUNTERPART_COUNTRY: issuer, FREQUENCY: 'A', period, value: usdBn * 1e9 });
    const { byCountry } = buildPortfolioByCountry([row('USA', 'GBR', '2025', 10), row('FRA', 'GBR', '2025', 5)]);
    assert.equal(byCountry.US.foreignHoldingsUsdBn, null);
    assert.equal(byCountry.US.reporterCount, 0);
    assert.equal(byCountry.GB.foreignHoldingsUsdBn, 15);
  });

  it('country bank view drops positions and partners older than the latest BIS quarter', () => {
    const totals = [tot('L', 'N', 'FR', '2026-Q1', 1000), tot('L', 'H', 'FR', '2025-Q2', 300), tot('C', 'N', 'FR', '2026-Q1', 2000)];
    const pair = (rep, period, s) => S(period, s, { L_REP_CTY: rep, L_POSITION: 'L', L_CP_SECTOR: 'N', L_CP_COUNTRY: 'FR' });
    const { byCountry, latestPeriod } = buildBankByCountry(totals, [pair('GB', '2026-Q1', 50), pair('CH', '2025-Q2', 900)]);
    assert.equal(latestPeriod, '2026-Q1');
    assert.equal(byCountry.FR.nonBankDepositsAbroad.stockUsdBn, 1);
    assert.equal(byCountry.FR.householdDepositsAbroad.stockUsdBn, null, 'stale household series');
    assert.deepEqual(byCountry.FR.topBankLocations.map((x) => x.iso2), ['GB'], 'stale partner dropped');
  });
});

describe('one-sided quarterly series', () => {
  it('stays quarterly on the side that is complete when the other never is', () => {
    const periods = quarters('2014-Q1', 50);
    // outflows never carry direct investment, so they are never complete
    const rows = bopRows('TZA', periods, (i) => 10 + wobble(i), (i) => 10 + wobble(i))
      .filter((r) => !(r.BOP_ACCOUNTING_ENTRY === 'A_NFA_T' && r.INDICATOR === 'D_F'));
    const bop = buildBopCountry({ quarterlyRows: rows, gdpUsd: 1e11, nowYear: 2026 });
    assert.equal(bop.frequency, 'quarterly');
    assert.equal(bop.latestPeriod, '2026-Q2');
    assert.ok(bop.state.inflowZ != null);
    assert.equal(bop.state.outflowZ, null);
    assert.equal(bop.trailing4q.outflowsUsdBn, null);
  });
});

describe('bank instrument choice', () => {
  const S = (period, value, extra) => ({ L_MEASURE: 'S', period, value, ...extra });
  const row = (rep, cp, instr, s) => S('2026-Q1', s, { L_REP_CTY: rep, L_CP_COUNTRY: cp, L_POSITION: 'L', L_CP_SECTOR: 'N', L_INSTR: instr });
  it('uses loans and deposits where published and all instruments only as a named fallback', () => {
    const rows = [row('FR', 'DE', 'G', 500), row('FR', 'DE', 'A', 700), row('JP', 'DE', 'A', 300)];
    const { rows: kept, allInstrumentReporters } = selectBankInstrument(rows);
    assert.deepEqual(kept.map((r) => `${r.L_REP_CTY}:${r.L_INSTR}`), ['FR:G', 'JP:A']);
    assert.deepEqual([...allInstrumentReporters], ['JP']);
    const pairs = buildBankPairs(rows);
    assert.deepEqual(pairs.reporters, ['FR', 'JP']);
    assert.deepEqual(pairs.allInstrumentReporters, ['JP']);
    assert.equal(pairs.byReporter.FR.DE[0], 0.5, 'G figure, not A');
    assert.equal(pairs.byReporter.JP.DE[0], 0.3);
  });
});
