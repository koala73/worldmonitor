// get_capital_flows: dispatch through the real cache-tool pipeline against a
// payload built by the seeder's own assembly code, so producer and reader
// shapes cannot drift apart.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../api/mcp/dispatch.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import { rankingRow } from '../api/mcp/registry/_capital-flows.ts';
import { assembleCapitalFlows } from '../scripts/seed-capital-flows.mjs';
import { nextQuarter } from '../scripts/_capital-flow-episodes.mjs';
import { validate } from './helpers/json-schema-mini.mjs';
import ISO3_TO_ISO2 from '../scripts/shared/iso3-to-iso2.json' with { type: 'json' };

const tool = CACHE_TOOLS.find((t) => t.name === 'get_capital_flows');

function quarters(start, n) {
  const out = [start];
  while (out.length < n) out.push(nextQuarter(out.at(-1)));
  return out;
}
const wobble = (i) => ((i * 7) % 5) - 2;

function bopRows(iso3, periods, inflow, outflow) {
  const rows = [];
  for (const [i, period] of periods.entries()) {
    for (const ind of ['D_F', 'P_F', 'O_F']) {
      rows.push({ COUNTRY: iso3, BOP_ACCOUNTING_ENTRY: 'L_NIL_T', INDICATOR: ind, period, value: (inflow(i) * 1e9) / 3 });
      rows.push({ COUNTRY: iso3, BOP_ACCOUNTING_ENTRY: 'A_NFA_T', INDICATOR: ind, period, value: (outflow(i) * 1e9) / 3 });
    }
  }
  return rows;
}

function fixture() {
  const periods = quarters('2014-Q1', 50); // to 2026-Q2
  return assembleCapitalFlows({
    bopQuarterlyRows: [
      // GB: residents' outflows jump at the end → open flight episode
      ...bopRows('GBR', periods, (i) => 100 + wobble(i), (i) => 100 + wobble(i) + (i >= 46 ? 400 : 0)),
      // TR: foreign inflows collapse at the end → open stop episode
      ...bopRows('TUR', periods, (i) => 20 + wobble(i) - (i >= 46 ? 200 : 0), (i) => 20 + wobble(i)),
      ...bopRows('USA', periods, (i) => 300 + wobble(i), (i) => 200 + wobble(i)),
    ],
    bopAnnualRows: bopRows('ARE', ['2023', '2024', '2025'], (i) => [107, 125, 141][i], (i) => [113, 175, 197][i]),
    bank: {
      byCountry: {
        AE: { latestPeriod: '2026-Q1', nonBankDepositsAbroad: { stockUsdBn: 193.2, flow4qUsdBn: 22.3 }, householdDepositsAbroad: { stockUsdBn: 80.4, flow4qUsdBn: 6.8 }, nonBankBorrowingFromAbroad: { stockUsdBn: 120, flow4qUsdBn: 11.8 }, topBankLocations: [{ iso2: 'GB', stockUsdBn: 44.8, flow4qUsdBn: 5.9 }], publishesBilateral: false, topDepositorOrigins: [] },
        GB: { latestPeriod: '2026-Q1', nonBankDepositsAbroad: { stockUsdBn: 2472.4, flow4qUsdBn: 12.1 }, householdDepositsAbroad: { stockUsdBn: 77.3, flow4qUsdBn: -6.1 }, nonBankBorrowingFromAbroad: { stockUsdBn: 3000, flow4qUsdBn: 50 }, topBankLocations: [], publishesBilateral: true, topDepositorOrigins: [{ iso2: 'US', stockUsdBn: 900, flow4qUsdBn: 10 }] },
      },
      latestPeriod: '2026-Q1',
    },
    portfolio: { byCountry: { AE: { year: 2025, foreignHoldingsUsdBn: 201.5, foreignHoldingsPrevYearUsdBn: 171.9, changePct: 17.22, reporterCount: 70, topHolders: [{ iso2: 'US', usdBn: 51.1 }], holdingsAbroadUsdBn: null, topDestinations: [] } }, year: 2025 },
    gdp: { GB: { value: 4e12, year: 2025 }, AE: { value: 552e9, year: 2024 }, TR: { value: 1.6e12, year: 2025 }, US: { value: 3.08e13, year: 2025 } },
    nowYear: 2026,
    seededAt: SEEDED_AT,
  });
}

const SEEDED_AT = '2026-10-18T19:00:00.000Z';

const PAIRS = {
  bank: { period: '2026-Q1', quarters: ['2025-Q4', '2026-Q1'], reporters: ['GB', 'US'], byReporter: { GB: { AE: [44.8, 5.9, 65.8, 11.8], US: [900, 10, 1200, 5, [4, 6], null] }, US: { GB: [700, 20, 800, 9] } } },
  portfolio: { year: 2025, holders: ['GB', 'US'], byHolder: { GB: { AE: [7.1, 5.3], US: [1500, 1400] }, US: { AE: [51.1, 40], GB: [1600, 1500] } } },
  fdi: { year: 2024, reporters: ['GB', 'US'], byReporter: { GB: { US: [742.74, 1024.6] }, US: { GB: [700, 980] } } },
  seededAt: '2026-10-18T19:00:00.000Z',
};

