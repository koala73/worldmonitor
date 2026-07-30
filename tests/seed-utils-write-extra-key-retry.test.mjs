// Regression tests for transient-Redis retry on writeExtraKey.
//
// seed-gdelt-intel (and other seeders) call writeExtraKey in afterPublish for
// auxiliary timeline keys. A single Upstash latency spike / timeout on that
// SET would previously crash the whole seeder run with:
//   FATAL: The operation was aborted due to timeout
// The helper should retry transient network/5xx/timeout errors and only fail
// fast on permanent 4xx (auth, payload-too-large, etc.), mirroring the
// redisCommand / atomicPublish contract.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { writeExtraKey } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function buildResponse({ ok = true, status = 200, body = { result: 'OK' }, headers = {} }) {
  return { ok, status, json: async () => body, headers };
}

test('writeExtraKey: retries on timeout and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'AbortError';
      throw err;
    }
    return buildResponse({ ok: true, status: 200 });
  };

  await writeExtraKey('gdelt:intel:tone:military', { data: [], fetchedAt: '2026-07-17T00:00:00.000Z' }, 600);
  assert.equal(calls, 2, 'must retry once after timeout');
});

test('writeExtraKey: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return buildResponse({ ok: false, status: 503 });
    return buildResponse({ ok: true, status: 200 });
  };

  await writeExtraKey('gdelt:intel:vol:military', { data: [], fetchedAt: '2026-07-17T00:00:00.000Z' }, 600);
  assert.equal(calls, 2, 'must retry once after 503');
});

test('writeExtraKey: retries on 429 honoring Retry-After', async () => {
  let calls = 0;
  const sleeps = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms) => {
    sleeps.push(ms);
    queueMicrotask(cb);
    return 0;
  };
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return buildResponse({ ok: false, status: 429, headers: { 'retry-after': '2' } });
    }
    return buildResponse({ ok: true, status: 200 });
  };

  try {
    await writeExtraKey('gdelt:intel:tone:cyber', { data: [], fetchedAt: '2026-07-17T00:00:00.000Z' }, 600);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(calls, 2, 'must retry once after 429');
  assert.ok(sleeps.some(ms => ms >= 2000), 'Retry-After hint must be honored');
});

test('writeExtraKey: fails fast on permanent 4xx without retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 401 });
  };

  await assert.rejects(
    () => writeExtraKey('gdelt:intel:tone:nuclear', { data: [], fetchedAt: '2026-07-17T00:00:00.000Z' }, 600),
    /HTTP 401/,
  );
  assert.equal(calls, 1, 'must not retry permanent 401');
});

test('writeExtraKey: still throws after exhausting retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return buildResponse({ ok: false, status: 503 });
  };

  await assert.rejects(
    () => writeExtraKey('gdelt:intel:tone:sanctions', { data: [], fetchedAt: '2026-07-17T00:00:00.000Z' }, 600),
    /HTTP 503/,
  );
  assert.equal(calls, 3, 'default retry count should be 2 (3 total attempts)');
});
