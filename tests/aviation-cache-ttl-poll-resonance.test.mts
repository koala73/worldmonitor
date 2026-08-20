/**
 * AviationStack cache TTL must outlast a polling client's interval.
 *
 * August 2026: a scraper polling `list-airport-flights` and `get-carrier-ops`
 * every ~5.7 minutes drove both to a ~100% cache-miss rate — 504 of 504
 * requests in one day went upstream — because the Redis TTL was 300s and every
 * poll landed just after the key expired. Measured cost was ~1,000 paid
 * AviationStack calls/day, ~43% of total spend, on top of a 50k/mo plan.
 *
 * The failure is not "the TTL is a wrong number", it is "the TTL is shorter
 * than the interval of the clients that actually call this endpoint", which
 * makes the cache buy nothing while still costing a paid call. So these tests
 * assert the TTL written to Redis clears the observed poll cadence, not that it
 * equals any particular constant — a later bump stays green, a regression to
 * 300s (or anything under the cadence) goes red.
 *
 * The assertions read the TTL off the actual `SET ... EX` the handler issues,
 * so they fail if the constant is lowered OR if a refactor stops threading it
 * through to the Redis write.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import { getCarrierOps } from '../server/worldmonitor/aviation/v1/get-carrier-ops.ts';

/**
 * The cadence that broke production, rounded up. A TTL at or below this leaves
 * a client polling this fast paying for every single request.
 */
const OBSERVED_POLL_INTERVAL_SECONDS = 6 * 60;

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

type PositiveWrite = { key: string; ttlSeconds: number };

/**
 * Relay always answers with a healthy zero-row page, which is the shape
 * cachedFetchJson stores positively. Negative sentinels are filtered out — they
 * carry a deliberately short TTL and are not what this test is about.
 */
function installFetchMock() {
  const positiveWrites: PositiveWrite[] = [];

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.test/get/')) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }

    if (url === 'https://redis.test/pipeline') {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[][];
      return new Response(JSON.stringify(commands.map(() => ({ result: 1 }))), { status: 200 });
    }

    if (url === 'https://redis.test/') {
      const [verb, key, payload, ex, ttl] = JSON.parse(String(init?.body ?? '[]')) as string[];
      if (verb === 'SET' && ex === 'EX' && payload !== '"__WM_NEG__"' && !payload.includes('__WM_NEG__')) {
        positiveWrites.push({ key, ttlSeconds: Number(ttl) });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (url.startsWith('https://relay.test/aviationstack')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  return positiveWrites;
}

// These routes require identity (see requireLiveAviationAccess); this suite is
// about TTL, so it authenticates and lets the auth suite own the gate.
function ctxFor(path: string) {
  return {
    request: new Request(`https://worldmonitor.app${path}`, {
      headers: { 'X-WorldMonitor-Key': 'test-key' },
    }),
    pathParams: {},
    headers: {},
  };
}

function assertOutlastsPolling(write: PositiveWrite | undefined, label: string) {
  assert.ok(write, `${label}: expected a positive Redis SET carrying a TTL`);
  assert.ok(
    write.ttlSeconds > OBSERVED_POLL_INTERVAL_SECONDS,
    `${label}: cached for ${write.ttlSeconds}s, which does not outlast the `
    + `${OBSERVED_POLL_INTERVAL_SECONDS}s polling cadence observed in production — `
    + 'every poll would miss and buy a paid AviationStack call',
  );
}

describe('aviation cache TTL vs. client poll cadence', () => {
  it('caches an airport flight board past the observed poll interval', async () => {
    const writes = installFetchMock();

    const response = await listAirportFlights(ctxFor('/api/aviation/v1/list-airport-flights?airport=AAA'), {
      airport: 'AAA',
      direction: 'FLIGHT_DIRECTION_DEPARTURE',
      limit: 30,
    });

    assert.equal(response.source, 'aviationstack', 'precondition: handler took the positive-cache path');
    assertOutlastsPolling(
      writes.find((w) => w.key.startsWith('aviation:flights:AAA:')),
      'list-airport-flights',
    );
  });

  it('caches a carrier-ops aggregate past the observed poll interval', async () => {
    const writes = installFetchMock();

    const response = await getCarrierOps(ctxFor('/api/aviation/v1/get-carrier-ops?airports=BBB&airports=CCC'), {
      airports: ['BBB', 'CCC'],
      minFlights: 0,
    });

    assert.equal(response.source, 'aviationstack', 'precondition: handler took the positive-cache path');
    assertOutlastsPolling(
      writes.find((w) => w.key.startsWith('aviation:carrier-ops:')),
      'get-carrier-ops',
    );
  });

  /**
   * get-carrier-ops is the expensive one: a miss fans out to listAirportFlights
   * once per airport, so its aggregate TTL expiring early re-buys N airports at
   * once. Its TTL must not be shorter than the per-airport TTL underneath it,
   * or the aggregate churns while its own inputs are still warm.
   */
  it('does not expire the carrier-ops aggregate before the airport boards it is built from', async () => {
    const writes = installFetchMock();

    await getCarrierOps(ctxFor('/api/aviation/v1/get-carrier-ops?airports=DDD'), {
      airports: ['DDD'],
      minFlights: 0,
    });

    const aggregate = writes.find((w) => w.key.startsWith('aviation:carrier-ops:'));
    const child = writes.find((w) => w.key.startsWith('aviation:flights:DDD:'));
    assert.ok(aggregate, 'expected a carrier-ops aggregate write');
    assert.ok(child, 'expected a per-airport child write');
    assert.ok(
      aggregate.ttlSeconds >= child.ttlSeconds,
      `carrier-ops aggregate TTL (${aggregate.ttlSeconds}s) is shorter than its child `
      + `airport TTL (${child.ttlSeconds}s) — the aggregate would re-fan-out while its inputs are still cached`,
    );
  });
});