async function run(params, payload = fixture(), pairs = PAIRS) {
  const now = Date.now();
  const stored = {
    'economic:capital-flows:v1': payload,
    'economic:capital-flows:pairs:v1': pairs,
    'seed-meta:economic:capital-flows': { fetchedAt: now, recordCount: Object.keys(payload.countries).length, newestItemAt: now - 60 * 86400_000, maxContentAgeMin: 12 * 30 * 24 * 60 },
  };
  const originalFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
    return Response.json({ result: stored[key] == null ? null : JSON.stringify(stored[key]) });
  };
  try { return await executeTool(tool, params, now); }
  finally {
    globalThis.fetch = originalFetch;
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

describe('get_capital_flows', () => {
  it('is registered as a free-account cache tool on the capital-flows key', () => {
    assert.ok(tool);
    assert.deepEqual(tool._cacheKeys, ['economic:capital-flows:v1', 'economic:capital-flows:pairs:v1']);
    assert.deepEqual(tool._apiPaths, ['GET /api/economic/v1/get-capital-flows']);
    assert.equal(tool._execute, undefined);
  });

  it('ranks every country by outflow z-score by default and validates against outputSchema', async () => {
    const result = await run({});
    assert.equal(result.stale, false);
    const cf = result.data['capital-flows'];
    assert.equal(cf.sort, 'outflow_z');
    assert.equal(cf.order, 'descending');
    assert.equal(cf.countries, undefined);
    assert.equal(cf.ranking[0].country, 'GB');
    assert.equal(cf.ranking[0].outflowState, 'flight');
    assert.ok(cf.ranking.every((r, i, a) => i === 0 || a[i - 1].outflowZ >= r.outflowZ));
    assert.ok(!cf.ranking.some((r) => r.country === 'AE'), 'annual-only countries have no z-score to rank');
    assert.ok(cf.method.caveat.includes('residence'));
    assert.deepEqual(validate(tool.outputSchema, result), []);
  });

  it('ascending inflow_z puts the sudden stop first', async () => {
    const cf = (await run({ sort: 'inflow_z', ascending: true })).data['capital-flows'];
    assert.equal(cf.ranking[0].country, 'TR');
    assert.equal(cf.ranking[0].inflowState, 'stop');
  });

  it('ranks annual-only countries on GDP-scaled flows', async () => {
    // AE inflows 141bn on a 552bn GDP (25.5%) beat GB's 400bn on 4tn (10%).
    const cf = (await run({ sort: 'inflows_pct_gdp', limit: 2 })).data['capital-flows'];
    assert.equal(cf.ranking.length, 2);
    assert.equal(cf.ranking[0].country, 'AE');
    assert.equal(cf.ranking[0].frequency, 'annual');
    assert.ok(cf.rankedCount >= 4);
  });

  it('returns full views for named countries, by code or name, with series only on request', async () => {
    const cf = (await run({ country: ['GB', 'United Arab Emirates'] })).data['capital-flows'];
    assert.deepEqual(Object.keys(cf.countries).sort(), ['AE', 'GB']);
    assert.equal(cf.ranking, undefined);
    assert.equal(cf.countries.GB.bop.series, undefined);
    assert.equal(cf.countries.GB.bop.state.outflow, 'flight');
    assert.equal(cf.countries.AE.bop.frequency, 'annual');
    assert.equal(cf.countries.AE.bank.publishesBilateral, false);
    assert.equal(cf.countries.AE.portfolio.topHolders[0].iso2, 'US');
    const withSeries = (await run({ country: ['GB'], include_series: true })).data['capital-flows'];
    assert.equal(withSeries.countries.GB.bop.series.length, 12);
  });

  it('never returns the raw pair matrices', async () => {
    for (const params of [{}, { country: ['GB'] }, { country: ['GB'], counterpart: 'US' }]) {
      const result = await run(params);
      assert.equal(result.data['capital-flows-pairs'], undefined, JSON.stringify(params));
      assert.ok(!JSON.stringify(result).includes('byReporter'));
    }
  });

  it('counterpart returns both directions for each country, plus the counterpart view', async () => {
    const result = await run({ country: ['United Arab Emirates', 'US'], counterpart: 'GBR' });
    const cf = result.data['capital-flows'];
    assert.deepEqual(Object.keys(cf.countries).sort(), ['AE', 'GB', 'US']);
    assert.equal(cf.pairs.length, 2);
    const [ae, us] = cf.pairs;
    assert.equal(ae.country, 'AE');
    assert.equal(ae.counterpart, 'GB');
    assert.deepEqual(ae.aDepositsInB, { status: 'reported', stockUsdBn: 44.8, flow4qUsdBn: 5.9, instrument: 'loans_deposits' });
    assert.deepEqual(ae.bDepositsInA, { status: 'not_published' }, 'UAE banks publish no bilateral data');
    assert.deepEqual(ae.bHoldingsOfA, { status: 'reported', stockUsdBn: 7.1, prevYearUsdBn: 5.3 });
    assert.deepEqual(ae.aHoldingsOfB, { status: 'not_published' });
    assert.deepEqual(us.aDepositsInB, { status: 'reported', stockUsdBn: 900, flow4qUsdBn: 10, history: [{ period: '2025-Q4', usdBn: 4 }, { period: '2026-Q1', usdBn: 6 }], instrument: 'loans_deposits' });
    assert.deepEqual(us.bDepositsInA, { status: 'reported', stockUsdBn: 700, flow4qUsdBn: 20, instrument: 'loans_deposits' }, 'empty basis and history are dropped');
    // US FDI in GB: the US reports 980 outward; GB reports 742.74 inward from the US.
    assert.deepEqual(us.aFdiInB, { status: 'reported', stockUsdBn: 980, basis: 'investor', counterpartReportUsdBn: 742.74 });
    assert.deepEqual(us.bFdiInA, { status: 'reported', stockUsdBn: 1024.6, basis: 'investor', counterpartReportUsdBn: 700 });
    assert.equal(us.fdiYear, 2024);
    assert.deepEqual(ae.aFdiInB, { status: 'not_itemized' }, 'GB reports FDI but not with AE');
    assert.deepEqual(validate(tool.outputSchema, result), []);
  });

  it('a counterpart equal to the country produces no self-pair', async () => {
    const cf = (await run({ country: ['GB'], counterpart: 'GB' })).data['capital-flows'];
    assert.deepEqual(cf.pairs, []);
  });

  it('pairs are null when the matrices come from a different seed run', async () => {
    const cf = (await run({ country: ['GB'], counterpart: 'US' }, fixture(), { ...PAIRS, seededAt: '2026-10-11T19:00:00.000Z' })).data['capital-flows'];
    assert.deepEqual(cf.pairs, [null]);
  });

  it('pairs are null when the matrices are missing', async () => {
    const cf = (await run({ country: ['GB'], counterpart: 'US' }, fixture(), null)).data['capital-flows'];
    assert.deepEqual(cf.pairs, [null]);
  });

  it('counterpart needs a country', async () => {
    await assert.rejects(() => run({ counterpart: 'GB' }), (err) => err.violations?.some((v) => v.field === 'counterpart'));
  });

  it('returns null for a valid country with no data', async () => {
    const cf = (await run({ country: ['FR'] })).data['capital-flows'];
    assert.equal(cf.countries.FR, null);
  });

  it('treats a negative limit as the default, not as no cap', async () => {
    const base = fixture();
    const countries = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`A${String.fromCharCode(65 + (i % 26))}${i}`, base.countries.GB]));
    const cf = (await run({ limit: -5 }, { ...base, countries })).data['capital-flows'];
    assert.equal(cf.ranking.length, 30);
  });

  it('rejects an unknown sort and more than 10 countries', async () => {
    const violation = (field, text) => (err) => err.violations?.some((v) => v.field === field && v.description.includes(text));
    await assert.rejects(() => run({ sort: 'gdp' }), violation('sort', 'outflow_z'));
    await assert.rejects(() => run({ country: ['GB', 'US', 'FR', 'DE', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT', 'SE'] }), violation('country', 'at most 10'));
  });

  it('stays within the output budget for a full ranking of ~230 countries', async () => {
    const base = fixture();
    const template = base.countries.GB;
    const codes = Object.values(ISO3_TO_ISO2).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 230);
    assert.equal(codes.length, 230);
    const countries = Object.fromEntries(codes.map((iso2) => [iso2, { ...structuredClone(template), iso2 }]));
    const result = await run({ limit: 0 }, { ...base, countries });
    assert.equal(result.data['capital-flows'].ranking.length, 230);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < tool._outputBudgetBytes);
  });

  it('rankingRow tolerates missing views', () => {
    assert.deepEqual(rankingRow('ZZ', {}), {
      country: 'ZZ', frequency: null, latestPeriod: null, inflowState: null, outflowState: null, inflowZ: null, outflowZ: null,
      inflowsUsdBn: null, outflowsUsdBn: null, netUsdBn: null, inflowsPctGdp: null, outflowsPctGdp: null,
      bankDepositsAbroadFlow4qUsdBn: null, foreignPortfolioChangePct: null,
    });
  });
});
