/**
 * get-carrier-ops must not let one request buy an unbounded number of paid
 * AviationStack calls.
 *
 * The route fans out to `listAirportFlights` once PER AIRPORT, and
 * `parseStringArray` puts no bound on `req.airports` — it just splits a comma
 * separated string. So `?airports=A,B,...,Z` was 26 paid AviationStack calls
 * from a single anonymous request, against a 50,000/cycle plan.
 *
 * These tests count the actual relay calls the handler issues, so they fail if
 * the cap is removed, raised past the ceiling, or applied after the fan-out
 * instead of before it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { getCarrierOps } from '../server/worldmonitor/aviation/v1/get-carrier-ops.ts';
import {
  DEFAULT_WATCHED_AIRPORTS,
  MAX_AIRPORTS_PER_REQUEST,
} from '../server/worldmonitor/aviation/v1/_shared.ts';

const ENV_KEYS = [
  'AVIATIONSTACK_MONTHLY_BUDGET',
  'AVIATIONSTACK_REQUEST_BUDGET',
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
  process.env.WS_RELAY_URL = 'https://relay.test';
  process.env.AVIATIONSTACK_MONTHLY_BUDGET = '0';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
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

/** Records every AviationStack relay URL the handler reaches for. */
function installFetchMock() {
  const relayUrls: string[] = [];

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // Every cache read misses, so each airport that survives the cap issues a
    // real relay call — the thing being counted.
    if (url.startsWith('https://redis.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      return new Response(JSON.stringify(commands.map(() => ({ result: 1 }))), { status: 200 });
    }
    if (url === 'https://redis.test/') {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://relay.test/aviationstack')) {
      relayUrls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  return relayUrls;
}

// get-carrier-ops requires identity (see requireLiveAviationAccess); this suite
// is about fan-out size, so it authenticates and lets the auth suite own the gate.
function ctxFor(airports: string[]) {
  const query = airports.map((a) => `airports=${a}`).join('&');
  return {
    request: new Request(`https://worldmonitor.app/api/aviation/v1/get-carrier-ops?${query}`, {
      headers: { 'X-WorldMonitor-Key': 'test-key' },
    }),
    pathParams: {},
    headers: {},
  };
}

/** 26 distinct valid IATA-shaped codes — the original amplification example. */
const TWENTY_SIX = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}AA`);

describe('get-carrier-ops paid fan-out is bounded', () => {
  it('buys at most MAX_AIRPORTS_PER_REQUEST calls no matter how many airports are asked for', async () => {
    const relayUrls = installFetchMock();

    await getCarrierOps(ctxFor(TWENTY_SIX), { airports: TWENTY_SIX, minFlights: 0 });

    assert.ok(
      relayUrls.length <= MAX_AIRPORTS_PER_REQUEST,
      `26 airports bought ${relayUrls.length} paid AviationStack calls; cap is ${MAX_AIRPORTS_PER_REQUEST}`,
    );
    assert.equal(relayUrls.length, MAX_AIRPORTS_PER_REQUEST, 'cap should be applied by truncation, not by dropping the request');
  });

  it('still serves the full default watched set in one request', async () => {
    const relayUrls = installFetchMock();

    const response = await getCarrierOps(ctxFor(DEFAULT_WATCHED_AIRPORTS), {
      airports: DEFAULT_WATCHED_AIRPORTS,
      minFlights: 0,
    });

    assert.equal(response.source, 'aviationstack', 'the documented watched set must not be truncated into a partial');
    assert.equal(relayUrls.length, DEFAULT_WATCHED_AIRPORTS.length);
  });

  it('rejects a malformed airport code before buying anything', async () => {
    const relayUrls = installFetchMock();

    const response = await getCarrierOps(ctxFor(['IST', 'NOT-AN-IATA']), {
      airports: ['IST', 'NOT-AN-IATA'],
      minFlights: 0,
    });

    assert.equal(response.source, 'invalid');
    assert.deepEqual(response.carriers, []);
    assert.equal(relayUrls.length, 0, 'a malformed code must not reach the paid API at all');
  });

  it('does not let arbitrary strings through as cache-key material', async () => {
    const relayUrls = installFetchMock();

    // Long junk would otherwise become part of `aviation:carrier-ops:<...>:v1`.
    const junk = Array.from({ length: 40 }, (_, i) => `junk-${i}`);
    const response = await getCarrierOps(ctxFor(junk), { airports: junk, minFlights: 0 });

    assert.equal(response.source, 'invalid');
    assert.equal(relayUrls.length, 0);
  });

  it('falls back to the default subset only when the caller supplied nothing', async () => {
    const relayUrls = installFetchMock();

    const response = await getCarrierOps(ctxFor([]), { airports: [], minFlights: 0 });

    assert.equal(response.source, 'aviationstack');
    assert.ok(relayUrls.length > 0 && relayUrls.length <= MAX_AIRPORTS_PER_REQUEST);
  });
});

describe('get-carrier-ops minFlights default', () => {
  it('treats a decoder-absent 0 as the documented default of 3', async () => {
    // The relay mock is swapped mid-test to return one flight per airport, so
    // a single-flight group must be filtered when min_flights is absent (the
    // generated GET decoder delivers that as minFlights: 0). mock.method
    // cannot re-stub globalThis.fetch twice, so install the single-flight
    // relay variant up front instead of reusing installFetchMock().
    const relayUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.test/get/')) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      if (url === 'https://redis.test/pipeline') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url === 'https://redis.test/') {
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (url.startsWith('https://relay.test/aviationstack')) {
        relayUrls.push(url);
        const u = new URL(url);
        const dep = u.searchParams.get('dep_iata') ?? 'IST';
        return new Response(JSON.stringify({ data: [{
          flight: { iata: 'TK1923', icao: 'THY1923' },
          airline: { name: 'Turkish Airlines', iata: 'TK', icao: 'THY' },
          departure: { airport: 'Istanbul', timezone: 'Europe/Istanbul', iata: dep, icao: 'LTFM', terminal: '1', gate: '1', scheduled: '2026-09-01T10:00:00+00:00' },
          arrival: { airport: 'JFK', timezone: 'America/New_York', iata: 'JFK', icao: 'KJFK', terminal: '1', gate: '1', scheduled: '2026-09-01T14:00:00+00:00' },
          flight_date: '2026-09-01', flight_status: 'scheduled',
        }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const filtered = await getCarrierOps(ctxFor(['IST']), { airports: ['IST'], minFlights: 0 });
    assert.equal(filtered.source, 'aviationstack');
    assert.deepEqual(filtered.carriers, []);

    // A fresh airport code avoids the shared carrier-ops cache entry the
    // filtered call above populated (the cache key carries no minFlights).
    // The single-flight relay serves one group of totalFlights 1, so an
    // explicit minFlights: 1 keeps it while the decoder-absent 0 (default 3)
    // filters it.
    const explicit = await getCarrierOps(ctxFor(['ESB']), { airports: ['ESB'], minFlights: 1 });
    assert.equal(explicit.source, 'aviationstack');
    assert.equal(explicit.carriers.length, 1, 'an explicit minFlights: 1 must keep the single-flight group');
    assert.equal(explicit.carriers[0]?.totalFlights, 1);
  });
});
