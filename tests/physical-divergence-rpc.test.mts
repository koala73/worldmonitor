import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import { marketHandler } from '../server/worldmonitor/market/v1/handler.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';
import {
  METHODOLOGY_VERSION,
  buildPhysicalDivergenceReading,
  buildPhysicalStressComposite,
} from '../scripts/lib/physical-divergence.mjs';

const NOW_MS = Date.parse('2026-08-18T12:30:00.000Z');
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const originalEnv = new Map<string, string | undefined>();
const marketDataTool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_market_data');
assert.ok(marketDataTool?._postFilter);

function history(metal: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(NOW_MS - index * 86_400_000).toISOString().slice(0, 10),
    premiumPct: metal === 'gold' ? 1 + index / 100 : 5 + index / 100,
    premiumUsdPerOz: metal === 'gold' ? 30 + index : 3 + index / 10,
    physicalAsOf: new Date(NOW_MS - index * 86_400_000).toISOString().slice(0, 10),
    paperAsOf: new Date(NOW_MS - index * 86_400_000).toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
  }));
}

function current(metal: string) {
  const symbols = metal === 'gold'
    ? { physical: 'SHAU', paper: 'GC=F' }
    : { physical: 'SHAG', paper: 'SI=F' };
  return {
    metal,
    premiumPct: metal === 'gold' ? 1 : 5,
    premiumUsdPerOz: metal === 'gold' ? 30 : 3,
    physical: {
      source: `Shanghai Gold Exchange ${symbols.physical} PM benchmark`,
      asOf: '2026-08-18',
    },
    paper: {
      source: `COMEX ${symbols.paper} futures snapshot`,
      asOf: '2026-08-18T12:00:00.000Z',
    },
  };
}

const FX = {
  pair: 'CNY/USD',
  source: 'shared:fx-rates:v1',
  asOf: '2026-08-18T12:28:48.000Z',
};

function snapshot(historyPoints: number) {
  const readings = ['gold', 'silver'].map((metal) => buildPhysicalDivergenceReading({
    metal,
    current: current(metal),
    history: history(metal, historyPoints),
    fx: FX,
    nowMs: NOW_MS,
  }));
  return {
    readings,
    composite: buildPhysicalStressComposite(readings),
    evaluatedAt: new Date(NOW_MS).toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
    transitions: [],
  };
}

function routeHandler() {
  const descriptor = createMarketServiceRoutes(marketHandler, {})
    .find((route) => route.path === '/api/market/v1/get-physical-divergence-index');
  assert.ok(descriptor);
  return descriptor.handler;
}

function installRedisMock(payload: unknown, status = 200) {
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith('https://redis.test/get/')) throw new Error(`unexpected fetch: ${url}`);
    if (status !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status });
    return new Response(JSON.stringify({ result: payload == null ? null : JSON.stringify(payload) }));
  });
}

