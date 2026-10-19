import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getCapitalFlows } from '../server/worldmonitor/economic/v1/get-capital-flows';
import { buildCapitalFlowPair, buildCapitalFlowsResponse, CAPITAL_FLOWS_KEY, CAPITAL_FLOWS_PAIRS_KEY } from '../server/worldmonitor/economic/v1/capital-flows';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalLocalApiMode = process.env.LOCAL_API_MODE;

// Seeded shape from scripts/seed-capital-flows.mjs (trimmed).
const SEED = {
  countries: {
    AE: {
      iso2: 'AE', iso3: 'ARE', gdpUsdBn: 552.32, gdpYear: 2024,
      bop: {
        frequency: 'annual', latestPeriod: '2025', state: null, episodes: null,
        latestYear: { inflowsUsdBn: 140.57, outflowsUsdBn: 196.66, netUsdBn: -56.09, inflowsYoyPct: 12.72, outflowsYoyPct: 12.22, inflowsPctGdp: 25.45, outflowsPctGdp: 35.61 },
        series: [{ period: '2025', inflows: { fdi: 48.24, portfolio: 21.56, other: 70.77, total: 140.57 }, outflows: { fdi: 63.35, portfolio: 47.73, other: 85.58, total: 196.66 }, errorsOmissions: 20.31 }],
      },
      bank: {
        latestPeriod: '2026-Q1',
        nonBankDepositsAbroad: { stockUsdBn: 193.2, flow4qUsdBn: 22.3 },
        householdDepositsAbroad: { stockUsdBn: 80.4, flow4qUsdBn: 6.8 },
        nonBankBorrowingFromAbroad: { stockUsdBn: 120, flow4qUsdBn: null },
        topBankLocations: [{ iso2: 'GB', stockUsdBn: 44.8, flow4qUsdBn: 5.9 }],
        publishesBilateral: false,
        topDepositorOrigins: [],
      },
      portfolio: { year: 2025, foreignHoldingsUsdBn: 201.5, foreignHoldingsPrevYearUsdBn: 171.9, changePct: 17.22, reporterCount: 70, topHolders: [{ iso2: 'US', usdBn: 51.1 }], holdingsAbroadUsdBn: null, topDestinations: [] },
    },
    GB: {
      iso2: 'GB', iso3: 'GBR', gdpUsdBn: 4002.59, gdpYear: 2025,
      bop: {
        frequency: 'quarterly', latestPeriod: '2026-Q2',
        state: { inflow: null, outflow: 'flight', inflowZ: 0.92, outflowZ: 2.4, basis: 'derived' },
        episodes: { surge: [{ start: '2016-Q2', end: '2017-Q1', quarters: 4, peakZ: 2.06, peakPeriod: '2016-Q3' }], stop: [], flight: [], retrenchment: [] },
        trailing4q: { inflowsUsdBn: 972.32, outflowsUsdBn: 887.77, netUsdBn: 84.55, inflowsPctGdp: 24.29, outflowsPctGdp: 22.18 },
        series: [{ period: '2026-Q2', inflows: { fdi: 1, portfolio: 52, other: 10, total: 63 }, outflows: { fdi: 2, portfolio: 30, other: 22, total: 54 }, errorsOmissions: -6.86 }],
      },
      bank: null,
      portfolio: null,
    },
  },
  latest: { bopQuarter: '2026-Q2', bopNewestQuarter: '2026-Q2', bopYear: '2025', bisQuarter: '2026-Q1', pipYear: 2025 },
  sources: ['https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/BOP'],
  method: { caveat: 'A person changing country of residence is not a BOP transaction.' },
  seededAt: '2026-10-18T19:00:00.000Z',
};

// Pair matrices from the seeder (trimmed). FR banks report; SG banks do not
// publish a bilateral breakdown. SG reports holdings but does not itemize FR.
const PAIRS = {
  bank: { period: '2026-Q1', reporters: ['FR', 'GB'], byReporter: { FR: { SG: [7.15, 1.35, 13.95, -1.49] }, GB: { FR: [900, 10, 1200, 5] } } },
  portfolio: { year: 2025, holders: ['FR', 'SG'], byHolder: { FR: { SG: [4.4, 2.81] }, SG: { US: [924.67, 759.67] } } },
  // FDI: both sides report SG-FR; SG reports only inward from FR.
  fdi: { year: 2024, reporters: ['FR', 'SG'], byReporter: { FR: { SG: [12, 30] }, SG: { FR: [33] } } },
  seededAt: '2026-10-18T19:00:00.000Z',
};

