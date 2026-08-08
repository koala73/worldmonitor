// Executable coverage for the WTO trade-flow contract (issue #6309).
//
// The defect these tests lock down: the seeded cache key carried the requested
// lookback (`…:${years}`) but was only ever written at years=10, so every other
// supported window built a key nothing had written and the handler answered
// `upstreamUnavailable: true` — reporting a fault for a request the contract
// accepted. The same response also stood in for "this pair was never seeded",
// which no retry can fix.
//
// Everything below drives the REAL exported functions — the handler through a
// mocked Upstash REST endpoint, the seeder through a mocked WTO endpoint — so a
// refactor that changes the key shape, the slice arithmetic, or the publish
// gate reddens here rather than passing a source-text grep.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COVERAGE_KEY,
  DEFAULT_REPORTING_COUNTRY,
  DEFAULT_YEARS,
  MAX_YEARS,
  WORLD_PARTNER_CODE,
  getTradeFlows,
  normalizeTradeFlowRequest,
  sliceFlowsToWindow,
  tradeFlowSeedKey,
  TRADE_FLOW_REASON as R,
} from '../server/worldmonitor/trade/v1/get-trade-flows';
import { validateGeneratedRequest } from '../server/request-validator';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation';
import {
  _setAllReportersForTesting,
  _setReporterListIsFallbackForTesting,
  fetchTradeFlows,
  TRADE_FLOW_COVERAGE_KEY,
  TRADE_FLOW_KEY_PREFIX,
  TRADE_FLOW_SEED_YEARS,
  TRADE_FLOW_EMPTY_STREAK_TO_DROP,
  WORLD_PARTNER_CODE as SEED_WORLD_PARTNER_CODE,
  buildFlowRecords,
  fetchFlowPair,
  publishTradeFlows,
  tradeFlowCoverageId,
  tradeFlowPairUniverse,
  tradeFlowSeedKey as seedTradeFlowSeedKey,
} from '../scripts/seed-supply-chain-trade.mjs';

import type {
  GetTradeFlowsRequest,
  GetTradeFlowsResponse,
  ServerContext,
  TradeFlowRecord,
} from '../src/generated/server/worldmonitor/trade/v1/service_server';

// ── Harness ────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  localApiMode: process.env.LOCAL_API_MODE,
  wtoKey: process.env.WTO_API_KEY,
};
const REDIS_HOST = 'https://redis.test';

/** Keys the mocked Upstash returns, and keys whose read blows up. */
let redisStore: Map<string, unknown>;
let redisErrors: Set<string>;
let redisReads: string[];

function keyFromUpstashUrl(href: string): string {
  return decodeURIComponent(href.slice(`${REDIS_HOST}/get/`.length));
}

