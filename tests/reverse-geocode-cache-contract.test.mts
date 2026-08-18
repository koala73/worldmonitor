import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ServerContext } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { reverseGeocode } from '../server/worldmonitor/infrastructure/v1/reverse-geocode.ts';

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
        'https://redis.example.test/get/preview%3Adeadbeef%3Ageocode%3A40.7%2C-74.0',
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
        assert.equal(url, 'https://redis.example.test/get/preview%3Adeadbeef%3Ageocode%3A0.0%2C-150.0');
        return json({ result: null });
      }
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
      'preview:deadbeef:geocode:0.0,-150.0',
      JSON.stringify({ country: '', code: '', displayName: '', error: '' }),
      'EX',
      '604800',
    ]]);
  });
});
