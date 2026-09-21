import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  const redis = installRedis({});
  process.env.ICAO_API_KEY = 'configured-but-not-for-public-reads';
  process.env.WS_RELAY_URL = 'https://relay.example';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    throw new Error(`unexpected provider request: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test('public NOTAM loader does not call ICAO when its optional seed is absent', async () => {
  const { loadNotamClosures } = await import('../server/worldmonitor/aviation/v1/_shared.ts');

  assert.deepEqual(await loadNotamClosures(), { data: null, unavailable: false });
});

test('malformed NOTAM seed rows are unavailable', async () => {
  const redis = installRedis({
    'aviation:notam:closures:v2': { closedIcaos: [null], restrictedIcaos: [], reasons: {} },
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    throw new Error(`unexpected provider request: ${url}`);
  }) as typeof fetch;
  const { loadNotamClosures } = await import('../server/worldmonitor/aviation/v1/_shared.ts');
  assert.deepEqual(await loadNotamClosures(), { data: null, unavailable: true });
});