describe('buildCapitalFlowPair', () => {
  it('returns both directions with a status per leg', () => {
    const pair = buildCapitalFlowPair(PAIRS, 'sg', 'FR');
    assert.equal(pair?.country, 'SG');
    assert.equal(pair?.counterpart, 'FR');
    assert.equal(pair?.bankPeriod, '2026-Q1');
    assert.equal(pair?.portfolioYear, 2025);
    // SG non-banks' deposits sit in FR banks, which publish.
    assert.deepEqual(pair?.aDepositsInB, { status: 'reported', stockUsdBn: 7.15, flow4qUsdBn: 1.35, basis: '', history: [], instrument: 'loans_deposits' });
    assert.deepEqual(pair?.aBorrowingFromB, { status: 'reported', stockUsdBn: 13.95, flow4qUsdBn: -1.49, basis: '', history: [], instrument: 'loans_deposits' });
    // FR non-banks' deposits in SG banks: SG banks publish no bilateral data.
    assert.equal(pair?.bDepositsInA?.status, 'not_published');
    assert.equal(pair?.bBorrowingFromA?.status, 'not_published');
    // SG reports holdings, but not of FR; FR reports its SG holdings.
    assert.equal(pair?.aHoldingsOfB?.status, 'not_itemized');
    assert.deepEqual(pair?.bHoldingsOfA, { status: 'reported', stockUsdBn: 4.4, prevYearUsdBn: 2.81, basis: '', history: [], instrument: '' });
    // SG's FDI in FR: SG reports no outward figure, FR reports 12 inward → host basis.
    assert.deepEqual(pair?.aFdiInB, { status: 'reported', stockUsdBn: 12, basis: 'host', counterpartReportUsdBn: undefined, history: [], instrument: '' });
    // FR's FDI in SG: FR reports 30 outward, SG reports 33 inward → both kept.
    assert.deepEqual(pair?.bFdiInA, { status: 'reported', stockUsdBn: 30, basis: 'investor', counterpartReportUsdBn: 33, history: [], instrument: '' });
    assert.equal(pair?.fdiYear, 2024);
  });

  it('maps quarterly bank history from aligned flows, skipping gaps', () => {
    const raw = { bank: { period: '2026-Q1', quarters: ['2025-Q4', '2026-Q1'], reporters: ['US'], byReporter: { US: { CH: [19.35, 2.02, 6.2, -0.89, [1.88, null], null] } } } };
    const pair = buildCapitalFlowPair(raw, 'CH', 'US');
    assert.deepEqual(pair?.aDepositsInB?.history, [{ period: '2025-Q4', usdBn: 1.88 }]);
    assert.deepEqual(pair?.aBorrowingFromB?.history, []);
    assert.equal(pair?.aFdiInB?.status, 'not_published', 'no FDI matrix');
  });

  it('a stale bank leg is not_itemized but keeps the quarters it reported', () => {
    const raw = { bank: { period: '2026-Q1', quarters: ['2025-Q4', '2026-Q1'], reporters: ['US'], byReporter: { US: { CH: [null, null, null, null, [1.5, null], null] } } } };
    const leg = buildCapitalFlowPair(raw, 'CH', 'US')?.aDepositsInB;
    assert.equal(leg?.status, 'not_itemized');
    assert.deepEqual(leg?.history, [{ period: '2025-Q4', usdBn: 1.5 }]);
  });

  it('labels bank legs from an all-instruments reporter', () => {
    const raw = { bank: { period: '2026-Q1', quarters: [], reporters: ['JP'], allInstrumentReporters: ['JP'], byReporter: { JP: { CH: [3, 0.1, 4, 0.2] } } } };
    assert.equal(buildCapitalFlowPair(raw, 'CH', 'JP')?.aDepositsInB?.instrument, 'all_instruments');
  });

  it('is undefined without a pairs payload', () => {
    assert.equal(buildCapitalFlowPair(null, 'FR', 'SG'), undefined);
    assert.equal(buildCapitalFlowPair({ seededAt: 'x' }, 'FR', 'SG'), undefined);
  });

  it('buildCapitalFlowsResponse returns both countries and the pair for a pair query', () => {
    const res = buildCapitalFlowsResponse(SEED, 'AE', false, { counterpart: 'gb', pairsRaw: PAIRS });
    assert.deepEqual(res.countries.map((c) => c.country), ['AE', 'GB']);
    assert.equal(res.pair?.country, 'AE');
    assert.equal(res.pair?.counterpart, 'GB');
    assert.equal(res.pair?.aDepositsInB?.status, 'not_itemized', 'GB banks publish but do not itemize AE here');
    assert.equal(buildCapitalFlowsResponse(SEED, 'AE', false).pair, undefined);
    assert.equal(buildCapitalFlowsResponse(SEED, 'AE', false, { counterpart: 'ae', pairsRaw: PAIRS }).pair, undefined, 'no self-pair');
    assert.equal(buildCapitalFlowsResponse(SEED, 'AE', false, { counterpart: 'GB', pairsRaw: { ...PAIRS, seededAt: '2026-10-11T00:00:00.000Z' } }).pair, undefined, 'pairs from another seed run');
  });
});

