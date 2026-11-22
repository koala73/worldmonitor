import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REDIS_MODULE_URL = pathToFileURL(resolve(root, 'server/_shared/redis.ts')).href;

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function importRedisFresh() {
  return import(`${REDIS_MODULE_URL}?abort=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function installRedisDouble() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const raw = String(url);
    if (raw.includes('/get/')) return jsonResponse({ result: null });
    // setCachedJson posts the SET command to the REST root.
    if (raw.endsWith('/') || raw.includes('/set/')) return jsonResponse({ result: 'OK' });
    throw new Error(`Unexpected fetch URL: ${raw}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  VERCEL_ENV: undefined,
  VERCEL_GIT_COMMIT_SHA: undefined,
};

describe('cachedFetchJson fetcher abort signal', { concurrency: 1 }, () => {
  it('aborts the fetcher signal when the cache timeout fires', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv(REDIS_ENV);
    const restoreFetch = installRedisDouble();
    try {
      redis.__setFetcherTimeoutForTests(20);
      let signal;
      await assert.rejects(
        () => redis.cachedFetchJson('abort:timeout', 60, (received) => {
          signal = received;
          return new Promise((resolve) => {
            if (received?.aborted) resolve({ value: 'aborted' });
            else received?.addEventListener('abort', () => resolve({ value: 'aborted' }), { once: true });
          });
        }),
        (err) => {
          assert.ok(err instanceof redis.CachedFetchTimeoutError);
          assert.match(err.message, /^cachedFetchJson timeout after 20ms for "abort:timeout"$/);
          return true;
        },
      );
      assert.ok(signal instanceof AbortSignal, 'fetcher must receive an AbortSignal');
      assert.equal(signal.aborted, true);
      assert.ok(signal.reason instanceof redis.CachedFetchTimeoutError);
      assert.match(signal.reason.message, /^cachedFetchJson timeout after 20ms for "abort:timeout"$/);
    } finally {
      redis.__resetFetcherTimeoutForTests();
      restoreFetch();
      restoreEnv();
    }
  });

  it('does not abort the signal when the fetcher resolves before the timeout', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv(REDIS_ENV);
    const restoreFetch = installRedisDouble();
    try {
      redis.__setFetcherTimeoutForTests(40);
      let signal;
      const result = await redis.cachedFetchJson('abort:in-time', 60, async (received) => {
        signal = received;
        return { value: 'in-time' };
      });
      assert.deepEqual(result, { value: 'in-time' });
      assert.ok(signal instanceof AbortSignal, 'fetcher must receive an AbortSignal');
      assert.equal(signal.aborted, false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(signal.aborted, false);
      assert.equal(signal.reason, undefined);
    } finally {
      redis.__resetFetcherTimeoutForTests();
      restoreFetch();
      restoreEnv();
    }
  });

  it('still returns data from a fetcher that takes no argument', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv(REDIS_ENV);
    const restoreFetch = installRedisDouble();
    try {
      redis.__setFetcherTimeoutForTests(40);
      const result = await redis.cachedFetchJson('abort:legacy', 60, async () => ({ value: 'legacy' }));
      assert.deepEqual(result, { value: 'legacy' });
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      redis.__resetFetcherTimeoutForTests();
      restoreFetch();
      restoreEnv();
    }
  });

  it('clears the timeout timer when the fetcher settles first', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv(REDIS_ENV);
    const restoreFetch = installRedisDouble();
    const originalClearTimeout = globalThis.clearTimeout;
    const cleared = [];
    globalThis.clearTimeout = (handle, ...args) => {
      cleared.push(handle);
      return originalClearTimeout.call(globalThis, handle, ...args);
    };
    try {
      redis.__setFetcherTimeoutForTests(40);
      const before = cleared.length;
      const result = await redis.cachedFetchJson('abort:timer', 60, async () => ({ value: 'settled' }));
      assert.deepEqual(result, { value: 'settled' });
      assert.ok(cleared.length > before, 'settling the fetcher must clear the timeout timer');
      assert.ok(cleared.slice(before).every((handle) => handle !== undefined));
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
      redis.__resetFetcherTimeoutForTests();
      restoreFetch();
      restoreEnv();
    }
  });
});