beforeEach(() => {
  redisStore = new Map();
  redisErrors = new Set();
  redisReads = [];
  // Set explicitly rather than inherited: `readCachedJson` reports `miss` when
  // the credentials are absent, so a shell without them would turn every
  // error-path assertion below into a vacuous pass.
  process.env.UPSTASH_REDIS_REST_URL = REDIS_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.LOCAL_API_MODE;
  process.env.WTO_API_KEY = 'test-wto-key';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = String(input);
    if (href.startsWith(`${REDIS_HOST}/get/`)) {
      const key = keyFromUpstashUrl(href);
      redisReads.push(key);
      if (redisErrors.has(key)) return new Response('boom', { status: 500 });
      const value = redisStore.get(key);
      return new Response(
        JSON.stringify({ result: value === undefined ? null : JSON.stringify(value) }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
    ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
    ['LOCAL_API_MODE', ORIGINAL_ENV.localApiMode],
    ['WTO_API_KEY', ORIGINAL_ENV.wtoKey],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const CTX = {} as ServerContext;

function request(partial: Partial<GetTradeFlowsRequest> = {}): GetTradeFlowsRequest {
  // Mirrors what the generated GET route builds from query params: absent
  // strings arrive as '' and an absent `years` as 0.
  return { reportingCountry: '', partnerCountry: '', years: 0, ...partial };
}

function flowRecord(year: number, exportValueUsd = 100, importValueUsd = 200): TradeFlowRecord {
  return {
    reportingCountry: 'United States of America',
    partnerCountry: 'World',
    year,
    exportValueUsd,
    importValueUsd,
    yoyExportChange: 0,
    yoyImportChange: 0,
    productSector: 'Total merchandise',
  };
}

/** A seeded payload shaped exactly as the seeder writes it. */
function seededPayload(startYear: number, endYear: number): GetTradeFlowsResponse {
  const flows: TradeFlowRecord[] = [];
  for (let year = startYear; year <= endYear; year += 1) flows.push(flowRecord(year));
  return {
    flows,
    fetchedAt: '2026-08-07T00:00:00.000Z',
    upstreamUnavailable: false,
    unavailableReason: R.served,
    coverageStartYear: startYear,
    coverageEndYear: endYear,
  };
}

function seedUsWorld(startYear = 1996, endYear = 2025): void {
  redisStore.set(tradeFlowSeedKey('840', '000'), seededPayload(startYear, endYear));
}

function seedManifest(pairs: string[]): void {
  redisStore.set(COVERAGE_KEY, { pairs, startYear: 1996, endYear: 2026, fetchedAt: '2026-08-07T00:00:00.000Z' });
}

/**
 * Every miss reads exactly the pair key then the manifest — nothing else.
 *
 * Applied to EACH miss verdict, not just one. The #6309 cutover bridge sat on
 * the `coverage_unknown` arm, so pinning only that arm would let the same
 * fallback be reintroduced on `seed_missing` ("the pair is covered but its key
 * is gone — try the old key before declaring a fault") with the suite green.
 * Verified: that exact reintroduction passed 60/60 before this helper existed.
 *
 * The two reads are sequential awaits (handler, then classifyMiss), so the
 * order is deterministic and this cannot flake. If they are ever parallelised
 * this reddens — which is the right moment to look.
 */
function assertTwoReads(reporter: string, partner: string): void {
  assert.deepEqual(redisReads, [tradeFlowSeedKey(reporter, partner), COVERAGE_KEY],
    'a miss must read the pair key and the manifest, and nothing else');
}

// ── Contract pins: the two sides must agree without importing each other ───

describe('seeder and handler agree on the cache contract', () => {
  test('the seeded window equals the contract maximum lookback', () => {
    assert.equal(TRADE_FLOW_SEED_YEARS, MAX_YEARS);
    // The runtime rule the gateway actually enforces, not the proto text.
    const rule = (GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { numberLte?: number; numberGte?: number; stringPattern?: string }> }>)['worldmonitor.trade.v1.GetTradeFlowsRequest'];
    assert.equal(rule.fields.years.numberLte, MAX_YEARS,
      'a seeded window shorter than the accepted maximum silently truncates the widest request');
    assert.equal(rule.fields.years.numberGte, 0);
  });

  test('the gateway pattern and the handler guard accept the same codes', () => {
    // Two independent guards keep user input out of the `trade:flows:v2:` key
    // namespace. Pinning only the gateway's would let the handler's drift wider
    // on any path that reaches it without the generated validator.
    const rule = (GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { stringPattern?: string }> }>)['worldmonitor.trade.v1.GetTradeFlowsRequest'];
    assert.equal(rule.fields.reportingCountry.stringPattern, '^([0-9]{3})?$');
    assert.equal(rule.fields.partnerCountry.stringPattern, '^([0-9]{3})?$');

    const gateway = new RegExp(rule.fields.reportingCountry.stringPattern as string);
    for (const candidate of [
      '840', '000', '004', '', ' 840 ', '84', '8400', 'XX', '84a', '840:evil',
      '840\n', '\n840', '840\r', '٨٤٠', '0x840', '-840', '８４０', '840 ',
    ]) {
      // The handler trims first, so compare against what it actually tests.
      const handlerAccepts = normalizeTradeFlowRequest(
        request({ reportingCountry: candidate }),
      ) !== null;
      const gatewayAccepts = gateway.test(candidate.trim());
      assert.equal(handlerAccepts, gatewayAccepts,
        `guards disagree on ${JSON.stringify(candidate)}`);
    }
  });

  test('both sides build the same key for the same pair', () => {
    for (const [reporter, partner] of [['840', '000'], ['156', '000'], ['004', '840']]) {
      assert.equal(seedTradeFlowSeedKey(reporter, partner), tradeFlowSeedKey(reporter, partner));
    }
  });

  test('both sides name the same coverage manifest and prefix', () => {
    assert.equal(TRADE_FLOW_COVERAGE_KEY, COVERAGE_KEY);
    assert.equal(COVERAGE_KEY, `${TRADE_FLOW_KEY_PREFIX}:index`);
    assert.equal(SEED_WORLD_PARTNER_CODE, WORLD_PARTNER_CODE);
  });

  test('the key no longer carries the requested lookback', () => {
    // The whole defect in one assertion: two different windows must resolve to
    // the same seeded key, or only the seeded window is ever answerable.
    assert.equal(tradeFlowSeedKey('840', '000'), 'trade:flows:v2:840:000');
  });
});

// ── Serving a seeded pair ─────────────────────────────────────────────────

describe('seeded reporter-versus-World requests', () => {
  test('the default request serves the last 10 years inclusive of both endpoints', async () => {
    seedUsWorld(1996, 2025);
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.served);
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.coverageStartYear, 2015);
    assert.equal(res.coverageEndYear, 2025);
    assert.equal(res.flows.length, 11, 'years=10 is a lookback, so it spans 11 calendar years');
  });

  test('every supported window is answerable from the one seeded key', async () => {
    // Seeded window is deliberately WIDER than the maximum lookback (32 calendar
    // years for a max of 30). With a 30-year fixture, years=30 would return the
    // whole seed either way and an implementation that dropped one endpoint at
    // the boundary would still pass — the fixture would be satisfying the
    // assertion through a second path.
    seedUsWorld(1994, 2025);
    for (const [years, expected] of [[1, 2], [10, 11], [29, 30], [30, 31]] as const) {
      const res = await getTradeFlows(CTX, request({ years }));
      assert.equal(res.flows.length, expected,
        `years=${years} spans ${years} + 1 calendar years, inclusive of both endpoints`);
      assert.equal(res.unavailableReason, R.served, `years=${years} must not report a fault`);
      assert.equal(res.coverageEndYear, 2025, `years=${years}`);
      assert.equal(res.coverageStartYear, 2025 - years, `years=${years}`);
    }
  });

  test('years=1 returns the two most recent years, not the oldest', async () => {
    seedUsWorld(1996, 2025);
    const res = await getTradeFlows(CTX, request({ years: 1 }));
    assert.deepEqual(res.flows.map((f) => f.year), [2024, 2025]);
  });

  test('a window wider than the seed returns the whole seed rather than failing', async () => {
    seedUsWorld(2020, 2025);
    const res = await getTradeFlows(CTX, request({ years: 30 }));
    assert.equal(res.flows.length, 6);
    assert.equal(res.coverageStartYear, 2020);
    assert.equal(res.unavailableReason, R.served);
  });

  test('the served path reads exactly one key and never the manifest', async () => {
    seedUsWorld();
    seedManifest([tradeFlowCoverageId('840', '000')]);
    await getTradeFlows(CTX, request());

    assert.deepEqual(redisReads, [tradeFlowSeedKey('840', '000')],
      'the manifest is a miss-path diagnostic and must not tax the hot path');
  });

  test('fetchedAt reports when WTO was read, not when the request arrived', async () => {
    seedUsWorld();
    const res = await getTradeFlows(CTX, request());
    assert.equal(res.fetchedAt, '2026-08-07T00:00:00.000Z');
  });

  test('an explicit World partner resolves to the same key as an absent one', async () => {
    seedUsWorld();
    const explicit = await getTradeFlows(CTX, request({ reportingCountry: '840', partnerCountry: '000' }));
    assert.equal(explicit.flows.length, 11);
    assert.equal(explicit.unavailableReason, R.served);
  });
});

// ── Naming a miss ─────────────────────────────────────────────────────────

describe('a miss is attributed to a cause, not blamed on upstream', () => {
  test('a pair outside coverage is a contract answer, not an outage', async () => {
    seedManifest([tradeFlowCoverageId('840', '000')]);
    const res = await getTradeFlows(CTX, request({ reportingCountry: '840', partnerCountry: '156' }));

    assert.equal(res.unavailableReason, R.notCovered);
    assert.equal(res.upstreamUnavailable, false,
      'no retry fixes a combination WTO does not publish; calling it an outage invites one');
    assert.deepEqual(res.flows, []);
    assert.equal(res.fetchedAt, '', 'nothing was fetched, so there is no fetch time to report');
    assert.equal(res.coverageStartYear, 0);
    assert.equal(res.coverageEndYear, 0);
    assertTwoReads('840', '156');
  });

  test('a covered pair whose key is gone is a fault', async () => {
    seedManifest([tradeFlowCoverageId('840', '000'), tradeFlowCoverageId('156', '000')]);
    const res = await getTradeFlows(CTX, request({ reportingCountry: '156' }));

    assert.equal(res.unavailableReason, R.seedMissing);
    assert.equal(res.upstreamUnavailable, true);
    assertTwoReads('156', '000');
  });

  test('a failed read of the pair key is never reported as missing coverage', async () => {
    redisErrors.add(tradeFlowSeedKey('840', '000'));
    seedManifest([]);
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.cacheUnavailable);
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(redisReads, [tradeFlowSeedKey('840', '000')],
      'a cache fault is already conclusive; the manifest cannot refine it');
  });

  test('a failed read of the manifest is a fault, not a coverage verdict', async () => {
    redisErrors.add(COVERAGE_KEY);
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.cacheUnavailable);
    assert.equal(res.upstreamUnavailable, true);
  });

  test('an absent manifest cannot rule coverage in or out', async () => {
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.coverageUnknown);
    assert.equal(res.upstreamUnavailable, true,
      'losing the manifest and the data together is evidence the seeder stopped');
  });

  test('a malformed manifest is treated as unreadable rather than as empty coverage', async () => {
    // Each shape must reach coverage_unknown, not not_covered. The member-level
    // cases are the dangerous ones: they pass an Array.isArray check, match
    // nothing, and would answer `not_covered` — the one CDN-cacheable verdict —
    // for every request, presenting corruption as a legitimate answer.
    for (const pairs of ['not-an-array', [null], [{}], [123], ['840'], ['840:000:10'], ['84:000']]) {
      redisStore.set(COVERAGE_KEY, { pairs });
      const res = await getTradeFlows(CTX, request());
      assert.equal(res.unavailableReason, R.coverageUnknown, JSON.stringify(pairs));
      assert.equal(res.upstreamUnavailable, true, JSON.stringify(pairs));
    }
  });

  test('a miss reads only the pair key and the manifest', async () => {
    // The #6309 cutover bridge (removed in #6315) used to add a third read of
    // the old `trade:flows:v1:…` key on this path. Pin that no legacy key is
    // consulted, so the bridge cannot be reintroduced unnoticed.
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.coverageUnknown);
    assertTwoReads('840', '000');
  });

  test('a seeded key holding no rows still gets attributed', async () => {
    redisStore.set(tradeFlowSeedKey('840', '000'), { ...seededPayload(2020, 2025), flows: [] });
    seedManifest([tradeFlowCoverageId('840', '000')]);
    const res = await getTradeFlows(CTX, request());

    assert.equal(res.unavailableReason, R.seedMissing);
  });
});