describe('buildCapitalFlowsResponse', () => {
  it('maps every view and omits series by default', () => {
    const res = buildCapitalFlowsResponse(SEED, '', false);
    assert.equal(res.unavailable, false);
    assert.deepEqual(res.countries.map((c) => c.country), ['AE', 'GB']);
    const ae = res.countries[0];
    assert.equal(ae.bop?.frequency, 'annual');
    assert.equal(ae.bop?.state, undefined);
    assert.equal(ae.bop?.totals?.inflowsYoyPct, 12.72);
    assert.deepEqual(ae.bop?.series, []);
    assert.equal(ae.bank?.nonBankDepositsAbroad?.stockUsdBn, 193.2);
    assert.equal(ae.bank?.nonBankBorrowingFromAbroad?.flow4qUsdBn, undefined, 'null becomes absent');
    assert.deepEqual(ae.bank?.topBankLocations, [{ country: 'GB', stockUsdBn: 44.8, flow4qUsdBn: 5.9 }]);
    assert.deepEqual(ae.portfolio?.topHolders, [{ country: 'US', stockUsdBn: 51.1, flow4qUsdBn: undefined }]);
    const gb = res.countries[1];
    assert.equal(gb.bop?.state?.outflow, 'flight');
    assert.equal(gb.bop?.state?.inflow, '');
    assert.equal(gb.bop?.totals?.netUsdBn, 84.55);
    assert.equal(gb.bop?.episodes?.surge[0]?.peakZ, 2.06);
    assert.equal(gb.bank, undefined);
    assert.equal(res.latest?.bisQuarter, '2026-Q1');
    assert.equal(res.method.caveat.includes('residence'), true);
  });

  it('narrows to one country, case-insensitive, and includes series on request', () => {
    const res = buildCapitalFlowsResponse(SEED, 'gb', true);
    assert.deepEqual(res.countries.map((c) => c.country), ['GB']);
    assert.equal(res.countries[0].bop?.series.length, 1);
    assert.equal(res.countries[0].bop?.series[0]?.errorsOmissions, -6.86);
  });

  it('returns an empty list, not unavailable, for an unknown country', () => {
    const res = buildCapitalFlowsResponse(SEED, 'ZZ', false);
    assert.equal(res.unavailable, false);
    assert.deepEqual(res.countries, []);
  });

  it('is unavailable for a missing or malformed payload', () => {
    assert.equal(buildCapitalFlowsResponse(null, '', false).unavailable, true);
    assert.equal(buildCapitalFlowsResponse({ countries: [] }, '', false).unavailable, true);
  });
});

describe('getCapitalFlows handler', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    if (originalLocalApiMode === undefined) delete process.env.LOCAL_API_MODE; else process.env.LOCAL_API_MODE = originalLocalApiMode;
  });

  it('reads the unprefixed seed key and unwraps the runSeed envelope', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      const envelope = { _seed: { fetchedAt: Date.now(), recordCount: 2, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data: SEED };
      return new Response(JSON.stringify({ result: JSON.stringify(envelope) }));
    }) as typeof fetch;
    const res = await getCapitalFlows({} as never, { country: 'AE', includeSeries: false, counterpart: '' });
    assert.equal(res.unavailable, false);
    assert.deepEqual(res.countries.map((c) => c.country), ['AE']);
    assert.ok(seen.some((u) => u.includes(encodeURIComponent(CAPITAL_FLOWS_KEY)) || u.includes(CAPITAL_FLOWS_KEY)), `expected a read of ${CAPITAL_FLOWS_KEY}, saw ${seen.join(', ')}`);
  });

  it('reads both keys in one pipeline for a pair query', async () => {
    const envelope = (data: unknown) => JSON.stringify({ _seed: { fetchedAt: Date.now(), recordCount: 2, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data });
    let pipelined: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.match(String(url), /\/pipeline$/);
      const commands = JSON.parse(String(init?.body)) as string[][];
      pipelined = commands.map(([, key]) => key);
      const values: Record<string, unknown> = { [CAPITAL_FLOWS_KEY]: SEED, [CAPITAL_FLOWS_PAIRS_KEY]: PAIRS };
      return new Response(JSON.stringify(commands.map(([, key]) => ({ result: values[key] == null ? null : envelope(values[key]) }))));
    }) as typeof fetch;
    const res = await getCapitalFlows({} as never, { country: 'GB', includeSeries: false, counterpart: 'AE' });
    assert.deepEqual(pipelined.sort(), [CAPITAL_FLOWS_PAIRS_KEY, CAPITAL_FLOWS_KEY].sort());
    assert.equal(res.unavailable, false);
    assert.equal(res.pair?.country, 'GB');
    assert.equal(res.pair?.bDepositsInA?.status, 'not_itemized');
  });

  it('degrades to unavailable when Redis has nothing', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: null }))) as typeof fetch;
    const res = await getCapitalFlows({} as never, { country: '', includeSeries: false, counterpart: '' });
    assert.equal(res.unavailable, true);
    assert.deepEqual(res.countries, []);
  });
});
