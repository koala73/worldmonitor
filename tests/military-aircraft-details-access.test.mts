import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAircraftDetails } from '../server/worldmonitor/military/v1/get-aircraft-details.ts';
import { getAircraftDetailsBatch } from '../server/worldmonitor/military/v1/get-aircraft-details-batch.ts';
import { _resetTrackedAircraftCacheForTests } from '../server/worldmonitor/military/v1/_tracked-aircraft.ts';
import { sidecarCacheSet } from '../server/_shared/sidecar-cache.ts';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation.ts';
import { validationFailure } from './helpers/validation-failure.mts';

const AIRCRAFT_DETAILS_PATH = '/api/military/v1/get-aircraft-details';
const BATCH_PATH = '/api/military/v1/get-aircraft-details-batch';
const API_KEY = 'test-enterprise-key';
const ENV_KEYS = [
  'WINGBITS_API_KEY',
  'WORLDMONITOR_VALID_KEYS',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LOCAL_API_MODE',
] as const;
const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetTrackedAircraftCacheForTests();
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

function ctx(headers: Record<string, string> = {}) {
  return {
    request: new Request(`https://api.worldmonitor.app${AIRCRAFT_DETAILS_PATH}?icao24=a835af`, { headers }),
    pathParams: {},
    headers: {},
  };
}

describe('Wingbits aircraft-details access contract', () => {
  it('uses the same 30/min fail-closed policy as the batch route', () => {
    assert.deepEqual(ENDPOINT_RATE_POLICIES[AIRCRAFT_DETAILS_PATH], { limit: 30, window: '60 s' });
    assert.equal(
      FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED[AIRCRAFT_DETAILS_PATH]?.reason,
      'Single aircraft enrichment proxies the external Wingbits provider on cache miss.',
    );
    assert.deepEqual(ENDPOINT_RATE_POLICIES[BATCH_PATH], { limit: 30, window: '60 s' });
  });

  it('requires identity before an anonymous request can reach Wingbits', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    globalThis.fetch = async () => {
      throw new Error('anonymous aircraft-details request reached a downstream fetch');
    };

    await assert.rejects(
      () => getAircraftDetails(ctx(), { icao24: 'a835af' }),
      (error: unknown) => {
        const status = (error as { statusCode?: number }).statusCode;
        assert.equal(status, 403);
        return true;
      },
    );
  });

  it('keeps an API-key caller working and forwards the Wingbits credential upstream', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    const calls: Array<{ url: string; apiKey: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, apiKey: new Headers(init?.headers).get('x-api-key') });
      assert.match(url, /customer-api\.wingbits\.com\/v1\/flights\/details\/a835af$/);
      return Response.json({
        registration: 'N123WM',
        manufacturerName: 'World Monitor Aerospace',
        model: 'WM-1',
      });
    };

    const response = await getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'a835af' });

    assert.equal(response.configured, true);
    assert.equal(response.details?.registration, 'N123WM');
    assert.deepEqual(calls, [{
      url: 'https://customer-api.wingbits.com/v1/flights/details/a835af',
      apiKey: 'test-wingbits-key',
    }]);
  });

  it('rejects non-ICAO input before a paid cache miss', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    globalThis.fetch = async () => {
      throw new Error('invalid aircraft-details input reached a downstream fetch');
    };

    await assert.rejects(
      () => getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'not-an-icao24' }),
      validationFailure('icao24', /^icao24 must be a 6-character hexadecimal address$/),
    );
  });

  it('declares the ICAO24 shape in the generated contract, not just the handler', () => {
    // The proto carries `string.pattern` for GetAircraftDetailsRequest.icao24,
    // so the generated validator (wired at gateway.ts:112) rejects a malformed
    // address before the handler runs and the published OpenAPI advertises the
    // rule. Without it the contract says "any non-empty string" while the
    // server 400s — every client pays a round-trip to discover the real shape.
    const rules = GENERATED_MESSAGE_RULES as Record<string, {
      fields?: Record<string, { stringPattern?: string }>;
    }>;
    const icao24Rule = Object.entries(rules)
      .find(([name]) => name.endsWith('GetAircraftDetailsRequest'))?.[1]?.fields?.icao24;

    assert.ok(icao24Rule, 'expected a generated validation rule for GetAircraftDetailsRequest.icao24');
    assert.equal(
      icao24Rule.stringPattern, '^[0-9a-fA-F]{6}$',
      'the ICAO24 shape must stay declared in proto — dropping it back to min_len '
      + 'silently loosens the published contract and the client-side validator',
    );
  });

  it('registers only the singular route for premium browser credential injection', () => {
    assert.equal(PREMIUM_RPC_PATHS.has(AIRCRAFT_DETAILS_PATH), true);
    assert.equal(PREMIUM_RPC_PATHS.has(BATCH_PATH), false);
    // The browser half of this contract — that the military client actually
    // attaches the Bearer on the singular path and not on the batch path — is
    // proven by executing a real call in
    // tests/military-premium-bearer-wiring.test.mts, not by matching source
    // text here. A regex over the file can go green while the wiring is dead.
  });

  it('normalizes input to the same shape the batch sibling does', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ registration: 'N123WM' });
    };

    // Handler-level contract only. This calls the handler directly, so it
    // deliberately bypasses the generated request validator that the gateway
    // runs first — on the gateway path the proto `string.pattern` rejects a
    // whitespace-padded address before the handler is reached. What is pinned
    // here is that the two sibling handlers agree on normalization for the
    // callers that do reach them: pre-fix this validated the RAW value, so
    // ' A835AF ' 400'd here while the batch route trimmed and looked it up.
    const response = await getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: ' A835AF ' });

    assert.equal(response.details?.registration, 'N123WM');
    assert.deepEqual(urls, ['https://customer-api.wingbits.com/v1/flights/details/a835af']);
  });
});