beforeEach(() => {
  mock.method(Date, 'now', () => NOW_MS);
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('GetPhysicalDivergenceIndex public contract', () => {
  it('proves the 59-point and 60-point state boundary through the generated public route', async () => {
    installRedisMock(snapshot(59));
    let response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.deepEqual(body.readings.map((reading: { state: string }) => reading.state), [
      'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY',
      'PHYSICAL_DIVERGENCE_STATE_INSUFFICIENT_HISTORY',
    ]);
    assert.equal(body.readings[0].index, undefined);
    assert.equal(body.composite.index, undefined);

    mock.restoreAll();
    mock.method(Date, 'now', () => NOW_MS);
    installRedisMock(snapshot(60));
    response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    body = await response.json();
    assert.deepEqual(body.readings.map((reading: { state: string }) => reading.state), [
      'PHYSICAL_DIVERGENCE_STATE_OK',
      'PHYSICAL_DIVERGENCE_STATE_OK',
    ]);
    assert.equal(typeof body.readings[0].index, 'number');
    assert.equal(body.composite.state, 'PHYSICAL_DIVERGENCE_STATE_OK');
    assert.equal(body.composite.weights[0].weight, 0.7);
  });

  it('filters readings while preserving the all-metal composite and provenance', async () => {
    installRedisMock(snapshot(60));
    const response = await routeHandler()(
      new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index?metals=silver'),
    );
    const body = await response.json();

    assert.deepEqual(body.readings.map((reading: { metal: string }) => reading.metal), ['silver']);
    assert.equal(body.readings[0].historyKey, 'market:physical-premium-history:v1:silver');
    assert.equal(body.readings[0].methodologyVersion, METHODOLOGY_VERSION);
    assert.deepEqual(body.readings[0].provenance, {
      physicalSource: 'Shanghai Gold Exchange SHAG PM benchmark',
      physicalSymbol: 'SHAG',
      physicalAsOf: '2026-08-18',
      paperSource: 'COMEX SI=F futures snapshot',
      paperSymbol: 'SI=F',
      paperAsOf: '2026-08-18T12:00:00.000Z',
      fxSource: 'shared:fx-rates:v1',
      fxPair: 'CNY/USD',
      fxAsOf: '2026-08-18T12:28:48.000Z',
      historyKey: 'market:physical-premium-history:v1:silver',
      historyWindowPoints: 250,
      methodologyVersion: METHODOLOGY_VERSION,
    });
    assert.equal(body.composite.weights.length, 2);
  });

  it('returns explicit missing_input states when the derived snapshot is absent', async () => {
    installRedisMock(null);
    const request = new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index');
    const response = await routeHandler()(request);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.readings.every((reading: { state: string }) => reading.state === 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT'));
    assert.equal(body.composite.state, 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT');
    assert.equal(body.composite.reason, 'divergence_snapshot_unavailable');
    assert.deepEqual(drainResponseHeaders(request), { 'X-No-Cache': '1' });
  });

  it('preserves a publisher-produced missing_input state with unavailable source clocks', async () => {
    const stored = snapshot(60);
    const gold = stored.readings[0];
    Object.assign(gold, {
      state: 'missing_input',
      reason: 'current_premium_missing',
      regime: null,
      index: null,
      premiumPct: null,
      premiumUsdPerOz: null,
      percentile: null,
      robustZ: null,
      delta5d: null,
      delta20d: null,
      trend5d: null,
      trend20d: null,
      physicalAsOf: '',
      paperAsOf: '',
      provenance: {
        ...gold.provenance,
        physicalSource: '',
        physicalAsOf: '',
        paperSource: '',
        paperAsOf: '',
      },
    });
    stored.composite = buildPhysicalStressComposite(stored.readings);
    installRedisMock(stored);

    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.readings[0].state, 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT');
    assert.equal(body.readings[0].reason, 'current_premium_missing');
    assert.equal(body.composite.state, 'PHYSICAL_DIVERGENCE_STATE_MISSING_INPUT');
    assert.equal(body.composite.reason, 'member_not_ok:gold:missing_input');
  });

  it('returns a server error when the Redis read fails instead of masquerading as missing input', async () => {
    installRedisMock(null, 503);
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    assert.equal(response.status, 500);
  });

  it('degrades a stored ok snapshot after the physical print crosses the stale boundary', async () => {
    const stored = snapshot(60);
    for (const reading of stored.readings) {
      reading.physicalAsOf = '2026-08-05';
      reading.provenance.physicalAsOf = '2026-08-05';
    }
    installRedisMock(stored);
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    const body = await response.json();

    assert.ok(body.readings.every((reading: { state: string }) => reading.state === 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT'));
    assert.ok(body.readings.every((reading: { index?: number }) => reading.index === undefined));
    assert.equal(body.composite.state, 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT');
    assert.equal(body.composite.index, undefined);
  });

  it('gives request-time staleness precedence over stored insufficient history', async () => {
    const stored = snapshot(59);
    for (const reading of stored.readings) {
      reading.physicalAsOf = '2026-08-05';
      reading.provenance.physicalAsOf = '2026-08-05';
    }
    installRedisMock(stored);
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    const body = await response.json();

    assert.ok(body.readings.every((reading: { state: string }) => reading.state === 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT'));
    assert.ok(body.readings.every((reading: { index?: number }) => reading.index === undefined));
    assert.equal(body.composite.state, 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT');
    assert.equal(body.composite.reason, 'member_not_ok:gold:stale_input');
    assert.equal(body.composite.index, undefined);
  });

  it('reevaluates paper and FX freshness at request time', async () => {
    for (const [clock, reason] of [
      ['paper', 'paper_snapshot_older_than_36_hours'],
      ['fx', 'fx_snapshot_older_than_60_hours'],
    ] as const) {
      const stored = snapshot(60);
      for (const reading of stored.readings) {
        if (clock === 'paper') {
          reading.paperAsOf = '2026-08-16T23:59:59.000Z';
          reading.provenance.paperAsOf = '2026-08-16T23:59:59.000Z';
        } else {
          reading.provenance.fxAsOf = '2026-08-15T23:59:59.000Z';
        }
      }
      installRedisMock(stored);
      const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
      const body = await response.json();
      assert.ok(body.readings.every((reading: { state: string }) => reading.state === 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT'));
      assert.ok(body.readings.every((reading: { reason: string }) => reading.reason === reason));
      mock.restoreAll();
      mock.method(Date, 'now', () => NOW_MS);
    }
  });

  it('surfaces an unknown state as a server error instead of mapping it to normal', async () => {
    const corrupt = snapshot(60);
    corrupt.readings[0].state = 'future_state';
    installRedisMock(corrupt);
    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(body.message, /Unknown physical divergence state/);
  });

  it('rejects the same malformed metal set through the public RPC and MCP boundaries', async () => {
    const corrupt = snapshot(60);
    corrupt.readings[1] = structuredClone(corrupt.readings[0]);
    installRedisMock(corrupt);

    const response = await routeHandler()(new Request('https://worldmonitor.app/api/market/v1/get-physical-divergence-index'));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.message, /must contain gold and silver readings/);

    const filtered = marketDataTool._postFilter?.(
      { 'physical-divergence': structuredClone(corrupt) },
      { limit: 0 },
    );
    assert.equal(filtered?.['physical-divergence'], undefined);
  });
});
