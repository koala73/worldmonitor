// Regression test for PR #3078: strict-floor validators must not poison
// seed-meta on validation failure when opts.emptyDataIsFailure is set.
//
// Without this guarantee, a single transient empty fetch would refresh
// seed-meta with fetchedAt=now, locking bundle runners out of retry for a
// full interval (30 days for the IMF extended bundle).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSeed } from '../scripts/_seed-utils.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

let recordedCalls;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  recordedCalls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
    recordedCalls.push({ url: String(url), method: opts?.method || 'GET', body });
    // Lock acquire: SET NX returns OK. Pipeline (EXPIRE) returns array. Default: OK.
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  // runSeed's skipped path calls process.exit(0). Convert to a throw so the
  // test can proceed after the seed "finishes" and inspect recorded calls.
  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
});

function countMetaSets(resourceSuffix) {
  return recordedCalls.filter(c =>
    Array.isArray(c.body)
    && c.body[0] === 'SET'
    && typeof c.body[1] === 'string'
    && c.body[1] === `seed-meta:test:${resourceSuffix}`,
  ).length;
}

async function runWithExitTrap(fn) {
  try {
    await fn();
  } catch (err) {
    if (!String(err.message).startsWith('__test_exit__:')) throw err;
  }
}

test('validation failure with emptyDataIsFailure:true does NOT refresh seed-meta', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'empty-fail', 'test:empty-fail:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10, // always fails for empty
      emptyDataIsFailure: true,
      ttlSeconds: 3600,
    }),
  );

  assert.equal(
    countMetaSets('empty-fail'), 0,
    'seed-meta must NOT be SET on validation-fail when emptyDataIsFailure is true; ' +
    'refreshing fetchedAt here would mask outages and block bundle retries',
  );
});

test('validation failure WITHOUT emptyDataIsFailure DOES refresh seed-meta (quiet-period feeds)', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'empty-legacy', 'test:empty-legacy:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10,
      ttlSeconds: 3600,
    }),
  );

  assert.ok(
    countMetaSets('empty-legacy') >= 1,
    'legacy behavior for quiet-period feeds (news, events) must still write ' +
    'seed-meta count=0 so health does not false-positive STALE_SEED',
  );
});
