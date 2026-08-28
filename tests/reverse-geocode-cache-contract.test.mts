import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ServerContext } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server.ts';
import { ApiError } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { __resetRateLimitForTest as resetServerRateLimit } from '../server/_shared/rate-limit.ts';
import { reverseGeocode } from '../server/worldmonitor/infrastructure/v1/reverse-geocode.ts';
import edgeReverseGeocode from '../api/reverse-geocode.js';
import { __resetRateLimitForTest as resetEdgeRateLimit } from '../api/_rate-limit.js';
import { GEOCODE_CACHE_DECIMALS, geocodeCacheCell, geocodeCacheKey } from '../shared/geocode-cache-key.js';
import {
  GEOCODE_CACHE_DECIMALS as edgeDecimals,
  geocodeCacheCell as edgeGeocodeCacheCell,
  geocodeCacheKey as edgeGeocodeCacheKey,
} from '../api/_geocode-cache-key.js';
import {
  __resetReverseGeocodeCacheForTests,
  reverseGeocode as reverseGeocodeBrowser,
} from '../src/utils/reverse-geocode.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const context = {} as ServerContext;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface LimiterWire {
  keys: string[];
  limit: number;
}

function readLimiterWire(init?: RequestInit): LimiterWire | null {
  let parsed: unknown;
  try { parsed = JSON.parse(String(init?.body)); } catch { return null; }
  const candidate = parsed as unknown[];
  const command = Array.isArray(candidate?.[0]) ? candidate[0] as unknown[] : candidate;
  if (!Array.isArray(command) || !['eval', 'evalsha'].includes(String(command[0]).toLowerCase())) return null;
  const numKeys = Number(command[2]);
  const rest = command.slice(3);
  return {
    keys: rest.slice(0, numKeys).filter((key): key is string => typeof key === 'string'),
    limit: Number(rest[numKeys]),
  };
}

function limiterReply(remaining: number, limit: number): Response {
  return json([{ result: [remaining, limit] }]);
}

function allowLimiter(init?: RequestInit): Response {
  const wire = readLimiterWire(init);
  assert.ok(wire, 'expected an Upstash limiter command');
  return limiterReply(wire.limit - 1, wire.limit);
}

function configurePreviewRedis(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafebabe';
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetKeyPrefixCacheForTests();
  resetServerRateLimit();
  resetEdgeRateLimit();
  __resetReverseGeocodeCacheForTests();
});

