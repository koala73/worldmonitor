import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import { getFlightStatus } from '../server/worldmonitor/aviation/v1/get-flight-status.ts';
import { getCarrierOps } from '../server/worldmonitor/aviation/v1/get-carrier-ops.ts';

const ENV_KEYS = [
  'AVIATIONSTACK_MONTHLY_BUDGET',
  'AVIATIONSTACK_REQUEST_BUDGET',
  'LOCAL_API_MODE',
  'RELAY_AUTH_HEADER',
  'RELAY_SHARED_SECRET',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'WORLDMONITOR_VALID_KEYS',
  'WS_RELAY_URL',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

type RelayMode = 'ok-empty' | 'http-503' | ((url: string) => Response);

type FetchMockOptions = {
  relay?: RelayMode;
  denyBudget?: boolean;
};

type RedisSetCommand = ['SET', string, string, 'EX', string];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

function installFetchMock(options: FetchMockOptions = {}) {
  const calls = {
    relayUrls: [] as string[],
    redisSets: [] as RedisSetCommand[],
    pipelines: [] as unknown[][][],
  };
  let budgetCounter = 0;

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }

    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      calls.pipelines.push(commands);
      const results = commands.map((command) => {
        const [verb, , count] = command;
        if (verb === 'INCRBY') {
          budgetCounter += Number(count);
          return { result: budgetCounter };
        }
        if (verb === 'DECRBY') {
          budgetCounter -= Number(count);
          return { result: budgetCounter };
        }
        return { result: 1 };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    }

    if (url === 'https://redis.test/') {
      const command = JSON.parse(String(init?.body ?? '[]')) as RedisSetCommand;
      calls.redisSets.push(command);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (url.startsWith('https://relay.test/aviationstack')) {
      calls.relayUrls.push(url);
      if (typeof options.relay === 'function') return options.relay(url);
      if (options.relay === 'ok-empty') {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'relay unavailable' } }), { status: 503 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  if (options.denyBudget) {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '1';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '0';
  } else {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '0';
  }

  return calls;
}

function requestFor(path: string): Request {
  return new Request(`https://worldmonitor.app${path}`);
}

function ctxFor(request: Request) {
  return { request, pathParams: {}, headers: {} };
}

function redisPayloads(calls: ReturnType<typeof installFetchMock>): unknown[] {
  return calls.redisSets.map(([, , payload]) => JSON.parse(payload));
}

function assertOnlyNegativeSentinels(calls: ReturnType<typeof installFetchMock>) {
  const payloads = redisPayloads(calls);
  assert.ok(payloads.length > 0, 'expected at least one Redis SET');
  assert.deepEqual([...new Set(payloads)], ['__WM_NEG__']);
}

function assertNoCacheSideChannel(request: Request) {
  assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
}

describe('aviation cache poison prevention', () => {
  it('negative-caches missing relay config instead of positive-caching an empty airport board', async () => {
    const calls = installFetchMock();
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=AAA');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'AAA',
      direction: 'FLIGHT_DIRECTION_DEPARTURE',
      limit: 30,
    });

    assert.deepEqual(response.flights, []);
    assert.equal(response.totalAvailable, 0);
    assert.equal(response.source, 'none');
    assertOnlyNegativeSentinels(calls);
    assertNoCacheSideChannel(request);
  });

  it('negative-caches request budget exhaustion without calling the relay', async () => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    const calls = installFetchMock({ denyBudget: true });
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=BBB');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'BBB',
      direction: 'FLIGHT_DIRECTION_DEPARTURE',
      limit: 30,
    });

    assert.equal(response.source, 'budget');
    assert.deepEqual(response.flights, []);
    assert.equal(calls.relayUrls.length, 0, 'budget denial must not call AviationStack relay');
    assert.ok(calls.pipelines.some((commands) => commands.some(([verb]) => verb === 'DECRBY')), 'denied reservation should be refunded');
    assertOnlyNegativeSentinels(calls);
    assertNoCacheSideChannel(request);
  });

  it('negative-caches relay failures for flight-status lookups', async () => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    const calls = installFetchMock({ relay: 'http-503' });
    const request = requestFor('/api/aviation/v1/get-flight-status?flight_number=TK1952&date=2026-07-09');

    const response = await getFlightStatus(ctxFor(request), {
      flightNumber: 'TK1952',
      date: '2026-07-09',
      origin: '',
    });

    assert.equal(response.source, 'error');
    assert.deepEqual(response.flights, []);
    assert.equal(calls.relayUrls.length, 1);
    assertOnlyNegativeSentinels(calls);
    assertNoCacheSideChannel(request);
  });

  it('keeps a healthy AviationStack zero-row response positive-cacheable', async () => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    const calls = installFetchMock({ relay: 'ok-empty' });
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=CCC');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'CCC',
      direction: 'FLIGHT_DIRECTION_DEPARTURE',
      limit: 30,
    });

    assert.equal(response.source, 'aviationstack');
    assert.deepEqual(response.flights, []);
    assert.equal(response.totalAvailable, 0);
    assert.equal(calls.relayUrls.length, 1);
    assert.deepEqual(redisPayloads(calls), [{ flights: [], source: 'aviationstack' }]);
    assert.equal(drainResponseHeaders(request), undefined, 'healthy empty data must not request no-store');
  });

  it('propagates all-child unavailable state from carrier ops instead of claiming aviationstack success', async () => {
    const calls = installFetchMock();
    const request = requestFor('/api/aviation/v1/get-carrier-ops?airports=DDD&airports=EEE');

    const response = await getCarrierOps(ctxFor(request), {
      airports: ['DDD', 'EEE'],
      minFlights: 0,
    });

    assert.deepEqual(response.carriers, []);
    assert.equal(response.source, 'none');
    assertOnlyNegativeSentinels(calls);
    assertNoCacheSideChannel(request);
  });

  it('marks carrier ops partial when one child airport fails and another is healthy empty data', async () => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    const calls = installFetchMock({
      relay: (url) => url.includes('dep_iata=GGG')
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'relay unavailable' } }), { status: 503 }),
    });
    const request = requestFor('/api/aviation/v1/get-carrier-ops?airports=GGG&airports=HHH');

    const response = await getCarrierOps(ctxFor(request), {
      airports: ['GGG', 'HHH'],
      minFlights: 0,
    });

    assert.deepEqual(response.carriers, []);
    assert.equal(response.source, 'partial');
    const payloads = redisPayloads(calls);
    assert.ok(payloads.some((payload) => payload === '__WM_NEG__'), 'partial aggregate should negative-cache its unavailable result');
    assert.ok(payloads.some((payload) => typeof payload === 'object' && payload !== null && (payload as { source?: string }).source === 'aviationstack'), 'healthy empty child remains positive-cacheable');
    assertNoCacheSideChannel(request);
  });

  it('forces airport-flight unavailable HTTP responses to no-store at the gateway', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
    const calls = installFetchMock();
    const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));

    const response = await gateway(new Request(
      'https://worldmonitor.app/api/aviation/v1/list-airport-flights?airport=FFF&limit=30&_debug=1',
      { headers: { 'X-WorldMonitor-Key': 'test-key' } },
    ));
    const body = await response.json() as { source?: string; flights?: unknown[] };

    assert.equal(response.status, 200);
    assert.equal(body.source, 'none');
    assert.deepEqual(body.flights, []);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Cache-Tier'), 'no-store');
    assert.equal(response.headers.get('CDN-Cache-Control'), null);
    assertOnlyNegativeSentinels(calls);
  });
});
