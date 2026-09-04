import assert from 'node:assert/strict';
import test from 'node:test';

import { readOrWarmDigest } from '../scripts/seed-insights.mjs';

const NEGATIVE_SENTINEL = '__WM_NEG__';
const ACCEPTED_DIGEST = {
  categories: {
    politics: {
      items: [{ title: 'Accepted last-good story', link: 'https://example.test/story' }],
    },
  },
  coverage: { servedStale: true },
};

function redisResponse(value) {
  return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }));
}

function installDigestFetch(t, redisValues) {
  const previousEnv = {
    apiBaseUrl: process.env.API_BASE_URL,
    redisUrl: process.env.UPSTASH_REDIS_REST_URL,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.API_BASE_URL = 'https://api.example.test';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  t.after(() => {
    for (const [name, value] of Object.entries({
      API_BASE_URL: previousEnv.apiBaseUrl,
      UPSTASH_REDIS_REST_URL: previousEnv.redisUrl,
      UPSTASH_REDIS_REST_TOKEN: previousEnv.redisToken,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const calls = [];
  let redisRead = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://redis.example.test/get/')) {
      const value = redisValues[Math.min(redisRead, redisValues.length - 1)];
      redisRead += 1;
      return redisResponse(value);
    }
    if (url.startsWith('https://api.example.test/api/news/v1/list-feed-digest')) {
      return new Response(JSON.stringify(ACCEPTED_DIGEST));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    callback();
    return 0;
  });
  return calls;
}

test('a digest negative-cache sentinel is a miss and triggers the warm RPC', async (t) => {
  const calls = installDigestFetch(t, [NEGATIVE_SENTINEL, NEGATIVE_SENTINEL]);

  const digest = await readOrWarmDigest('en');

  assert.deepEqual(digest, ACCEPTED_DIGEST);
  assert.equal(calls.filter(url => url.includes('/list-feed-digest')).length, 1);
});

test('an accepted warm response wins when Redis readback contains the sentinel', async (t) => {
  const calls = installDigestFetch(t, [null, NEGATIVE_SENTINEL]);

  const digest = await readOrWarmDigest('en');

  assert.deepEqual(digest, ACCEPTED_DIGEST);
  assert.deepEqual(calls.map(url => new URL(url).hostname), [
    'redis.example.test',
    'api.example.test',
    'redis.example.test',
  ]);
});