// ── Request validation ────────────────────────────────────────────────────

describe('malformed input is rejected instead of silently defaulted', () => {
  test('a malformed reporter is not answered as the United States', async () => {
    seedUsWorld();
    const res = await getTradeFlows(CTX, request({ reportingCountry: 'XX' }));

    assert.equal(res.unavailableReason, R.invalidRequest);
    assert.deepEqual(res.flows, [], 'the old handler substituted 840 and answered about a country nobody asked for');
    assert.deepEqual(redisReads, [], 'a rejected request must not build a cache key at all');
  });

  test('a malformed partner is not answered as World', async () => {
    seedUsWorld();
    const res = await getTradeFlows(CTX, request({ partnerCountry: '15' }));

    assert.equal(res.unavailableReason, R.invalidRequest);
    assert.deepEqual(redisReads, []);
  });

  test('out-of-contract lookbacks are rejected', async () => {
    seedUsWorld();
    for (const years of [-1, 31, 1000, 10.5, Number.NaN]) {
      const res = await getTradeFlows(CTX, request({ years }));
      assert.equal(res.unavailableReason, R.invalidRequest, `years=${years}`);
    }
  });

  test('absent fields take the documented defaults', () => {
    const normalized = normalizeTradeFlowRequest(request());
    assert.deepEqual(normalized, {
      reporter: DEFAULT_REPORTING_COUNTRY,
      partner: WORLD_PARTNER_CODE,
      years: DEFAULT_YEARS,
    });
  });

  test('surrounding whitespace is normalized away', () => {
    assert.deepEqual(normalizeTradeFlowRequest(request({ reportingCountry: ' 840 ', partnerCountry: ' 000 ' })), {
      reporter: '840', partner: '000', years: DEFAULT_YEARS,
    });
  });

  test('the gateway rejects the same inputs with a 400 before the handler runs', () => {
    assert.equal(validateGeneratedRequest('getTradeFlows', { reportingCountry: '', partnerCountry: '', years: 0 }), undefined);
    assert.equal(validateGeneratedRequest('getTradeFlows', { reportingCountry: '840', partnerCountry: '000', years: 30 }), undefined);
    for (const body of [
      { reportingCountry: 'XX', partnerCountry: '', years: 0 },
      { reportingCountry: '', partnerCountry: '15', years: 0 },
      { reportingCountry: '', partnerCountry: '', years: 31 },
      { reportingCountry: '', partnerCountry: '', years: -1 },
      { reportingCountry: '', partnerCountry: '', years: Number.NaN },
    ]) {
      assert.ok(validateGeneratedRequest('getTradeFlows', body), `expected a violation for ${JSON.stringify(body)}`);
    }
  });
});

