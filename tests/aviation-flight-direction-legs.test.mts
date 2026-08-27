// direction=both used to be a departures board wearing an arrivals label.
// `paramKey = direction === ARRIVAL ? 'arr_iata' : 'dep_iata'` sent BOTH — and
// UNSPECIFIED, which is what the generated HTTP decoder hands over when the
// query param is absent — down the departures branch, so the panel's own call
// (`fetchAirportFlights(airport, 'both', 30)`) never once fetched an arrival.
// The proto documents both values as arrivals-inclusive.
//
// These tests pin the upstream queries each direction issues, the merge order
// that keeps arrivals visible under a small limit, and the per-leg cache keys
// that stop three of four directions from buying duplicate departure payloads.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { __resetFetcherTimeoutForTests, __setFetcherTimeoutForTests } from '../server/_shared/redis.ts';

const ENV_KEYS = [
  'AVIATIONSTACK_MONTHLY_BUDGET',
  'AVIATIONSTACK_REQUEST_BUDGET',
  'LOCAL_API_MODE',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'WORLDMONITOR_VALID_KEYS',
  'WS_RELAY_URL',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  process.env.WS_RELAY_URL = 'https://relay.test';
  process.env.AVIATIONSTACK_MONTHLY_BUDGET = '0';
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  __resetFetcherTimeoutForTests();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

type AVSFlight = {
  flight: { iata: string };
  airline: { iata: string; name: string };
  departure: { iata: string; scheduled: string };
  arrival: { iata: string; scheduled: string };
  flight_status: string;
};

function avsFlight(iata: string, from: string, to: string, dep: string, arr: string): AVSFlight {
  return {
    flight: { iata },
    airline: { iata: iata.slice(0, 2), name: iata.slice(0, 2) },
    departure: { iata: from, scheduled: dep },
    arrival: { iata: to, scheduled: arr },
    flight_status: 'scheduled',
  };
}

type LegPayloads = { departures?: AVSFlight[]; arrivals?: AVSFlight[] };
type LegFailures = { departures?: boolean; arrivals?: boolean; arrivalsHang?: boolean };

/**
 * Redis mock that actually stores. The per-leg cache-sharing test needs a
 * second request to observe what the first one wrote; a mock that always
 * returns a miss would make every direction look like a fresh paid call and
 * the duplicate-payload regression would be untestable.
 */
function installFetchMock(payloads: LegPayloads = {}, failures: LegFailures = {}) {
  const calls = {
    relayUrls: [] as string[],
    reservations: [] as number[],
    cacheKeysWritten: [] as string[],
  };
  const store = new Map<string, string>();

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.test/get/'.length));
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }

    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      const results = commands.map((command) => {
        const [verb, , count] = command;
        if (verb === 'INCRBY') calls.reservations.push(Number(count));
        return { result: 1 };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    }

    if (url === 'https://redis.test/') {
      const [, key, payload] = JSON.parse(String(init?.body ?? '[]')) as [string, string, string];
      calls.cacheKeysWritten.push(key);
      store.set(key, payload);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (url.startsWith('https://relay.test/aviationstack')) {
      calls.relayUrls.push(url);
      const arrivals = url.includes('arr_iata=');
      // Hangs forever: the cache layer's own timeout backstop is what settles
      // this leg, and it settles it by REJECTING.
      if (arrivals && failures.arrivalsHang) return new Promise<Response>(() => {});
      if (arrivals ? failures.arrivals : failures.departures) {
        return new Response(JSON.stringify({ error: { message: 'relay unavailable' } }), { status: 503 });
      }
      const data = (arrivals ? payloads.arrivals : payloads.departures) ?? [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  return { ...calls, store };
}

function requestFor(path: string): Request {
  return new Request(`https://worldmonitor.app${path}`, {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
}

function ctxFor(request: Request) {
  return { request, pathParams: {}, headers: {} } as never;
}

function legsQueried(relayUrls: string[]): string[] {
  return relayUrls
    .map((u) => {
      const params = new URL(u).searchParams;
      if (params.get('dep_iata')) return `dep:${params.get('dep_iata')}`;
      if (params.get('arr_iata')) return `arr:${params.get('arr_iata')}`;
      return 'none';
    })
    .sort();
}

describe('list-airport-flights direction legs', () => {
  it('fetches BOTH legs for direction=BOTH', async () => {
    const calls = installFetchMock();
    const response = await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30 } as never,
    );

    assert.deepEqual(legsQueried(calls.relayUrls), ['arr:IST', 'dep:IST']);
    assert.equal(response.source, 'aviationstack');
  });

  it('fetches BOTH legs for UNSPECIFIED — the shape an absent direction param arrives as', async () => {
    const calls = installFetchMock();
    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_UNSPECIFIED', limit: 30 } as never,
    );

    assert.deepEqual(legsQueried(calls.relayUrls), ['arr:IST', 'dep:IST']);
  });

  it('fetches only the departures leg for direction=DEPARTURE', async () => {
    const calls = installFetchMock();
    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_DEPARTURE')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_DEPARTURE', limit: 30 } as never,
    );

    assert.deepEqual(legsQueried(calls.relayUrls), ['dep:IST']);
  });

  it('fetches only the arrivals leg for direction=ARRIVAL', async () => {
    const calls = installFetchMock();
    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_ARRIVAL')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_ARRIVAL', limit: 30 } as never,
    );

    assert.deepEqual(legsQueried(calls.relayUrls), ['arr:IST']);
  });

  it('orders the merged board by airport-local time so a small limit still shows arrivals', async () => {
    // Every arrival departs its origin before every departure leaves IST — the
    // shape that makes a naive concat-and-slice, or a sort on scheduled
    // departure, hand back a departures-only page.
    const arrivals = Array.from({ length: 10 }, (_, i) =>
      avsFlight(`AR${i}`, 'LHR', 'IST', `2026-08-27T0${i % 5}:00:00+00:00`, `2026-08-27T1${i}:30:00+00:00`));
    const departures = Array.from({ length: 10 }, (_, i) =>
      avsFlight(`DP${i}`, 'IST', 'JFK', `2026-08-27T1${i}:00:00+00:00`, `2026-08-27T2${i % 4}:00:00+00:00`));
    installFetchMock({ departures, arrivals });

    const response = await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 6 } as never,
    );

    assert.equal(response.totalAvailable, 20);
    assert.equal(response.flights.length, 6);
    assert.ok(
      response.flights.some(f => f.destination?.iata === 'IST'),
      'expected arrivals in the first page of a merged board',
    );
    assert.ok(
      response.flights.some(f => f.origin?.iata === 'IST'),
      'expected departures in the first page of a merged board',
    );

    // Non-decreasing in the time each flight touches IST.
    const boardTimes = response.flights.map(f =>
      f.destination?.iata === 'IST' ? f.scheduledArrival : f.scheduledDeparture);
    assert.deepEqual(boardTimes, [...boardTimes].sort((a, b) => a - b));
  });

  it('shares one cached payload per leg across every direction that reads it', async () => {
    // The direction used to sit in the cache key while three of its four values
    // issued the identical dep_iata query, so DEPARTURE, BOTH and UNSPECIFIED
    // each bought and stored their own copy of the same departures page.
    const calls = installFetchMock({
      departures: [avsFlight('TK1', 'IST', 'JFK', '2026-08-27T10:00:00+00:00', '2026-08-27T18:00:00+00:00')],
      arrivals: [avsFlight('TK2', 'LHR', 'IST', '2026-08-27T06:00:00+00:00', '2026-08-27T11:00:00+00:00')],
    });

    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30 } as never,
    );
    assert.equal(calls.relayUrls.length, 2, 'both request buys one call per leg');

    const afterBoth = calls.relayUrls.length;
    const departuresOnly = await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_DEPARTURE')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_DEPARTURE', limit: 30 } as never,
    );
    const arrivalsOnly = await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_ARRIVAL')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_ARRIVAL', limit: 30 } as never,
    );

    assert.equal(calls.relayUrls.length, afterBoth, 'single-direction requests reuse the legs the both request warmed');
    assert.deepEqual(departuresOnly.flights.map(f => f.flightNumber), ['TK1']);
    assert.deepEqual(arrivalsOnly.flights.map(f => f.flightNumber), ['TK2']);
    assert.equal(new Set(calls.cacheKeysWritten).size, 2, 'exactly two payloads cached for two legs');
  });

  it('reserves one budget call per leg actually fetched', async () => {
    const calls = installFetchMock();
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '1000';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '1000';

    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30 } as never,
    );

    assert.deepEqual(calls.reservations, [1, 1], 'two legs reserve two calls, one each');
  });

  it('reports a half-served board as partial instead of passing it off as complete', async () => {
    installFetchMock(
      { departures: [avsFlight('TK1', 'IST', 'JFK', '2026-08-27T10:00:00+00:00', '2026-08-27T18:00:00+00:00')] },
      { arrivals: true },
    );
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30,
    } as never);

    assert.equal(response.source, 'partial');
    assert.deepEqual(response.flights.map(f => f.flightNumber), ['TK1']);
    assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1', 'a partial board must not be edge-cached');
  });

  it('still serves the healthy leg when the other one rejects rather than returning null', async () => {
    // cachedFetchJson does not always resolve to null on failure — it REJECTS
    // on its fetcher-timeout backstop (and while an isolate-local unavailable
    // backoff is armed). Under Promise.all that one rejection takes the whole
    // board down, discarding a leg that was ready to serve.
    const calls = installFetchMock({
      departures: [avsFlight('TK1', 'IST', 'JFK', '2026-08-27T10:00:00+00:00', '2026-08-27T18:00:00+00:00')],
    }, { arrivalsHang: true });
    __setFetcherTimeoutForTests(50);
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30,
    } as never);

    assert.equal(response.source, 'partial');
    assert.deepEqual(response.flights.map(f => f.flightNumber), ['TK1']);
    assert.ok(calls.relayUrls.some(u => u.includes('arr_iata=IST')), 'the arrivals leg was attempted');
  });

  it('names the actionable failure when the other leg is only negative-cached', async () => {
    // 'unavailable' is what a negative-cache hit reports — it says a failure
    // was cached here, not which. A sibling leg that hit the budget ceiling is
    // the answer worth surfacing.
    const failures = { departures: true };
    const { store } = installFetchMock({ arrivals: [] }, failures);

    // Round one negative-caches the departures leg and positive-caches arrivals.
    await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30 } as never,
    );
    const arrivalsKey = [...store.keys()].find(k => k.includes(':arrival:'));
    assert.ok(arrivalsKey, 'arrivals leg cached a payload in round one');
    store.delete(arrivalsKey);

    // Round two: departures reads the cached sentinel ('unavailable'), arrivals
    // misses and is refused by the budget ceiling ('budget').
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '1';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '0';
    const response = await listAirportFlights(
      ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH')),
      { airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30 } as never,
    );

    assert.equal(response.source, 'budget');
    assert.deepEqual(response.flights, []);
  });

  it('reports the failure source when no leg serves', async () => {
    installFetchMock({}, { departures: true, arrivals: true });
    const request = requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_BOTH');

    const response = await listAirportFlights(ctxFor(request), {
      airport: 'IST', direction: 'FLIGHT_DIRECTION_BOTH', limit: 30,
    } as never);

    assert.equal(response.source, 'error');
    assert.deepEqual(response.flights, []);
    assert.equal(response.totalAvailable, 0);
    assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
  });
});
