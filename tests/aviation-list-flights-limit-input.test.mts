// A negative `limit` used to reach slice(0, limit), which counts from the end
// of the array and silently returned the wrong flights. This pins the guard
// that rejects it before any paid AviationStack call, while 0 and positive
// limits keep their existing behavior.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';

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

function avsFlight(iata: string): AVSFlight {
  return {
    flight: { iata },
    airline: { iata: iata.slice(0, 2), name: iata.slice(0, 2) },
    departure: { iata: 'IST', scheduled: '2026-08-27T10:00:00+00:00' },
    arrival: { iata: 'JFK', scheduled: '2026-08-27T18:00:00+00:00' },
    flight_status: 'scheduled',
  };
}

/** Redis + relay mock. Records relay calls so we can prove a rejected limit buys nothing. */
function installFetchMock(departures: AVSFlight[]) {
  const relayUrls: string[] = [];
  const store = new Map<string, string>();
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.test/get/'.length));
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }
    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      return new Response(JSON.stringify(commands.map(() => ({ result: 1 }))), { status: 200 });
    }
    if (url === 'https://redis.test/') {
      const [, key, payload] = JSON.parse(String(init?.body ?? '[]')) as [string, string, string];
      store.set(key, payload);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://relay.test/aviationstack')) {
      relayUrls.push(url);
      const arrivals = url.includes('arr_iata=');
      const data = arrivals ? [] : departures;
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { relayUrls };
}

function requestFor(path: string): Request {
  return new Request(`https://worldmonitor.app${path}`, {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
}

function ctxFor(request: Request) {
  return { request, pathParams: {}, headers: {} } as never;
}

const PAGE = ['TK1', 'TK2', 'TK3', 'TK4', 'TK5'].map(avsFlight);

async function call(limit: number, departures = PAGE) {
  const calls = installFetchMock(departures);
  const response = await listAirportFlights(
    ctxFor(requestFor('/api/aviation/v1/list-airport-flights?airport=IST')),
    { airport: 'IST', direction: 'FLIGHT_DIRECTION_DEPARTURE', limit } as never,
  );
  return { response, calls };
}

describe('list-airport-flights limit input', () => {
  it('rejects a negative limit before any paid upstream call', async () => {
    const { response, calls } = await call(-2);
    assert.equal(response.source, 'invalid');
    assert.deepEqual(response.flights, []);
    assert.equal(response.totalAvailable, 0);
    assert.equal(calls.relayUrls.length, 0, 'no upstream fetch after an invalid limit');
  });

  it('rejects -1 the same way', async () => {
    const { response, calls } = await call(-1);
    assert.equal(response.source, 'invalid');
    assert.deepEqual(response.flights, []);
    assert.equal(calls.relayUrls.length, 0);
  });

  it('keeps limit 0 as the default (30), not a rejection', async () => {
    const { response } = await call(0);
    assert.equal(response.source, 'aviationstack');
    assert.equal(response.flights.length, 5, '0 falls back to the default limit of 30');
  });

  it('keeps normal positive limits working', async () => {
    const { response } = await call(2);
    assert.equal(response.source, 'aviationstack');
    assert.equal(response.flights.length, 2);
    assert.deepEqual(response.flights.map(f => f.flightNumber), ['TK1', 'TK2']);
  });
});