describe('Wingbits aircraft-details batch input contract', () => {
  it('never sends a malformed address to the paid provider', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ registration: 'N123WM' });
    };

    const response = await getAircraftDetailsBatch(ctx(), {
      icao24s: ['a835af', 'not-hex', 'zzzzzz', 'a835a', '../../status'],
    });

    // Only the one well-formed address may reach Wingbits or a Redis key.
    // Reverting the shape filter to `id.length > 0` interpolates the rest
    // straight into the upstream URL path.
    assert.deepEqual(urls, ['https://customer-api.wingbits.com/v1/flights/details/a835af']);
    assert.deepEqual(Object.keys(response.results), ['a835af']);
  });

  it('reports `requested` as a prefix length over the caller keys, not the survivors', async () => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response('null', { status: 404 });
    };

    // src/services/wingbits.ts negative-caches `batchKeys.slice(0, requested)`
    // over its OWN sorted keys, so `requested` is a prefix length, not a count
    // of survivors. Counting only the hex-valid entries shortens the prefix and
    // pushes the trailing VALID key ('bb0002') outside it — it is then never
    // negative-cached and is re-fetched from the paid provider on every refresh.
    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['a', 'aa0001', 'bb0002'] });

    assert.equal(
      response.requested, 3,
      'requested must span every non-empty key the caller sent, or the client '
      + 'negative-cache prefix silently drops valid trailing keys',
    );
    assert.deepEqual(urls, [
      'https://customer-api.wingbits.com/v1/flights/details/aa0001',
      'https://customer-api.wingbits.com/v1/flights/details/bb0002',
    ]);
  });
});