describe('reverse-geocode shared cache contract', () => {
  it('reads the edge route deployment-scoped key in preview and normalizes its value', async () => {
    configurePreviewRedis();
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      assert.equal(
        url,
        'https://redis.example.test/get/preview%3Adeadbeef%3Ageocode%3A40.700%2C-74.000',
        'the gateway RPC must read the same preview key as the edge route',
      );
      return json({ result: JSON.stringify({
        country: 'United States',
        code: 'US',
        displayName: 'New York, United States',
        error: '',
      }) });
    }) as typeof fetch;

    const result = await reverseGeocode(context, { lat: 40.7, lon: -74.0 });

    assert.deepEqual(result, {
      country: 'United States',
      code: 'US',
      displayName: 'New York, United States',
      error: '',
    });
    assert.equal(urls.length, 1, 'a shared cache hit must not reach Nominatim');
  });

  it('writes the complete shared value to the deployment-scoped key in preview', async () => {
    configurePreviewRedis();
    const redisCommands: unknown[] = [];
    let nominatimCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.example.test/get/')) {
        assert.equal(url, 'https://redis.example.test/get/preview%3Adeadbeef%3Ageocode%3A0.000%2C-150.000');
        return json({ result: null });
      }
      if (url === 'https://redis.example.test/pipeline') return allowLimiter(init);
      if (url === 'https://redis.example.test/') {
        redisCommands.push(JSON.parse(String(init?.body)));
        return json({ result: 'OK' });
      }
      assert.match(url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
      nominatimCalls += 1;
      return json({ display_name: '' });
    }) as typeof fetch;

    const result = await reverseGeocode(context, { lat: 0, lon: -150 });

    assert.deepEqual(result, { country: '', code: '', displayName: '', error: '' });
    assert.equal(nominatimCalls, 1);
    assert.deepEqual(redisCommands, [[
      'SET',
      'preview:deadbeef:geocode:0.000,-150.000',
      JSON.stringify({ country: '', code: '', displayName: '', error: '' }),
      'EX',
      '604800',
    ]]);
  });

  it('does not reuse a 0.1-degree cache cell across a country border (#7279)', async () => {
    // US/Canada 49th parallel. Both points round to geocode:49.0,-97.0 under
    // the former toFixed(1) identity, so whichever Nominatim miss filled the
    // cell first poisoned the other country for the 7-day TTL.
    const southOfParallel = { lat: 48.96, lon: -97.04 };
    const northOfParallel = { lat: 49.04, lon: -97.04 };
    assert.equal(southOfParallel.lat.toFixed(1), '49.0');
    assert.equal(northOfParallel.lat.toFixed(1), '49.0');
    assert.equal(southOfParallel.lon.toFixed(1), '-97.0');
    assert.equal(northOfParallel.lon.toFixed(1), '-97.0');

    configurePreviewRedis();
    const store = new Map<string, string>();
    const nominatimUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.example.test/get/')) {
        const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
        const value = store.get(key);
        return json({ result: value ?? null });
      }
      if (url === 'https://redis.example.test/pipeline') return allowLimiter(init);
      if (url === 'https://redis.example.test/') {
        const command = JSON.parse(String(init?.body)) as unknown[];
        if (command[0] === 'SET' && typeof command[1] === 'string' && typeof command[2] === 'string') {
          store.set(command[1], command[2]);
        }
        return json({ result: 'OK' });
      }
      assert.match(url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
      nominatimUrls.push(url);
      const parsed = new URL(url);
      const lat = Number(parsed.searchParams.get('lat'));
      if (lat >= 49) {
        return json({
          address: { country: 'Canada', country_code: 'ca' },
          display_name: 'Manitoba, Canada',
        });
      }
      return json({
        address: { country: 'United States', country_code: 'us' },
        display_name: 'North Dakota, United States',
      });
    }) as typeof fetch;

    const us = await reverseGeocode(context, southOfParallel);
    const canada = await reverseGeocode(context, northOfParallel);

    assert.deepEqual(us, {
      country: 'United States',
      code: 'US',
      displayName: 'North Dakota, United States',
      error: '',
    });
    assert.deepEqual(canada, {
      country: 'Canada',
      code: 'CA',
      displayName: 'Manitoba, Canada',
      error: '',
    });
    assert.equal(nominatimUrls.length, 2, 'each side of the border must miss independently');
    assert.equal(
      store.has('preview:deadbeef:geocode:49.0,-97.0'),
      false,
      'the former 0.1-degree cell must not be the cache identity',
    );
    assert.equal(
      store.get(`preview:deadbeef:${geocodeCacheKey(southOfParallel.lat, southOfParallel.lon)}`),
      JSON.stringify({
        country: 'United States',
        code: 'US',
        displayName: 'North Dakota, United States',
        error: '',
      }),
    );
    assert.equal(
      store.get(`preview:deadbeef:${geocodeCacheKey(northOfParallel.lat, northOfParallel.lon)}`),
      JSON.stringify({
        country: 'Canada',
        code: 'CA',
        displayName: 'Manitoba, Canada',
        error: '',
      }),
    );
  });

  it('shares one provider bucket across distinct callers and both routes', async () => {
    configurePreviewRedis();
    let providerBucketConsumed = false;
    let nominatimCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.example.test/get/')) return json({ result: null });
      if (url === 'https://redis.example.test/pipeline') {
        const wire = readLimiterWire(init);
        if (!wire) {
          const commands = JSON.parse(String(init?.body)) as unknown[];
          return json(commands.map(() => ({ result: 'OK' })));
        }
        const isProviderBucket = wire.keys.some((key) => key.includes('rl:scope:reverse-geocode:global'));
        if (!isProviderBucket) return limiterReply(wire.limit - 1, wire.limit);
        if (providerBucketConsumed) return limiterReply(-1, 1);
        providerBucketConsumed = true;
        return limiterReply(0, 1);
      }
      if (url === 'https://redis.example.test/') return json({ result: 'OK' });
      if (url.startsWith('https://nominatim.openstreetmap.org/reverse?')) {
        nominatimCalls += 1;
        return json({ address: { country: 'United States', country_code: 'us' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const waited: Promise<unknown>[] = [];
    const edgeCtx = { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); } };
    const first = await edgeReverseGeocode(new Request(
      'https://worldmonitor.app/api/reverse-geocode?lat=40.700&lon=-74.000',
      { headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': '198.51.100.10' } },
    ), edgeCtx);
    const second = await edgeReverseGeocode(new Request(
      'https://worldmonitor.app/api/reverse-geocode?lat=34.052&lon=-118.244',
      { headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': '198.51.100.11' } },
    ), edgeCtx);
    await Promise.all(waited);

    assert.equal(first.status, 200);
    assert.equal(second.status, 429, 'a distinct caller IP must share the provider-wide bucket');
    await assert.rejects(
      reverseGeocode(context, { lat: 51.507, lon: -0.128 }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 429,
      'the gateway RPC must observe the bucket consumed by the edge route',
    );
    assert.equal(nominatimCalls, 1, 'only the first aggregate cache miss may reach Nominatim');
  });

  it('fails closed on a gateway cache miss when limiter storage is unavailable', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetKeyPrefixCacheForTests();
    let nominatimCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('nominatim')) nominatimCalls += 1;
      return json({ result: null });
    }) as typeof fetch;

    await assert.rejects(
      reverseGeocode(context, { lat: 40.7, lon: -74 }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 503,
    );
    assert.equal(nominatimCalls, 0);
  });
});

