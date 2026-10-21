import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GRACEFUL_FETCH_FAILURE_EXIT_CODE, runSeed } from '../scripts/_seed-utils.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};
const ORIGINAL_SIGTERM_LISTENERS = new Set(process.rawListeners('SIGTERM'));

let calls;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return Response.json(body.map(() => ({ result: 1 })));
    }
    return Response.json({ result: 'OK' });
  };
  process.exit = (code) => {
    const err = new Error(`__test_exit__:${code}`);
    err.exitCode = code;
    throw err;
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
  for (const listener of process.rawListeners('SIGTERM')) {
    if (!ORIGINAL_SIGTERM_LISTENERS.has(listener)) process.removeListener('SIGTERM', listener);
  }
});

async function trapExit(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (!String(err.message).startsWith('__test_exit__:')) throw err;
    return err.exitCode;
  }
}

function expirePipelines() {
  return calls
    .filter((call) => call.url.endsWith('/pipeline'))
    .map((call) => call.body);
}

test('fetch failure preserves default keys at canonical TTL and groups opt-in keys by declared TTL', async () => {
  const exitCode = await trapExit(() =>
    runSeed('test', 'per-key-ttl', 'test:per-key-ttl:v1', async () => {
      throw Object.assign(new Error('upstream failed'), { nonRetryable: true });
    }, {
      ttlSeconds: 3600,
      extraKeys: [{ key: 'test:per-key-ttl:extra' }],
      preserveKeys: ['test:per-key-ttl:legacy'],
      preserveKeyTtls: [
        { key: 'test:per-key-ttl:daily-a', ttlSeconds: 86_400 },
        { key: 'test:per-key-ttl:daily-b', ttlSeconds: 86_400 },
        { key: 'test:per-key-ttl:short', ttlSeconds: 300 },
      ],
    }),
  );

  assert.equal(exitCode, GRACEFUL_FETCH_FAILURE_EXIT_CODE);
  const groups = new Map(expirePipelines().map((pipeline) => [
    pipeline[0][2],
    pipeline.map((command) => command[1]).sort(),
  ]));
  assert.deepEqual(groups, new Map([
    [3600, [
      'seed-meta:test:per-key-ttl',
      'test:per-key-ttl:extra',
      'test:per-key-ttl:legacy',
      'test:per-key-ttl:v1',
    ]],
    [86_400, [
      'test:per-key-ttl:daily-a',
      'test:per-key-ttl:daily-b',
    ]],
    [300, ['test:per-key-ttl:short']],
  ]));
});

test('preserveKeyTtls rejects malformed declarations before acquiring the Redis lock', async () => {
  const exitCode = await trapExit(() =>
    runSeed('test', 'invalid-per-key-ttl', 'test:invalid-per-key-ttl:v1', async () => ({ ok: true }), {
      ttlSeconds: 3600,
      preserveKeyTtls: [{ key: 'test:invalid-per-key-ttl:companion', ttlSeconds: 0 }],
    }),
  );

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 0, 'configuration failure must happen before any Redis operation');
});