// ── Slice arithmetic ──────────────────────────────────────────────────────

describe('sliceFlowsToWindow', () => {
  test('an empty history slices to nothing', () => {
    assert.deepEqual(sliceFlowsToWindow([], 10), []);
  });

  test('the window is anchored to the newest seeded year, not to today', () => {
    // A seed that stopped advancing must still return its own last N years
    // rather than an empty window that reads as a fault.
    const flows = [2010, 2011, 2012].map((y) => flowRecord(y));
    assert.deepEqual(sliceFlowsToWindow(flows, 1).map((f) => f.year), [2011, 2012]);
  });

  test('output is ordered ascending regardless of stored order', () => {
    const flows = [2012, 2010, 2011].map((y) => flowRecord(y));
    assert.deepEqual(sliceFlowsToWindow(flows, 5).map((f) => f.year), [2010, 2011, 2012]);
  });
});

// ── Seeder: record construction ───────────────────────────────────────────

function exportRow(year: number, value: number) {
  return { year, indicator: 'ITS_MTV_AX', value, reporterName: 'United States of America', partnerName: '' };
}
function importRow(year: number, value: number) {
  return { year, indicator: 'ITS_MTV_AM', value, reporterName: 'United States of America', partnerName: '' };
}

describe('buildFlowRecords', () => {
  test('a year WTO answered on one side only is dropped, not zero-filled', () => {
    const { records, incompleteYears } = buildFlowRecords(
      [exportRow(2023, 100), importRow(2023, 200), exportRow(2024, 110)],
      '840', '000',
    );

    assert.deepEqual(records.map((r: TradeFlowRecord) => r.year), [2023]);
    assert.equal(incompleteYears, 1);
    assert.ok(!records.some((r: TradeFlowRecord) => r.importValueUsd === 0),
      'a fabricated 0 import is indistinguishable from trade collapsing to nothing');
  });

  test('year-over-year is computed between adjacent years', () => {
    const { records } = buildFlowRecords(
      [exportRow(2023, 100), importRow(2023, 200), exportRow(2024, 110), importRow(2024, 100)],
      '840', '000',
    );

    assert.equal(records[1].yoyExportChange, 10);
    assert.equal(records[1].yoyImportChange, -50);
  });

  test('year-over-year is not computed across a gap', () => {
    const { records } = buildFlowRecords(
      [exportRow(2020, 100), importRow(2020, 200), exportRow(2024, 400), importRow(2024, 800)],
      '840', '000',
    );

    assert.deepEqual(records.map((r: TradeFlowRecord) => r.year), [2020, 2024]);
    assert.equal(records[1].yoyExportChange, 0,
      'a four-year move labelled year-over-year overstates the change by construction');
    assert.equal(records[1].yoyImportChange, 0);
  });

  test('the World partner is named rather than left as a numeric code', () => {
    const { records } = buildFlowRecords([exportRow(2024, 1), importRow(2024, 2)], '840', '000');
    assert.equal(records[0].partnerCountry, 'World');
  });
});

// ── Seeder: fetch and publish gate ────────────────────────────────────────

type WtoStub = (indicator: string) => Response;

function stubWto(handler: WtoStub): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = String(input);
    if (!href.includes('api.wto.org')) throw new Error(`unexpected fetch to ${href}`);
    urls.push(href);
    return handler(new URL(href).searchParams.get('i') ?? '');
  }) as typeof fetch;
  return urls;
}