describe('reverse-geocode cache identity helper', () => {
  it('gives distinct keys to coordinates that shared a former 0.1-degree cell', () => {
    const south = { lat: 48.96, lon: -97.04 };
    const north = { lat: 49.04, lon: -97.04 };
    assert.equal(south.lat.toFixed(1), north.lat.toFixed(1));
    assert.equal(south.lon.toFixed(1), north.lon.toFixed(1));
    assert.equal(geocodeCacheKey(south.lat, south.lon), 'geocode:48.960,-97.040');
    assert.equal(geocodeCacheKey(north.lat, north.lon), 'geocode:49.040,-97.040');
    assert.notEqual(geocodeCacheCell(south.lat, south.lon), geocodeCacheCell(north.lat, north.lon));
  });

  it('keeps the Edge mirror identical to the shared helper', async () => {
    const samples = [
      [40.7, -74],
      [0, -150],
      [48.96, -97.04],
      [49.04, -97.04],
      [-89.999, 179.999],
    ];
    assert.equal(edgeDecimals, GEOCODE_CACHE_DECIMALS);
    for (const [lat, lon] of samples) {
      assert.equal(edgeGeocodeCacheCell(lat, lon), geocodeCacheCell(lat, lon));
      assert.equal(edgeGeocodeCacheKey(lat, lon), geocodeCacheKey(lat, lon));
    }

    const edgeRoute = await import('node:fs/promises').then((fs) => (
      fs.readFile(new URL('../api/reverse-geocode.js', import.meta.url), 'utf8')
    ));
    assert.match(edgeRoute, /from '\.\/_geocode-cache-key\.js'/);
    assert.doesNotMatch(edgeRoute, /from '\.\.\/shared\//);
  });
});

describe('browser reverse-geocode memoization', () => {
  it('does not reuse a former 0.1-degree cell across a country border', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const parsed = new URL(url, 'https://worldmonitor.app');
      const lat = Number(parsed.searchParams.get('lat'));
      if (lat >= 49) {
        return json({ country: 'Canada', code: 'CA', displayName: 'Manitoba, Canada' });
      }
      return json({ country: 'United States', code: 'US', displayName: 'North Dakota, United States' });
    }) as typeof fetch;

    const us = await reverseGeocodeBrowser(48.96, -97.04);
    const canada = await reverseGeocodeBrowser(49.04, -97.04);

    assert.deepEqual(us, {
      country: 'United States',
      code: 'US',
      displayName: 'North Dakota, United States',
    });
    assert.deepEqual(canada, {
      country: 'Canada',
      code: 'CA',
      displayName: 'Manitoba, Canada',
    });
    assert.equal(urls.length, 2, 'each side of the border must miss the in-memory cell cache');
  });
});
