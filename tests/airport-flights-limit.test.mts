// A negative limit used to reach flights.slice(0, limit). Array.slice counts a
// negative end from the tail, so limit -2 on five flights returned the first
// three. Non-positive limits use the default page of 30, the same rule as the
// other list handlers. Zero is the proto unset value.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import { __resetFetcherTimeoutForTests } from '../server/_shared/redis.ts';

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

function installDepartures(count: number) {
  const store = new Map<string, string>();
  const departures = Array.from({ length: count }, (_, index) => {
    const minute = String(index).padStart(2, '0');
    return {
      flight: { iata: `F${index + 1}` },
      airline: { iata: 'TK', name: 'TK' },
      departure: { iata: 'IST', scheduled: `2026-08-27T10:${minute}:00+00:00` },
      arrival: { iata: 'JFK', scheduled: `2026-08-27T18:${minute}:00+00:00` },
      flight_status: 'scheduled',
    };
  });

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.test/get/'.length));
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }
    if (url === 'https://redis.test/pipeline') {
      return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
    }
    if (url === 'https://redis.test/') {
      const [, key, payload] = JSON.parse(String(init?.body ?? '[]')) as [string, string, string];
      store.set(key, payload);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://relay.test/aviationstack')) {
      return new Response(JSON.stringify({ data: departures }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function requestFor(path: string): Request {
  return new Request(`https://worldmonitor.app${path}`, {
    headers: { 'X-WorldMonitor-Key': 'test-key' },
  });
}

async function board(count: number, limit: number) {
  installDepartures(count);
  return listAirportFlights(
    { request: requestFor('/api/aviation/v1/list-airport-flights?airport=IST&direction=FLIGHT_DIRECTION_DEPARTURE'), pathParams: {}, headers: {} } as never,
    { airport: 'IST', direction: 'FLIGHT_DIRECTION_DEPARTURE', limit } as never,
  );
}

describe('listAirportFlights limit', () => {
  it('does not drop the tail when limit is negative', async () => {
    const response = await board(5, -2);

    assert.equal(response.source, 'aviationstack');
    assert.equal(response.totalAvailable, 5);
    assert.deepEqual(response.flights.map((flight) => flight.flightNumber), ['F1', 'F2', 'F3', 'F4', 'F5']);
  });

  it('uses the default page of 30 for a negative limit and for zero', async () => {
    for (const limit of [-2, 0]) {
      const response = await board(40, limit);
      assert.equal(response.totalAvailable, 40, `limit ${limit}`);
      assert.deepEqual(
        response.flights.map((flight) => flight.flightNumber),
        Array.from({ length: 30 }, (_, index) => `F${index + 1}`),
        `limit ${limit}`,
      );
    }
  });

  it('returns the requested count for a normal positive limit', async () => {
    const response = await board(5, 2);

    assert.equal(response.totalAvailable, 5);
    assert.deepEqual(response.flights.map((flight) => flight.flightNumber), ['F1', 'F2']);
  });
});