describe('Wingbits aircraft-details batch spend boundary', () => {
  const REDIS_URL = 'https://redis.test';

  // Redis answers the flight snapshot read with `seed` and serves aircraft
  // cache keys from `store` (empty by default), so a lookup made by the
  // singular route is visible to the batch route, as in production. Wingbits
  // URLs are recorded; 'dd0004' is a Wingbits 404 (a cached negative).
  function installFetch(seed: unknown, wingbitsUrls: string[], store = new Map<string, string>()) {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://customer-api.wingbits.com/')) {
        wingbitsUrls.push(url);
        if (url.endsWith('/dd0004')) return new Response('null', { status: 404 });
        return Response.json({ registration: `REG-${url.slice(-6)}` });
      }
      if (url === `${REDIS_URL}/pipeline`) {
        const commands = JSON.parse(String(init?.body ?? '[]')) as string[][];
        return Response.json(commands.map((command) => ({
          result: command[0] === 'GET' ? (store.get(command[1]!) ?? null) : 'OK',
        })));
      }
      if (url === `${REDIS_URL}/get/${encodeURIComponent('military:flights:v1')}`) {
        return Response.json({ result: seed === null ? null : JSON.stringify(seed) });
      }
      if (url.startsWith(`${REDIS_URL}/get/`)) {
        const key = decodeURIComponent(url.slice(`${REDIS_URL}/get/`.length));
        return Response.json({ result: store.get(key) ?? null });
      }
      if (url === `${REDIS_URL}/` && init?.method === 'POST') {
        const command = JSON.parse(String(init.body)) as string[];
        if (command[0] === 'SET') store.set(command[1]!, command[2]!);
      }
      return Response.json({ result: 'OK' });
    };
  }

  beforeEach(() => {
    process.env.WINGBITS_API_KEY = 'test-wingbits-key';
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  });

  it('spends the credential only on aircraft in the published flight snapshot', async () => {
    const urls: string[] = [];
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls);

    // Pre-fix, an anonymous caller could send any ten valid addresses per call
    // and each cache miss was a paid Wingbits lookup, which made the Pro gate
    // on the singular route meaningless.
    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001', 'bb0002', 'cc0003'] });

    assert.deepEqual(urls, ['https://customer-api.wingbits.com/v1/flights/details/aa0001']);
    assert.deepEqual(Object.keys(response.results), ['aa0001']);
    // The client negative-caches `batchKeys.slice(0, requested)` for an hour.
    // A skipped address is not a negative result (the aircraft may have joined
    // the snapshot after the tracked set was read), so the prefix stops before
    // the first one and the client retries it on its next refresh.
    assert.equal(response.requested, 1);
  });

  it('makes no paid lookups when the snapshot cannot be read', async () => {
    const urls: string[] = [];
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls);
    const redisAndWingbits = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(`${REDIS_URL}/get/military%3Aflights`)) {
        return new Response('unavailable', { status: 503 });
      }
      return redisAndWingbits(input, init);
    };

    // An unknown boundary must not fall back to looking up whatever the
    // caller sends.
    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001', 'bb0002'] });

    assert.deepEqual(urls, []);
    assert.equal(response.requested, 0);
  });

  it('makes no paid lookups when both snapshots are confirmed absent', async () => {
    const urls: string[] = [];
    installFetch(null, urls);
    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001', 'bb0002'] });
    assert.deepEqual(urls, []);
    assert.equal(response.requested, 0);
  });

  it('keeps caller-configured enrichment on the authenticated desktop sidecar', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const urls: string[] = [];
    installFetch(null, urls);
    await getAircraftDetailsBatch(ctx(), { icao24s: ['ff0042'] });
    assert.deepEqual(urls, ['https://customer-api.wingbits.com/v1/flights/details/ff0042']);
  });

  // The shared `military:aircraft:v1:<icao24>` keys are also written by the
  // Pro-gated singular route, so a cache HIT is not proof that an address is
  // one the map can show. Pre-fix the snapshot check gated only misses: an
  // anonymous caller read back any address a Pro caller had looked up, and
  // `requested` told it whether a non-snapshot address was cached at all.
  it('withholds a cached record for an aircraft outside the snapshot', async () => {
    const urls: string[] = [];
    const store = new Map<string, string>();
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls, store);
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    const pro = await getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'cc0003' });
    assert.equal(pro.details?.registration, 'REG-cc0003');
    urls.length = 0;

    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['cc0003', 'aa0001'] });

    assert.deepEqual(Object.keys(response.results), ['aa0001']);
    assert.equal(response.requested, 1, 'the prefix stops before the withheld address');
    assert.deepEqual(urls, ['https://customer-api.wingbits.com/v1/flights/details/aa0001']);
  });

  it('does not reveal a cached negative lookup through `requested`', async () => {
    const urls: string[] = [];
    const store = new Map<string, string>();
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls, store);
    process.env.WORLDMONITOR_VALID_KEYS = API_KEY;
    await getAircraftDetails(ctx({ 'X-WorldMonitor-Key': API_KEY }), { icao24: 'dd0004' });
    assert.ok([...store.keys()].some((key) => key.endsWith(':dd0004')), 'the 404 is cached');
    urls.length = 0;

    // An uncached non-snapshot address reports requested 0; a cached one must
    // report the same, or the field is a cache-presence oracle.
    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['dd0004'] });

    assert.equal(response.requested, 0);
    assert.deepEqual(Object.keys(response.results), []);
    assert.deepEqual(urls, []);
  });

  it('withholds cached records when the snapshot cannot be read', async () => {
    const urls: string[] = [];
    const store = new Map<string, string>();
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls, store);
    await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001'] });
    assert.ok([...store.keys()].some((key) => key.endsWith(':aa0001')), 'aa0001 is cached');
    _resetTrackedAircraftCacheForTests();
    urls.length = 0;
    const redisAndWingbits = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(`${REDIS_URL}/get/military%3Aflights`)) {
        return new Response('unavailable', { status: 503 });
      }
      return redisAndWingbits(input, init);
    };

    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001'] });

    assert.deepEqual(Object.keys(response.results), []);
    assert.equal(response.requested, 0);
    assert.deepEqual(urls, []);
  });

  it('still serves a cached record for an aircraft in the snapshot', async () => {
    const urls: string[] = [];
    const store = new Map<string, string>();
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls, store);
    await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001'] });
    _resetTrackedAircraftCacheForTests();
    urls.length = 0;

    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['aa0001'] });

    assert.equal(response.results.aa0001?.registration, 'REG-aa0001');
    assert.equal(response.requested, 1);
    assert.deepEqual(urls, [], 'served from the shared cache');
  });

  it('serves any cached record on the authenticated desktop sidecar', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const urls: string[] = [];
    installFetch({ flights: [{ hexCode: 'AA0001', lat: 1, lon: 2 }] }, urls);
    // The single-user sidecar reads its own in-process cache, not Upstash.
    sidecarCacheSet('military:aircraft:v1:cc0003', { details: { registration: 'REG-cc0003' }, configured: true }, 60);

    const response = await getAircraftDetailsBatch(ctx(), { icao24s: ['cc0003'] });

    assert.equal(response.results.cc0003?.registration, 'REG-cc0003');
    assert.equal(response.requested, 1);
    assert.deepEqual(urls, []);
  });
});