function wtoRows(indicator: string, years: number[]) {
  return new Response(JSON.stringify({
    Dataset: years.map((year) => ({
      Year: String(year),
      Value: indicator === 'ITS_MTV_AX' ? '100' : '200',
      ReportingEconomy: 'United States of America',
      PartnerEconomy: 'World',
    })),
  }), { status: 200 });
}

// Mirrors the shape fetchTradeFlows threads through the run. Kept explicit
// rather than defaulted inside fetchFlowPair so a drifted contract fails here
// instead of silently losing the ids the manifest is filtered by.
function freshStats() {
  return {
    pairsAttempted: 0, pairsSeeded: 0, upstreamFailures: 0,
    emptyPairs: 0, emptyPairIds: [] as string[], incompleteYearsDropped: 0,
  };
}

describe('fetchFlowPair', () => {
  const NOW = new Date('2026-08-07T00:00:00.000Z');

  test('a pair is published only when both indicators answered', async () => {
    const flows: Record<string, GetTradeFlowsResponse> = {};
    const stats = freshStats();
    stubWto((indicator) => indicator === 'ITS_MTV_AX'
      ? wtoRows(indicator, [2024, 2025])
      : new Response('upstream down', { status: 503 }));

    await fetchFlowPair('840', '000', flows, stats, NOW);

    assert.deepEqual(Object.keys(flows), [],
      'half a bilateral relationship must not be stored under a key served as complete');
    assert.equal(stats.upstreamFailures, 1);
    assert.equal(stats.pairsSeeded, 0);
  });

  test('a 204 on one indicator still blocks publication of the other', async () => {
    const flows: Record<string, GetTradeFlowsResponse> = {};
    const stats = freshStats();
    stubWto((indicator) => indicator === 'ITS_MTV_AX'
      ? wtoRows(indicator, [2024, 2025])
      : new Response(null, { status: 204 }));

    await fetchFlowPair('840', '000', flows, stats, NOW);

    // A 204 is a real answer, so this is not an upstream failure — but every
    // year is one-sided, so nothing survives the completeness guard.
    assert.deepEqual(Object.keys(flows), []);
    assert.equal(stats.upstreamFailures, 0);
    assert.equal(stats.emptyPairs, 1);
    assert.equal(stats.incompleteYearsDropped, 2);
  });

  test('a complete pair is published under the years-independent key', async () => {
    const flows: Record<string, GetTradeFlowsResponse> = {};
    const stats = freshStats();
    stubWto((indicator) => wtoRows(indicator, [2023, 2024, 2025]));

    await fetchFlowPair('840', '000', flows, stats, NOW);

    assert.deepEqual(Object.keys(flows), ['trade:flows:v2:840:000']);
    const payload = flows['trade:flows:v2:840:000'];
    assert.equal(payload.flows.length, 3);
    assert.equal(payload.upstreamUnavailable, false);
    assert.equal(payload.unavailableReason, R.served);
    assert.equal(payload.coverageStartYear, 2023);
    assert.equal(payload.coverageEndYear, 2025);
    assert.equal(stats.pairsSeeded, 1);
  });

  test('the request asks WTO for the full contract window', async () => {
    const urls = stubWto((indicator) => wtoRows(indicator, [2025]));
    await fetchFlowPair('840', '000', {}, freshStats(), NOW);

    const params = new URL(urls[0]).searchParams;
    assert.equal(params.get('ps'), `${2026 - TRADE_FLOW_SEED_YEARS}-2026`);
    assert.equal(params.get('r'), '840');
    assert.equal(params.get('p'), '000');
    assert.equal(urls.length, 2, 'exports and imports, one request each');
  });

  test('rows outside the requested window are discarded', async () => {
    const flows: Record<string, GetTradeFlowsResponse> = {};
    stubWto((indicator) => wtoRows(indicator, [1900, 2025]));

    await fetchFlowPair('840', '000', flows, freshStats(), NOW);

    assert.deepEqual(flows['trade:flows:v2:840:000'].flows.map((f) => f.year), [2025],
      'a row outside ps would be stored and then served as if it were inside the advertised window');
  });
});

// ── The published 200 example ─────────────────────────────────────────────

describe('the published success example depicts a response the handler can emit', () => {
  // The generated example paired flow rows with INVALID_REQUEST and partner
  // '156' — a state the handler cannot produce, documenting bilateral coverage
  // the product does not claim. The repo-wide examples contract does NOT catch
  // this: it only bans `_UNSPECIFIED` sentinels, and INVALID_REQUEST is not one,
  // so the incoherent example passed it cleanly. Pin the coherence here.
  const spec = JSON.parse(readFileSync(
    resolve(import.meta.dirname, '..', 'docs/api/TradeService.openapi.json'),
    'utf8',
  )) as {
    paths: Record<string, Record<string, {
      responses: Record<string, { content: Record<string, { example?: Record<string, unknown> }> }>;
    }>>;
  };

  const example = () =>
    spec.paths['/api/trade/v1/get-trade-flows'].get.responses['200'].content['application/json'].example ?? {};

  test('rows are never shown alongside a reason that denies them', () => {
    const ex = example();
    const flows = ex.flows as unknown[] | undefined;
    assert.ok(Array.isArray(flows) && flows.length > 0, 'a 200 example should show rows');
    const reason = ex.unavailableReason;
    assert.ok(
      reason === undefined || reason === R.served,
      `a served example cannot carry ${JSON.stringify(reason)} — the handler only sets a `
      + 'non-UNSPECIFIED reason when flows is empty',
    );
  });

  test('the example does not advertise a partner upstream cannot answer', () => {
    const flows = example().flows as Record<string, unknown>[];
    assert.equal(flows[0].partnerCountry, WORLD_PARTNER_CODE,
      'ITS_MTV_AX/ITS_MTV_AM answer 204 for every named partner; only World is obtainable');
  });
});

