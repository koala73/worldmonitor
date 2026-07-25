// Regression tests for #5554: the HAPI sweep's circuit breaker.
//
// fetchAllHumanitarianSummaries() aborts the per-country HAPI sweep after
// HAPI_MAX_CONSECUTIVE_FAILURES consecutive failures, counting ANY failure type
// (429, other HTTP errors, network/timeout) -- not just 429. An earlier version
// only counted 429s and reset the streak on any other failure type, so a mixed
// pattern like 429/timeout/429/timeout never tripped the breaker at all, defeating
// the whole point of bounding worst-case sweep time (review finding on #5554).
//
// fetchHapiSummary/fetchAllHumanitarianSummaries aren't exported, so these tests
// drive the breaker indirectly through fetchAll() and count HAPI-bound fetch calls.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAll } from '../scripts/seed-conflict-intel.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  ACLED_EMAIL: process.env.ACLED_EMAIL,
  ACLED_PASSWORD: process.env.ACLED_PASSWORD,
  ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN,
};

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete process.env.ACLED_EMAIL;
  delete process.env.ACLED_PASSWORD;
  delete process.env.ACLED_ACCESS_TOKEN;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

// A fast GDELT stub so these tests exercise only the HAPI sweep's timing, not
// GDELT's own (much slower, curl-proxy-involving) fallback path.
const FAST_GDELT_FALLBACK = async () => ({ events: [], source: 'gdelt' });

test('HAPI sweep aborts after 3 consecutive failures of the SAME type (429)', async () => {
  let hapiCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('hapi.humdata.org')) {
      hapiCalls++;
      return new Response('rate limited', { status: 429 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  await fetchAll({ fetchGdeltFallback: FAST_GDELT_FALLBACK });

  assert.equal(hapiCalls, 3, 'sweep should stop after exactly 3 consecutive HAPI failures, not attempt every country');
});

test('HAPI sweep aborts after 3 consecutive failures of MIXED types (429, timeout, 500)', async () => {
  let hapiCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('hapi.humdata.org')) {
      hapiCalls++;
      if (hapiCalls === 1) return new Response('rate limited', { status: 429 });
      if (hapiCalls === 2) throw new Error('fetch failed: network timeout');
      return new Response('server error', { status: 500 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  await fetchAll({ fetchGdeltFallback: FAST_GDELT_FALLBACK });

  assert.equal(
    hapiCalls, 3,
    'a mixed failure pattern (429 -> timeout -> 500) must still trip the breaker at 3 -- ' +
    'this is the exact bug: an earlier version only counted 429s and reset on any other ' +
    'failure type, so this pattern never aborted',
  );
});

test('HAPI sweep streak resets on an intervening success, allowing more attempts', async () => {
  let hapiCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('hapi.humdata.org')) {
      hapiCalls++;
      // fail, fail, SUCCEED (empty data), fail, fail, fail -> breaker should only
      // trip on the second run of 3, i.e. after the 6th HAPI call, not the 3rd.
      if (hapiCalls === 3) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response('server error', { status: 500 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  await fetchAll({ fetchGdeltFallback: FAST_GDELT_FALLBACK });

  assert.equal(
    hapiCalls, 6,
    'a success between two failure runs must reset the streak, so the breaker only trips ' +
    'on the second run of 3 consecutive failures (call #6), not the first (call #3)',
  );
});
