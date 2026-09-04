/**
 * The three AviationStack-metered routes must require identity; the seeded
 * aviation surface must stay anonymous.
 *
 * Why identity and not an edge heuristic: in August 2026 one scripted client
 * took ~1,000 paid AviationStack calls/day (~43% of spend) from these three
 * anonymous routes. A Cloudflare rule blocking bot-like user agents missed it
 * because it rotated six real browser UAs, and a Vercel IP rule could not match
 * because Cloudflare fronts the domain. Both guessed at intent. This checks
 * identity, which is not spoofable, at the place the request is served.
 *
 * The second half matters as much as the first: over-gating would take the
 * airport-delay layer off the free map for no saving at all, because that data
 * comes from `aviation:delays:intl:v3` which the cron seeder already bought.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listAirportFlights } from '../server/worldmonitor/aviation/v1/list-airport-flights.ts';
import { getCarrierOps } from '../server/worldmonitor/aviation/v1/get-carrier-ops.ts';
import { getFlightStatus } from '../server/worldmonitor/aviation/v1/get-flight-status.ts';
import { listAirportDelays } from '../server/worldmonitor/aviation/v1/list-airport-delays.ts';
import { getAirportOpsSummary } from '../server/worldmonitor/aviation/v1/get-airport-ops-summary.ts';
import { searchFlightPrices } from '../server/worldmonitor/aviation/v1/search-flight-prices.ts';

const ENV_KEYS = [
  'AVIATIONSTACK_MONTHLY_BUDGET',
  'AVIATIONSTACK_REQUEST_BUDGET',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'WORLDMONITOR_VALID_KEYS',
  'WS_RELAY_URL',
] as const;

const API_KEY = 'test-enterprise-key';
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
  process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
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

/** Records relay (= paid AviationStack) calls; tolerates entitlement lookups. */
function installFetchMock() {
  const relayUrls: string[] = [];

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://relay.test/aviationstack')) {
      relayUrls.push(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
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
    // Entitlement/Convex probes on the anonymous path: answer, don't explode.
    return new Response(JSON.stringify({}), { status: 404 });
  });

  return relayUrls;
}

function ctx(headers: Record<string, string> = {}) {
  return {
    request: new Request('https://api.worldmonitor.app/api/aviation/v1/x', { headers }),
    pathParams: {},
    headers: {},
  };
}

const anon = () => ctx();
const withKey = () => ctx({ 'X-WorldMonitor-Key': API_KEY });

/** Each metered route, invoked with a request that would otherwise succeed. */
const METERED = [
  {
    name: 'list-airport-flights',
    call: (c: ReturnType<typeof ctx>) =>
      listAirportFlights(c, { airport: 'IST', direction: 'FLIGHT_DIRECTION_DEPARTURE', limit: 30 }),
  },
  {
    name: 'get-carrier-ops',
    call: (c: ReturnType<typeof ctx>) =>
      getCarrierOps(c, { airports: ['IST', 'ESB'], minFlights: 0 }),
  },
  {
    name: 'get-flight-status',
    call: (c: ReturnType<typeof ctx>) =>
      getFlightStatus(c, { flightNumber: 'TK1952', date: '2026-08-20', origin: '' }),
  },
];

// TravelPayouts rather than AviationStack, but billed per search all the same,
// and the same scraper was taking 1,607 of its 1,842 anonymous requests.
const METERED_NON_AVSTACK = [
  {
    name: 'search-flight-prices',
    call: (c: ReturnType<typeof ctx>) =>
      searchFlightPrices(c, {
        origin: 'IST', destination: 'LHR', departureDate: '2026-09-01',
        returnDate: '', adults: 1, cabin: 'CABIN_CLASS_ECONOMY', nonstopOnly: false,
      } as never),
  },
];

describe('metered aviation routes require identity', () => {
  for (const route of METERED) {
    it(`${route.name} rejects an anonymous caller and buys nothing`, async () => {
      const relayUrls = installFetchMock();

      await assert.rejects(
        () => route.call(anon()),
        (err: unknown) => {
          const status = (err as { statusCode?: number; status?: number }).statusCode
            ?? (err as { status?: number }).status;
          assert.equal(status, 403, `${route.name} should deny with 403, got ${status}`);
          return true;
        },
        `${route.name} must reject anonymous callers`,
      );

      assert.equal(
        relayUrls.length, 0,
        `${route.name} bought ${relayUrls.length} paid AviationStack call(s) for a request it then denied`,
      );
    });

    it(`${route.name} still serves a caller holding an API key`, async () => {
      const relayUrls = installFetchMock();

      const response = await route.call(withKey()) as { source?: string };

      assert.equal(response.source, 'aviationstack',
        `${route.name} must keep working for authenticated callers`);
      assert.ok(relayUrls.length > 0, `${route.name} should have reached upstream for an authorized caller`);
    });
  }
});

describe('metered non-AviationStack routes require identity too', () => {
  for (const route of METERED_NON_AVSTACK) {
    it(`${route.name} rejects an anonymous caller and buys nothing`, async () => {
      const relayUrls = installFetchMock();

      await assert.rejects(
        () => route.call(anon()),
        (err: unknown) => {
          const status = (err as { statusCode?: number; status?: number }).statusCode
            ?? (err as { status?: number }).status;
          assert.equal(status, 403, `${route.name} should deny with 403, got ${status}`);
          return true;
        },
        `${route.name} must reject anonymous callers`,
      );
      assert.equal(relayUrls.length, 0, `${route.name} must not reach upstream for a denied request`);
    });

    // This route answers from TravelPayouts (or its demo fallback), not
    // AviationStack, so the contract here is simply that an authorized caller
    // gets past the gate rather than any particular `source` value.
    it(`${route.name} lets an API-key caller through the gate`, async () => {
      installFetchMock();
      const response = await route.call(withKey());
      assert.ok(response, `${route.name} must keep serving authenticated callers`);
    });
  }
});

describe('seeder-backed aviation surface stays anonymous', () => {
  // These read aviation:delays:intl:v3, already paid for by the cron seeder.
  // Gating them would cost the free map its airport-delay layer and save nothing.
  it('list-airport-delays serves an anonymous caller', async () => {
    installFetchMock();
    const response = await listAirportDelays(anon(), {
      region: 'AIRPORT_REGION_UNSPECIFIED',
      minSeverity: 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED',
      pageSize: 0,
      cursor: '',
    });
    assert.ok(response, 'list-airport-delays must remain anonymous');
    assert.ok(Array.isArray(response.alerts));
  });

  it('get-airport-ops-summary serves an anonymous caller', async () => {
    installFetchMock();
    const response = await getAirportOpsSummary(anon(), { airports: ['IST'] });
    assert.ok(response, 'get-airport-ops-summary must remain anonymous');
    assert.ok(Array.isArray(response.summaries));
  });
});