// ── The dashboard call site ───────────────────────────────────────────────

describe('the dashboard asks for a combination the seed can answer', () => {
  // The production symptom of #6309 was this one call: the flows tab requested
  // partner '156' (China), which the WTO indicators behind this RPC answer 204
  // for, so the panel rendered the upstream-unavailable banner on every load.
  // The handler and seeder suites above would all stay green if it came back.
  //
  // Static pin rather than a runtime one: importing data-loader.ts pulls the
  // whole app graph under tsx. It parses the real argument list instead of
  // grepping for a substring, so a changed partner reddens rather than matching
  // some other occurrence of the same digits.
  const dataLoader = readFileSync(
    resolve(import.meta.dirname, '..', 'src/app/data-loader.ts'),
    'utf8',
  );

  const calls = [...dataLoader.matchAll(/fetchTradeFlows\(([^)]*)\)/g)]
    .map((m) => m[1].split(',').map((a) => a.trim()));

  test('there is exactly one call, and it asks for World', () => {
    assert.equal(calls.length, 1, `expected one fetchTradeFlows call, found ${calls.length}`);
    assert.deepEqual(calls[0], ["'840'", "'000'", '10'],
      'the flows tab must request partner 000 (World) — 156 is unanswerable upstream');
  });

  test('no call site requests a partner WTO cannot answer', () => {
    for (const args of calls) {
      assert.notEqual(args[1], "'156'",
        'partner 156 returns HTTP 204 from ITS_MTV_AX/ITS_MTV_AM; it can never be seeded');
    }
  });
});

// ── Seeder: the whole run ─────────────────────────────────────────────────

describe('fetchTradeFlows composes the loop, the counters, and the manifest', () => {
  test('a run reports what it seeded and advertises what it attempted', async () => {
    // Two reporters: one WTO answers, one it fails. The manifest must still
    // advertise both — coverage is intent, so the failed reporter reads as a
    // fault on the next request rather than as a combination never offered.
    _setAllReportersForTesting(['840', '156']);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (!href.includes('api.wto.org')) throw new Error(`unexpected fetch to ${href}`);
      const params = new URL(href).searchParams;
      if (params.get('r') === '156') return new Response('upstream down', { status: 503 });
      return wtoRows(params.get('i') ?? '', [2024, 2025]);
    }) as typeof fetch;

    const run = await fetchTradeFlows();

    assert.deepEqual(Object.keys(run.flows), [tradeFlowSeedKey('840', '000')]);
    assert.equal(run.coverage.pairsAttempted, 2);
    assert.equal(run.coverage.pairsSeeded, 1);
    assert.equal(run.coverage.upstreamFailures, 1);
    assert.deepEqual(run.manifest.pairs, ['156:000', '840:000'],
      'a pair a WTO failure dropped this run must stay advertised');
    assert.equal(run.manifest.endYear - run.manifest.startYear, TRADE_FLOW_SEED_YEARS);
  });

  test('a single empty answer does NOT make a pair cacheable-not-covered', async () => {
    // `not_covered` leaves upstreamUnavailable false, and this route is on the
    // `daily` tier (CDN-Cache-Control s-maxage=86400), so a verdict reached on
    // one transient 204 could outlive the 6h seed cadence by 4x. Until the
    // emptiness persists, the pair stays advertised and reads `seed_missing`,
    // which is no-store and self-corrects next run.
    _setAllReportersForTesting(['840', '156']);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.startsWith(REDIS_HOST)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      const params = new URL(href).searchParams;
      if (params.get('r') === '156') return new Response(null, { status: 204 });
      return wtoRows(params.get('i') ?? '', [2024, 2025]);
    }) as typeof fetch;

    const run = await fetchTradeFlows();

    assert.equal(run.coverage.emptyPairs, 1);
    assert.ok(run.manifest.pairs.includes('156:000'),
      'first empty run must keep the pair advertised so the miss reads as a fault');
    assert.equal(run.manifest.emptyStreaks['156:000'], 1);
  });

  test('a pair is dropped only once the emptiness has persisted', async () => {
    // Same run, but the previous manifest already recorded the pair one short of
    // the threshold. This is the state that makes the drop legitimate.
    _setAllReportersForTesting(['840', '156']);
    const priorManifest = {
      pairs: ['156:000', '840:000'],
      emptyStreaks: { '156:000': TRADE_FLOW_EMPTY_STREAK_TO_DROP - 1 },
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.startsWith(REDIS_HOST)) {
        return new Response(JSON.stringify({ result: JSON.stringify(priorManifest) }), { status: 200 });
      }
      const params = new URL(href).searchParams;
      if (params.get('r') === '156') return new Response(null, { status: 204 });
      return wtoRows(params.get('i') ?? '', [2024, 2025]);
    }) as typeof fetch;

    const run = await fetchTradeFlows();

    assert.ok(!run.manifest.pairs.includes('156:000'),
      `dropped after ${TRADE_FLOW_EMPTY_STREAK_TO_DROP} consecutive empty runs`);
    assert.equal(run.manifest.emptyStreaks['156:000'], TRADE_FLOW_EMPTY_STREAK_TO_DROP);
  });

  test('a pair that produces data resets its streak', async () => {
    _setAllReportersForTesting(['156']);
    const priorManifest = { pairs: [], emptyStreaks: { '156:000': 2 } };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.startsWith(REDIS_HOST)) {
        return new Response(JSON.stringify({ result: JSON.stringify(priorManifest) }), { status: 200 });
      }
      return wtoRows(new URL(href).searchParams.get('i') ?? '', [2025]);
    }) as typeof fetch;

    const run = await fetchTradeFlows();

    assert.deepEqual(run.manifest.pairs, ['156:000'], 'a producing pair is advertised again');
    assert.equal(run.manifest.emptyStreaks['156:000'], undefined,
      'the streak resets by omission rather than accumulating forever');
  });

  test('an empty answer is classified as an answer, not an upstream failure', async () => {
    // The classification is what the streak logic keys on: a 204 counts toward
    // emptyPairs (eventually `not_covered`), while a failed request counts
    // toward upstreamFailures (always `seed_missing`). Confusing the two would
    // either strand a live reporter or hide a real outage.
    _setAllReportersForTesting(['840', '156']);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.startsWith(REDIS_HOST)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      const params = new URL(href).searchParams;
      if (params.get('r') === '156') return new Response(null, { status: 204 });
      return wtoRows(params.get('i') ?? '', [2024, 2025]);
    }) as typeof fetch;

    const run = await fetchTradeFlows();

    assert.equal(run.coverage.emptyPairs, 1);
    assert.equal(run.coverage.upstreamFailures, 0, 'a 204 is an answer, not a failure');
    assert.deepEqual(Object.keys(run.flows), [tradeFlowSeedKey('840', '000')]);
  });

  test('the fallback reporter list reaches the manifest that gates publication', async () => {
    // Closes the loop between fetchWtoReporters' catch arm and publishTradeFlows'
    // refusal: without this, the flag could stop propagating and the gate would
    // silently never fire.
    _setAllReportersForTesting(['840']);
    _setReporterListIsFallbackForTesting(true);
    globalThis.fetch = (async (input: string | URL | Request) =>
      wtoRows(new URL(String(input)).searchParams.get('i') ?? '', [2025])) as typeof fetch;

    const run = await fetchTradeFlows();
    assert.equal(run.manifest.reporterListIsFallback, true);

    _setReporterListIsFallbackForTesting(false);
    const clean = await fetchTradeFlows();
    assert.equal(clean.manifest.reporterListIsFallback, false);
  });

  test('the manifest is sorted so its bytes are stable across runs', async () => {
    _setAllReportersForTesting(['840', '004', '156']);
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;

    const run = await fetchTradeFlows();
    assert.deepEqual(run.manifest.pairs, ['004:000', '156:000', '840:000']);
  });
});

