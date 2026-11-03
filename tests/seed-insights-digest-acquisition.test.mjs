import assert from 'node:assert/strict';
import test from 'node:test';

import { digestItemsForInsights, readOrWarmDigest } from '../scripts/seed-insights.mjs';

const NEGATIVE_SENTINEL = '__WM_NEG__';
const ACCEPTED_DIGEST = {
  categories: {
    politics: {
      items: [{ title: 'Accepted last-good story', link: 'https://example.test/story' }],
    },
  },
  coverage: { servedStale: true },
};
const ACCEPTED_REREAD = {
  categories: {
    politics: {
      items: [{ title: 'Accepted canonical story', link: 'https://example.test/canonical' }],
    },
  },
};

function redisResponse(value) {
  return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }));
}

function installDigestFetch(t, redisValues, warmValue = ACCEPTED_DIGEST) {
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
  let waits = 0;
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
      return new Response(JSON.stringify(warmValue));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    waits += 1;
    callback();
    return 0;
  });
  return { calls, waitCount: () => waits };
}

test('an accepted warm response is returned without a Redis readback', async (t) => {
  const { calls, waitCount } = installDigestFetch(t, [NEGATIVE_SENTINEL]);

  const digest = await readOrWarmDigest('en');

  assert.deepEqual(digest, ACCEPTED_DIGEST);
  assert.deepEqual(calls.map(url => new URL(url).hostname), [
    'redis.example.test',
    'api.example.test',
  ]);
  assert.equal(waitCount(), 0);
});

test('an unacceptable warm response falls back to an accepted Redis readback', async (t) => {
  const { calls, waitCount } = installDigestFetch(t, [null, ACCEPTED_REREAD], {
    categories: { politics: { items: 'not-an-array' } },
  });

  const digest = await readOrWarmDigest('en');

  assert.deepEqual(digest, ACCEPTED_REREAD);
  assert.deepEqual(calls.map(url => new URL(url).hostname), [
    'redis.example.test',
    'api.example.test',
    'redis.example.test',
  ]);
  assert.equal(waitCount(), 1);
});

test('negative sentinels and malformed digests never escape acquisition', async (t) => {
  installDigestFetch(t, [NEGATIVE_SENTINEL, {
    categories: { politics: { items: { length: 1 } } },
  }], NEGATIVE_SENTINEL);

  const digest = await readOrWarmDigest('en');

  assert.equal(digest, null);
});

test('accepted digests ignore malformed category buckets during item extraction', () => {
  const validItem = ACCEPTED_DIGEST.categories.politics.items[0];

  assert.deepEqual(digestItemsForInsights({
    categories: {
      malformed: null,
      politics: { items: [validItem] },
    },
  }), [validItem]);
});
