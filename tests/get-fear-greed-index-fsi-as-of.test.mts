import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { getFearGreedIndex } from '../server/worldmonitor/market/v1/get-fear-greed-index.ts';

const FSI_AS_OF = Date.UTC(2026, 10, 21);
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE'] as const;

const originalFetch = globalThis.fetch;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  delete process.env.LOCAL_API_MODE;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function seedFearGreed(fsi: Record<string, unknown>) {
  const payload = { composite: { score: 42, label: 'Fear' }, headerMetrics: { fsi } };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `https://redis.test/get/${encodeURIComponent('market:fear-greed:v1')}`) {
      return new Response(JSON.stringify({ result: JSON.stringify(payload) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function readIndex() {
  return getFearGreedIndex({} as never, {} as never);
}

test('getFearGreedIndex returns fsiAsOf from the cached FSI header', async () => {
  seedFearGreed({ value: 1.2, label: 'Low Stress', asOf: FSI_AS_OF });
  const response = await readIndex();
  assert.equal(response.unavailable, false);
  assert.equal(response.fsiAsOf, FSI_AS_OF);
});

test('getFearGreedIndex leaves fsiAsOf out when the cached header has no date', async () => {
  seedFearGreed({ value: 1.2, label: 'Low Stress' });
  const response = await readIndex();
  assert.equal(response.unavailable, false);
  assert.equal('fsiAsOf' in response, false);
});