// ── Seeder: publish ───────────────────────────────────────────────────────

describe('publishTradeFlows', () => {
  /** Capture the Redis commands the publish path actually issues. */
  function captureRedis(): unknown[][] {
    const commands: unknown[][] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith(REDIS_HOST)) throw new Error(`unexpected fetch to ${String(input)}`);
      commands.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }) as typeof fetch;
    return commands;
  }

  const RUN = {
    flows: { 'trade:flows:v2:840:000': seededPayload(2020, 2025) },
    coverage: { pairsAttempted: 3, pairsSeeded: 1, upstreamFailures: 1, emptyPairs: 1, incompleteYearsDropped: 2, startYear: 1996, endYear: 2026 },
    manifest: { pairs: ['840:000'], startYear: 1996, endYear: 2026, stats: { pairsSeeded: 1 }, fetchedAt: '2026-08-07T00:00:00.000Z' },
  };

  test('a zero-pair run publishes no manifest', async () => {
    // Reachable with no code fault: fetchWtoReporters returns early when
    // WTO_API_KEY is unset or rotated, leaving ALL_REPORTERS at its [] default.
    // An empty manifest would turn a total outage into `not_covered` for every
    // request — the one verdict the CDN is allowed to hold for hours.
    const commands = captureRedis();
    await publishTradeFlows({ ...RUN, flows: {}, manifest: { ...RUN.manifest, pairs: [] } });

    assert.ok(!commands.map((c) => c[1]).includes(COVERAGE_KEY),
      'an empty manifest must never replace a good one');
  });

  test('a manifest write failure does not cost the freshness record', async () => {
    // The per-pair writes are isolated; this one was not. A throw here would
    // skip writeSeedMeta AND abort fetchAll before the tariff, customs and
    // canonical shipping publishes — the cascade the isolation exists to stop.
    const written: unknown[][] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith(REDIS_HOST)) throw new Error('unexpected host');
      const cmd = JSON.parse(String(init?.body));
      if (cmd[1] === COVERAGE_KEY) return new Response('nope', { status: 400 });
      written.push(cmd);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }) as typeof fetch;

    await publishTradeFlows(RUN);

    assert.ok(written.some((c) => c[1] === 'seed-meta:trade:flows'),
      'freshness must still be recorded when only the manifest write failed');
  });

  test('a run that wrote nothing leaves the last good freshness record alone', async () => {
    // Overwriting it would replace "256 pairs, healthy" with "0 pairs, as of
    // now" — a freshly dated EMPTY instead of letting the existing record age
    // into STALE_SEED. Declaring the fleet gone is not the seeder's call.
    const written: unknown[][] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith(REDIS_HOST)) throw new Error('unexpected host');
      const cmd = JSON.parse(String(init?.body));
      if (String(cmd[1]).startsWith('trade:flows:v2:')) return new Response('nope', { status: 400 });
      written.push(cmd);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }) as typeof fetch;

    await publishTradeFlows(RUN);

    assert.ok(!written.some((c) => c[1] === 'seed-meta:trade:flows'),
      'a zero-write run must not stamp a fresh timestamp over a healthy record');
  });

  test('a partial write failure is reported as partial, not as full coverage', async () => {
    // One key's write fails permanently. The remaining pairs must still land,
    // and the freshness record must count what is actually in Redis — otherwise
    // health reads full coverage over a half-written fleet.
    const written: unknown[][] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith(REDIS_HOST)) throw new Error('unexpected host');
      const cmd = JSON.parse(String(init?.body));
      // 400 is in PERMANENT_4XX_STATUSES, so writeExtraKey fails fast instead of
      // burning its retry budget — this asserts the isolation, not the retry.
      if (cmd[1] === 'trade:flows:v2:156:000') return new Response('nope', { status: 400 });
      written.push(cmd);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }) as typeof fetch;

    await publishTradeFlows({
      ...RUN,
      flows: {
        'trade:flows:v2:840:000': seededPayload(2020, 2025),
        'trade:flows:v2:156:000': seededPayload(2020, 2025),
        'trade:flows:v2:004:000': seededPayload(2020, 2025),
      },
    });

    const keys = written.map((c) => c[1]);
    assert.ok(keys.includes('trade:flows:v2:004:000'),
      'a failed write must not abort the pairs after it');
    assert.ok(keys.includes(COVERAGE_KEY), 'the manifest must still be published');

    const meta = written.find((c) => c[1] === 'seed-meta:trade:flows');
    assert.ok(meta, 'freshness must still be recorded');
    assert.equal(JSON.parse(String(meta[2])).recordCount, 2,
      'recordCount must count what landed in Redis (2 of 3), not what was fetched — '
      + 'otherwise a partial write reads as full coverage');
  });

  test('a run on the fallback reporter list publishes no manifest', async () => {
    // The fallback list is smaller than WTO's (239 vs the 278 advertised on
    // 2026-08-07), so its manifest under-states coverage. `not_covered` is the
    // one verdict that leaves upstreamUnavailable false, which is the one the
    // gateway lets the CDN hold for hours — so publishing this manifest would
    // cache "not covered" about economies that ARE covered.
    const commands = captureRedis();
    await publishTradeFlows({ ...RUN, manifest: { ...RUN.manifest, reporterListIsFallback: true } });

    const keys = commands.map((c) => c[1]);
    assert.ok(!keys.includes(COVERAGE_KEY),
      'an under-stated manifest must not replace a good one, nor create a cacheable false verdict');
    assert.ok(keys.includes('trade:flows:v2:840:000'), 'the rows themselves are still fine to publish');
    assert.ok(keys.includes('seed-meta:trade:flows'), 'and freshness is still reported');
  });

  test('the manifest is written under the key the handler reads', async () => {
    const commands = captureRedis();
    await publishTradeFlows(RUN);

    const keys = commands.map((c) => c[1]);
    assert.ok(keys.includes(COVERAGE_KEY), `manifest key missing from ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('trade:flows:v2:840:000'));
  });

  test('seed-meta records the pairs actually published', async () => {
    const commands = captureRedis();
    await publishTradeFlows(RUN);

    const meta = commands.find((c) => c[1] === 'seed-meta:trade:flows');
    assert.ok(meta, 'expected an aggregate seed-meta write');
    const payload = JSON.parse(String(meta[2])) as { recordCount: number; coverage?: unknown };
    assert.equal(payload.recordCount, 1, 'health compares this against its minRecordCount floor');
    assert.equal(payload.coverage, undefined,
      'api/health.js parses meta.coverage with the consumer-prices page/retailer schema, so a '
      + 'differently-shaped object would be published as an all-zero completedPages block');
  });

  test('freshness is stamped only after the data it vouches for', async () => {
    const commands = captureRedis();
    await publishTradeFlows(RUN);

    assert.equal(commands[commands.length - 1][1], 'seed-meta:trade:flows');
  });
});

// ── Seeder: advertised coverage ───────────────────────────────────────────

describe('tradeFlowPairUniverse', () => {
  test('coverage is reporter-versus-World only', () => {
    const pairs = tradeFlowPairUniverse(['840', '156', '004']);
    assert.deepEqual(pairs, [['840', '000'], ['156', '000'], ['004', '000']]);
  });

  test('a duplicated reporter is fetched once', () => {
    assert.equal(tradeFlowPairUniverse(['840', '840']).length, 1);
  });

  test('the manifest never advertises a pair WTO cannot answer', () => {
    // Measured 2026-08-07: ITS_MTV_AX/ITS_MTV_AM report numberPartners=3, and
    // r=840&p=all returns only "000". A named partner inside the manifest would
    // be reported as a broken seed forever instead of as uncovered.
    const ids = tradeFlowPairUniverse(['840', '156']).map(([r, p]) => tradeFlowCoverageId(r, p));
    assert.ok(ids.every((id) => id.endsWith(`:${WORLD_PARTNER_CODE}`)), ids.join(','));
  });
});
