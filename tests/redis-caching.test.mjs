import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REDIS_MODULE_URL = pathToFileURL(resolve(root, 'server/_shared/redis.ts')).href;

function jsonResponse(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function importRedisFresh() {
  return import(`${REDIS_MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function importPatchedTsModule(relPath, replacements) {
  const sourcePath = resolve(root, relPath);
  let source = readFileSync(sourcePath, 'utf-8');

  for (const [specifier, targetPath] of Object.entries(replacements)) {
    source = source.replaceAll(`'${specifier}'`, `'${pathToFileURL(targetPath).href}'`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'wm-ts-module-'));
  const tempPath = join(tempDir, basename(sourcePath));
  writeFileSync(tempPath, source);

  const module = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    module,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// Match the body-mode shape `setCachedJson` emits: `POST /` with body
// ['SET', key, value, 'EX', ttl]. The previous URL-path form
// (`POST /set/{key}/{value}/EX/{ttl}`) is no longer produced by any caller,
// so we don't bother matching it.
function isSetRequest(_url, init) {
  try {
    const body = JSON.parse(String(init?.body ?? 'null'));
    return Array.isArray(body) && body[0] === 'SET';
  } catch {
    return false;
  }
}

function parseSetRequest(_url, init) {
  const body = JSON.parse(String(init.body));
  return { key: body[1], value: body[2], ttlSeconds: Number(body[4]) };
}

describe('redis caching behavior', { concurrency: 1 }, () => {
  it('coalesces concurrent misses into one upstream fetcher execution', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return { value: 42 };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'concurrent callers should share a single miss fetch');
      assert.deepEqual(a, { value: 42 });
      assert.deepEqual(b, { value: 42 });
      assert.deepEqual(c, { value: 42 });
      assert.equal(getCalls, 3, 'each caller should still attempt one cache read');
      assert.ok(setCalls >= 1, 'at least one cache write should happen after coalesced fetch (data + optional seed-meta)');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not positive-cache no-store fallback payloads', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const setValues = [];
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        const parsed = parseSetRequest(url, init);
        setValues.push(parsed);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const fallback = { items: [], degraded: true, error: 'upstream_unavailable' };
      const result = await redis.cachedFetchJson('meta:test:no-store', 60, async () => fallback);

      assert.deepEqual(result, fallback);
      assert.equal(setValues.length, 1);
      assert.equal(JSON.parse(setValues[0].value), '__WM_NEG__');
      assert.equal(setValues[0].ttlSeconds, 120);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('parses pipeline results and skips malformed entries', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let pipelineCalls = 0;
    globalThis.fetch = async (_url, init = {}) => {
      pipelineCalls += 1;
      const pipeline = JSON.parse(String(init.body));
      assert.equal(pipeline.length, 3);
      assert.deepEqual(pipeline.map((cmd) => cmd[0]), ['GET', 'GET', 'GET']);
      return jsonResponse([
        { result: JSON.stringify({ details: { id: 'a1' } }) },
        { result: '{ malformed json' },
        { result: JSON.stringify({ details: { id: 'c3' } }) },
      ]);
    };

    try {
      const map = await redis.getCachedJsonBatch(['k1', 'k2', 'k3']);
      assert.equal(pipelineCalls, 1, 'batch lookup should use one pipeline round-trip');
      assert.deepEqual(map.get('k1'), { details: { id: 'a1' } });
      assert.equal(map.has('k2'), false, 'malformed JSON entry should be skipped');
      assert.deepEqual(map.get('k3'), { details: { id: 'c3' } });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('cachedFetchJsonWithMeta source labeling', { concurrency: 1 }, () => {
  it('reports source=cache on Redis hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: JSON.stringify({ value: 'cached-data' }) });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalled = false;
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:test:hit', 60, async () => {
        fetcherCalled = true;
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'cache', 'should report source=cache on Redis hit');
      assert.deepEqual(data, { value: 'cached-data' });
      assert.equal(fetcherCalled, false, 'fetcher should not run on cache hit');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh on cache miss', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const { data, source, leader } = await redis.cachedFetchJsonWithMeta('meta:test:miss', 60, async () => {
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'fresh', 'should report source=fresh on cache miss');
      assert.equal(leader, true, 'cache miss caller that runs the fetcher should be marked leader');
      assert.deepEqual(data, { value: 'fresh-data' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh for all coalesced callers but marks only the fetch leader', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { value: 'coalesced' };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'only one fetcher should run');
      assert.equal(a.source, 'fresh', 'leader should report fresh');
      assert.equal(b.source, 'fresh', 'follower 1 should report fresh (not cache)');
      assert.equal(c.source, 'fresh', 'follower 2 should report fresh (not cache)');
      assert.equal([a, b, c].filter((r) => r.leader).length, 1, 'only one coalesced caller should be the write leader');
      assert.deepEqual(a.data, { value: 'coalesced' });
      assert.deepEqual(b.data, { value: 'coalesced' });
      assert.deepEqual(c.data, { value: 'coalesced' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('TOCTOU: reports cache when Redis is populated between concurrent reads', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    // First call: cache miss. Second call (from a "different instance"): cache hit.
    let getCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        if (getCalls === 1) return jsonResponse({ result: undefined });
        // Simulate another instance populating cache between calls
        return jsonResponse({ result: JSON.stringify({ value: 'from-other-instance' }) });
      }
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      // First call: miss → fetcher runs → fresh
      const first = await redis.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        return { value: 'fetched' };
      });
      assert.equal(first.source, 'fresh');
      assert.deepEqual(first.data, { value: 'fetched' });

      // Second call (fresh module import to clear inflight map): cache hit from other instance
      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        throw new Error('fetcher should not run on cache hit');
      });
      assert.equal(second.source, 'cache', 'should report cache when Redis has data');
      assert.deepEqual(second.data, { value: 'from-other-instance' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses an in-process positive fallback after Redis read errors even when the write succeeds', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        throw new Error('Redis GET failed');
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 'fresh-during-read-outage' };
      };

      const first = await redis.cachedFetchJsonWithMeta('meta:test:local-positive-read-error', 300, fetcher);
      assert.equal(first.source, 'fresh');
      assert.deepEqual(first.data, { value: 'fresh-during-read-outage' });

      const second = await redis.cachedFetchJsonWithMeta('meta:test:local-positive-read-error', 300, fetcher);
      assert.equal(second.source, 'cache', 'local fallback should report cache semantics');
      assert.deepEqual(second.data, { value: 'fresh-during-read-outage' });
      assert.equal(fetcherCalls, 1, 'read-error path must not refetch while local positive fallback is live');
      assert.equal(getCalls, 2, 'each call may still probe Redis before using the local fallback');
      assert.equal(setCalls, 1, 'only the fresh leader should write Redis');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('negative-result caching', { concurrency: 1 }, () => {
  it('caches sentinel on null fetcher result and suppresses subsequent upstream calls', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return null;
      };

      const first = await redis.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(first, null, 'first call should return null');
      assert.equal(fetcherCalls, 1, 'fetcher should run on first call');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(second, null, 'second call should return null from sentinel');
      assert.equal(fetcherCalls, 1, 'fetcher should NOT run again — sentinel suppresses');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJsonWithMeta returns data:null source:cache on sentinel hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const first = await redis.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => null);
      assert.equal(first.data, null);
      assert.equal(first.source, 'fresh', 'first null result is fresh');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => {
        throw new Error('fetcher should not run on sentinel hit');
      });
      assert.equal(second.data, null, 'sentinel should resolve to null data, not the sentinel string');
      assert.equal(second.source, 'cache', 'sentinel hit should report source=cache');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('caches a short sentinel when fetcher throws, while preserving the leader rejection', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    const ttls = new Map();
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        return jsonResponse({ result: store.get(key) ?? undefined });
      }
      if (isSetRequest(url, init)) {
        const { key, value, ttlSeconds } = parseSetRequest(url, init);
        setCalls += 1;
        store.set(key, value);
        ttls.set(key, ttlSeconds);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const throwingFetcher = async () => {
        fetcherCalls += 1;
        throw new Error('upstream ETIMEDOUT');
      };

      await assert.rejects(() => redis.cachedFetchJson('neg:test:throw', 300, throwingFetcher));
      assert.equal(fetcherCalls, 1);
      assert.equal(setCalls, 1, 'throw path should write a cooldown sentinel');
      assert.equal(JSON.parse(store.get('neg:test:throw')), '__WM_NEG__');
      assert.equal(ttls.get('neg:test:throw'), 30, 'throw path should use a short error cooldown TTL');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJson('neg:test:throw', 300, throwingFetcher);
      assert.equal(second, null, 'subsequent call should resolve from the cooldown sentinel');
      assert.equal(fetcherCalls, 1, 'fetcher should NOT run again while the sentinel is live');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses in-process cooldown on Redis read errors instead of treating them as plain misses', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let readMode = 'miss';
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        if (readMode === 'throw') throw new Error('Redis ECONNRESET');
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        throw new Error('Redis SET failed');
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const throwingFetcher = async () => {
        fetcherCalls += 1;
        throw new Error('upstream ETIMEDOUT');
      };

      await assert.rejects(() => redis.cachedFetchJson('neg:test:redis-read-error', 300, throwingFetcher));
      assert.equal(fetcherCalls, 1, 'first miss should run the fetcher and preserve its rejection');

      readMode = 'throw';
      const second = await redis.cachedFetchJson('neg:test:redis-read-error', 300, throwingFetcher);
      assert.equal(second, null, 'Redis read error should use the local cooldown sentinel');
      assert.equal(fetcherCalls, 1, 'read-error path must not stampede upstream while cooldown is active');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses an in-process positive fallback when Redis write fails after a successful fetch', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ error: 'Redis SET failed' }, false);
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 'fresh-during-write-outage' };
      };

      const first = await redis.cachedFetchJson('pos:test:local-positive-write-error', 300, fetcher);
      assert.deepEqual(first, { value: 'fresh-during-write-outage' });

      const second = await redis.cachedFetchJson('pos:test:local-positive-write-error', 300, fetcher);
      assert.deepEqual(second, { value: 'fresh-during-write-outage' });
      assert.equal(fetcherCalls, 1, 'write-failure path must not refetch while local positive fallback is live');
      assert.equal(getCalls, 2, 'each call may still probe Redis before using the local fallback');
      assert.equal(setCalls, 1, 'only the fresh leader should attempt the failed write');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('cachedFetchJson inflight timeout (#3539)', { concurrency: 1 }, () => {
  it('rejects a hung fetcher and releases the inflight slot so subsequent callers re-fetch', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      let hungCalls = 0;
      // Fetcher that NEVER settles — simulates an upstream that hangs forever
      // with no internal timeout and no AbortController.
      const hungFetcher = () => {
        hungCalls += 1;
        return new Promise(() => {});
      };

      // Concurrent callers should all share the same hung promise (coalescing
      // still works on the way in) and all reject with the timeout error.
      const [r1, r2, r3] = await Promise.allSettled([
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
      ]);

      assert.equal(hungCalls, 1, 'fetcher should still be coalesced — one execution shared by all callers');
      assert.equal(r1.status, 'rejected');
      assert.equal(r2.status, 'rejected');
      assert.equal(r3.status, 'rejected');
      assert.match(r1.reason.message, /^cachedFetchJson timeout after 50ms for "hang:test:key"$/);

      // Critical assertion: a follow-up call after the timeout must trigger a
      // fresh fetcher execution. Pre-fix the inflight Map kept the unresolved
      // promise forever, handing every subsequent caller the same dead handle.
      let recovered = false;
      const recoveredValue = await redis.cachedFetchJson('hang:test:key', 60, async () => {
        recovered = true;
        return { value: 'recovered' };
      });
      assert.equal(recovered, true, 'inflight slot must be released so a new fetcher can run');
      assert.deepEqual(recoveredValue, { value: 'recovered' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does NOT fire the timeout when the fetcher settles promptly', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      const result = await redis.cachedFetchJson('happy:test:key', 60, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { value: 'fast' };
      });
      assert.deepEqual(result, { value: 'fast' });

      // Wait past the timeout window — if the timer wasn't cleared we'd see
      // an unhandled rejection. Node's test runner surfaces those as failures.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('per-call opts.timeoutMs overrides the default ceiling', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      // Default ceiling deliberately tiny; caller passes a much higher per-call
      // budget, so a fetcher that runs 80ms should succeed. Without the
      // override it would reject at 20ms.
      redis.__setFetcherTimeoutForTests(20);

      const result = await redis.cachedFetchJson(
        'override:test:long',
        60,
        async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { value: 'long-fetcher-allowed' };
        },
        undefined,
        { timeoutMs: 500 },
      );
      assert.deepEqual(result, { value: 'long-fetcher-allowed' });

      // Same shape for cachedFetchJsonWithMeta — opts.timeoutMs lives next to opts.usage.
      const meta = await redis.cachedFetchJsonWithMeta(
        'override:meta:long',
        60,
        async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { value: 'meta-long-allowed' };
        },
        undefined,
        { timeoutMs: 500 },
      );
      assert.equal(meta.source, 'fresh');
      assert.deepEqual(meta.data, { value: 'meta-long-allowed' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJsonWithMeta also enforces the inflight timeout', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      await assert.rejects(
        () => redis.cachedFetchJsonWithMeta('meta:hang:key', 60, () => new Promise(() => {})),
        /^Error: cachedFetchJsonWithMeta timeout after 50ms for "meta:hang:key"$/,
      );

      // Subsequent call must succeed against a healthy fetcher — proves the
      // inflight slot was released even on the timeout path.
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:hang:key', 60, async () => ({ value: 'recovered' }));
      assert.equal(source, 'fresh');
      assert.deepEqual(data, { value: 'recovered' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('country risk freshness behavior', { concurrency: 1 }, () => {
  async function importCountryRisk() {
    return importPatchedTsModule('server/worldmonitor/intelligence/v1/get-country-risk.ts', {
      './_shared': resolve(root, 'server/worldmonitor/intelligence/v1/_shared.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
      '../../../_shared/cache-keys': resolve(root, 'server/_shared/cache-keys.ts'),
      // #4921: citation verification + grounding telemetry import
      '../../../../shared/brief-llm-core.js': resolve(root, 'shared/brief-llm-core.js'),
    });
  }

  function parseGetKey(rawUrl) {
    return decodeURIComponent(rawUrl.split('/get/').pop() || '');
  }

  function withMockedNow(nowMs) {
    const originalDateNow = Date.now;
    Date.now = () => nowMs;
    return () => {
      Date.now = originalDateNow;
    };
  }

  it('returns fetchedAt=0 for missing country code instead of fabricating request time', async () => {
    const { module, cleanup } = await importCountryRisk();
    const restoreNow = withMockedNow(1_777_000_000_000);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ result: undefined });
    };

    try {
      const result = await module.getCountryRisk({}, { countryCode: '' });
      assert.equal(result.fetchedAt, 0);
      assert.equal(result.upstreamUnavailable, false);
      assert.equal(fetchCalls, 0, 'missing-code path must not hit Redis');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreNow();
    }
  });

  it('returns fetchedAt=0 when upstream Redis keys are unavailable', async () => {
    const { module, cleanup } = await importCountryRisk();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    const restoreNow = withMockedNow(1_777_000_000_000);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const result = await module.getCountryRisk({}, { countryCode: 'US' });
      assert.equal(result.fetchedAt, 0);
      assert.equal(result.upstreamUnavailable, true);
      assert.equal(result.cii, undefined);
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreNow();
      restoreEnv();
    }
  });

  it('returns fetchedAt=0 for untracked countries with no CII score', async () => {
    const { module, cleanup } = await importCountryRisk();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    const restoreNow = withMockedNow(1_777_000_000_000);
    const originalFetch = globalThis.fetch;
    const redisValues = new Map([
      ['risk:scores:sebuf:stale:v8', JSON.stringify({
        ciiScores: [{ region: 'US', combinedScore: 10, computedAt: 1_700_000_000_000 }],
      })],
      ['intelligence:advisories:v1', JSON.stringify({
        byCountry: { ZZ: 'caution' },
        byCountryName: { ZZ: 'Untracked Testland' },
      })],
      ['sanctions:country-counts:v1', JSON.stringify({ ZZ: 2 })],
    ]);

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: redisValues.get(parseGetKey(raw)) });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const result = await module.getCountryRisk({}, { countryCode: 'ZZ' });
      assert.equal(result.countryName, 'Untracked Testland');
      assert.equal(result.cii, undefined);
      assert.equal(result.fetchedAt, 0);
      assert.equal(result.upstreamUnavailable, false);
      assert.equal(result.sanctionsActive, true);
      assert.equal(result.sanctionsCount, 2);
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreNow();
      restoreEnv();
    }
  });
});

describe('theater posture caching behavior', { concurrency: 1 }, () => {
  async function importTheaterPosture() {
    return importPatchedTsModule('server/worldmonitor/military/v1/get-theater-posture.ts', {
      './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
      '../../../_shared/response-headers': resolve(root, 'server/_shared/response-headers.ts'),
    });
  }

  function mockOpenSkyResponse() {
    return jsonResponse({
      states: [
        ['ae1234', 'RCH001', null, null, null, 50.0, 36.0, 30000, false, 400, 90],
        ['ae5678', 'DUKE02', null, null, null, 51.0, 35.0, 25000, false, 350, 180],
      ],
    });
  }

  it('reads live data from Redis without making upstream calls', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    const originalFetch = globalThis.fetch;

    const liveData = { theaters: [{ theater: 'live-test', postureLevel: 'elevated', activeFlights: 5, trackedVessels: 0, activeOperations: [], assessedAt: Date.now() }] };
    let openskyFetchCount = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        if (key === 'theater-posture:sebuf:v1') {
          return jsonResponse({ result: JSON.stringify(liveData) });
        }
        return jsonResponse({ result: undefined });
      }
      if (raw.includes('opensky-network.org') || raw.includes('wingbits.com')) {
        openskyFetchCount += 1;
      }
      return jsonResponse({}, false);
    };

    try {
      const result = await module.getTheaterPosture({ request: new Request('https://worldmonitor.app/api/military/v1/get-theater-posture') }, {});
      assert.equal(openskyFetchCount, 0, 'must not call upstream APIs (Redis-read-only)');
      assert.deepEqual(result, liveData, 'should return live Redis data');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('falls back to stale/backup when both upstreams are down', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const staleData = { theaters: [{ theater: 'stale-test', postureLevel: 'normal', activeFlights: 1, trackedVessels: 0, activeOperations: [], assessedAt: 1 }] };

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        if (key === 'theater-posture:sebuf:v1') {
          return jsonResponse({ result: undefined });
        }
        if (key === 'theater_posture:sebuf:stale:v1') {
          return jsonResponse({ result: JSON.stringify(staleData) });
        }
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        throw new Error('OpenSky down');
      }
      return jsonResponse({}, false);
    };

    try {
      const result = await module.getTheaterPosture({ request: new Request('https://worldmonitor.app/api/military/v1/get-theater-posture') }, {});
      assert.deepEqual(result, staleData, 'should return stale cache when upstreams fail');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns empty theaters when all tiers exhausted', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      WINGBITS_API_KEY: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('opensky-network.org')) {
        throw new Error('OpenSky down');
      }
      return jsonResponse({}, false);
    };

    try {
      const result = await module.getTheaterPosture({ request: new Request('https://worldmonitor.app/api/military/v1/get-theater-posture') }, {});
      assert.deepEqual(result, { theaters: [] }, 'should return empty when all tiers exhausted');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not write to Redis (read-only handler)', async () => {
    const { module, cleanup } = await importTheaterPosture();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    const originalFetch = globalThis.fetch;

    const cacheWrites = [];
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init) || raw.includes('/pipeline')) {
        cacheWrites.push(raw);
        return jsonResponse({ result: 'OK' });
      }
      return jsonResponse({}, false);
    };

    try {
      await module.getTheaterPosture({ request: new Request('https://worldmonitor.app/api/military/v1/get-theater-posture') }, {});
      assert.equal(cacheWrites.length, 0, 'handler must not write to Redis (read-only)');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('country intel brief caching behavior', { concurrency: 1 }, () => {
  async function importCountryIntelBrief({ premium = false } = {}) {
    return importPatchedTsModule('server/worldmonitor/intelligence/v1/get-country-intel-brief.ts', {
      './_shared': resolve(root, 'server/worldmonitor/intelligence/v1/_shared.ts'),
      './_country-brief-context': resolve(root, 'server/worldmonitor/intelligence/v1/_country-brief-context.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
      '../../../_shared/llm-health': resolve(root, 'tests/helpers/llm-health-stub.ts'),
      '../../../_shared/llm': resolve(root, 'server/_shared/llm.ts'),
      '../../../_shared/hash': resolve(root, 'server/_shared/hash.ts'),
      '../../../_shared/premium-check': resolve(
        root,
        premium ? 'tests/helpers/premium-check-stub-true.ts' : 'tests/helpers/premium-check-stub.ts',
      ),
      '../../../_shared/llm-sanitize.js': resolve(root, 'server/_shared/llm-sanitize.js'),
      '../../../_shared/cache-keys': resolve(root, 'server/_shared/cache-keys.ts'),
      // #4921: citation verification + grounding telemetry import
      '../../../../shared/brief-llm-core.js': resolve(root, 'shared/brief-llm-core.js'),
    });
  }

  function parseRedisKey(rawUrl, op) {
    const marker = `/${op}/`;
    const idx = rawUrl.indexOf(marker);
    if (idx === -1) return '';
    return decodeURIComponent(rawUrl.slice(idx + marker.length).split('/')[0] || '');
  }

  function makeCtx(url) {
    return { request: new Request(url) };
  }

  function installIntelFetchMock({ store, setKeys, userPrompts, counters }) {
    globalThis.fetch = async (url, init = {}) => {
      const raw = String(url);
      if (raw === 'https://api.groq.com') {
        return jsonResponse({});
      }
      if (raw.includes('api.groq.com/openai/v1/chat/completions')) {
        counters.groqCalls += 1;
        const body = JSON.parse(String(init.body || '{}'));
        userPrompts.push(body.messages?.[1]?.content || '');
        return jsonResponse({ choices: [{ message: { content: `brief-${counters.groqCalls}` } }] });
      }
      if (raw.includes('/get/')) {
        const key = parseRedisKey(raw, 'get');
        return jsonResponse({ result: store.get(key) });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        if (!key.startsWith('seed-meta:')) setKeys.push(key);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };
  }

  const INTEL_TEST_ENV = {
    GROQ_API_KEY: 'test-key',
    // The default chain is openrouter-first since #4944; clear these so the
    // groq-only fetch mock deterministically sees groq as the first provider
    // regardless of ambient shell env.
    OPENROUTER_API_KEY: undefined,
    OLLAMA_API_URL: undefined,
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    VERCEL_ENV: undefined,
    VERCEL_GIT_COMMIT_SHA: undefined,
  };

  it('anon callers share one digest-grounded cache entry regardless of client context', async () => {
    const { module, cleanup } = await importCountryIntelBrief();
    const restoreEnv = withEnv(INTEL_TEST_ENV);
    const originalFetch = globalThis.fetch;

    const store = new Map();
    store.set('news:digest:v1:full:en', JSON.stringify({
      categories: {
        conflict: {
          items: [
            { title: 'Israel announces new security framework', source: 'Reuters', link: 'https://example.com/il-1', pubDate: '2026-07-05T06:00:00.000Z' },
            { title: 'Unrelated commodity report', source: 'Bloomberg', link: 'https://example.com/other' },
          ],
        },
      },
    }));
    const setKeys = [];
    const userPrompts = [];
    const counters = { groqCalls: 0 };
    installIntelFetchMock({ store, setKeys, userPrompts, counters });

    try {
      const req = { countryCode: 'IL' };
      const alpha = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=IL&context=alpha'), req);
      const beta = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=IL&context=beta'), req);

      assert.equal(counters.groqCalls, 1, 'anon context variations must share one cache entry');
      assert.equal(setKeys.length, 1, 'one shared cache write');
      assert.ok(setKeys[0]?.startsWith('ci-sebuf:v5:IL:en:shared'), `anon key should use the shared v5 namespace, got ${setKeys[0]}`);
      assert.equal(alpha.brief, 'brief-1');
      assert.equal(beta.brief, 'brief-1', 'second anon caller must be served from cache');
      assert.ok(!userPrompts[0]?.includes('alpha'), 'anon caller context must not reach the prompt');
      assert.match(userPrompts[0], /Israel announces new security framework/, 'prompt should be grounded on the server-side digest');
      assert.ok(!userPrompts[0]?.includes('Unrelated commodity report'), 'digest grounding should be country-filtered');
      assert.equal(alpha.sources[0]?.url, 'https://example.com/il-1', 'sources should be server-derived');
      assert.deepEqual(beta.sources, alpha.sources, 'cached sources are shared');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('premium callers keep per-context personalized cache keys', async () => {
    const { module, cleanup } = await importCountryIntelBrief({ premium: true });
    const restoreEnv = withEnv(INTEL_TEST_ENV);
    const originalFetch = globalThis.fetch;

    const store = new Map();
    const setKeys = [];
    const userPrompts = [];
    const counters = { groqCalls: 0 };
    installIntelFetchMock({ store, setKeys, userPrompts, counters });

    try {
      const req = { countryCode: 'IL' };
      const alpha = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=IL&context=alpha'), req);
      const beta = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=IL&context=beta'), req);
      const alphaCached = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=IL&context=alpha'), req);

      assert.equal(counters.groqCalls, 2, 'different premium contexts should not share one cache entry');
      assert.equal(setKeys.length, 2, 'one cache write per unique premium context');
      assert.notEqual(setKeys[0], setKeys[1], 'context hash should differentiate premium cache keys');
      assert.ok(setKeys[0]?.startsWith('ci-sebuf:v5:IL:'), 'cache key should use the v5 country-intel namespace');
      assert.ok(!setKeys[0]?.includes(':shared'), 'premium keys must not use the shared namespace');
      assert.equal(alpha.brief, 'brief-1');
      assert.equal(beta.brief, 'brief-2');
      assert.equal(alphaCached.brief, 'brief-1', 'same premium context should hit cache');
      assert.match(userPrompts[0], /Context snapshot:\s*alpha/);
      assert.match(userPrompts[1], /Context snapshot:\s*beta/);
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses base cache key and prompt when context is missing or blank', async () => {
    const { module, cleanup } = await importCountryIntelBrief();
    const restoreEnv = withEnv({
      GROQ_API_KEY: 'test-key',
      // Deterministic groq-first for this groq-only mock (chain is
      // openrouter-first since #4944).
      OPENROUTER_API_KEY: undefined,
      OLLAMA_API_URL: undefined,
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    const setKeys = [];
    const userPrompts = [];
    let groqCalls = 0;

    globalThis.fetch = async (url, init = {}) => {
      const raw = String(url);
      if (raw === 'https://api.groq.com') {
        return jsonResponse({});
      }
      if (raw.includes('/get/')) {
        const key = parseRedisKey(raw, 'get');
        return jsonResponse({ result: store.get(key) });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        if (!key.startsWith('seed-meta:')) setKeys.push(key);
        return jsonResponse({ result: 'OK' });
      }
      if (raw.includes('api.groq.com/openai/v1/chat/completions')) {
        groqCalls += 1;
        const body = JSON.parse(String(init.body || '{}'));
        userPrompts.push(body.messages?.[1]?.content || '');
        return jsonResponse({ choices: [{ message: { content: 'base-brief' } }] });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const req = { countryCode: 'US' };
      const first = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=US'), req);
      const second = await module.getCountryIntelBrief(makeCtx('https://example.com/api/intelligence/v1/get-country-intel-brief?country_code=US&context=%20%20%20'), req);

      assert.equal(groqCalls, 1, 'blank context should reuse the shared cache entry');
      assert.equal(setKeys.length, 1);
      assert.ok(setKeys[0]?.startsWith('ci-sebuf:v5:US:en:shared'), `anon callers land on the shared key, got ${setKeys[0]}`);
      assert.ok(!userPrompts[0]?.includes('Context snapshot:'), 'prompt should omit context block when digest grounding is unavailable');
      assert.equal(first.brief, 'base-brief');
      assert.equal(second.brief, 'base-brief');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('military flights bbox behavior', { concurrency: 1 }, () => {
  async function importListMilitaryFlights() {
    return importPatchedTsModule('server/worldmonitor/military/v1/list-military-flights.ts', {
      './_shared': resolve(root, 'server/worldmonitor/military/v1/_shared.ts'),
      '../../../_shared/constants': resolve(root, 'server/_shared/constants.ts'),
      '../../../_shared/redis': resolve(root, 'server/_shared/redis.ts'),
      '../../../_shared/relay': resolve(root, 'server/_shared/relay.ts'),
      '../../../_shared/response-headers': resolve(root, 'server/_shared/response-headers.ts'),
    });
  }

  const request = {
    swLat: 10,
    swLon: 10,
    neLat: 11,
    neLon: 11,
  };

  it('fetches expanded quantized bbox but returns only flights inside the requested bbox', async () => {
    const { module, cleanup } = await importListMilitaryFlights();
    const restoreEnv = withEnv({
      LOCAL_API_MODE: 'sidecar',
      WS_RELAY_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
    });
    const originalFetch = globalThis.fetch;

    const fetchUrls = [];
    globalThis.fetch = async (url) => {
      const raw = String(url);
      fetchUrls.push(raw);
      if (!raw.includes('opensky-network.org/api/states/all')) {
        throw new Error(`Unexpected fetch URL: ${raw}`);
      }
      return jsonResponse({
        states: [
          ['in-bounds', 'RCH123', null, null, null, 10.5, 10.5, 20000, false, 300, 90],
          ['south-out', 'RCH124', null, null, null, 10.4, 9.7, 22000, false, 280, 95],
          ['east-out', 'RCH125', null, null, null, 11.3, 10.6, 21000, false, 290, 92],
        ],
      });
    };

    try {
      const result = await module.listMilitaryFlights({}, request);
      assert.deepEqual(
        result.flights.map((flight) => flight.id),
        ['IN-BOUNDS'],
        'response should not include out-of-viewport flights (hex_code canonical form is uppercase)',
      );

      assert.equal(fetchUrls.length, 1);
      const params = new URL(fetchUrls[0]).searchParams;
      assert.equal(params.get('lamin'), '9.5');
      assert.equal(params.get('lamax'), '11.5');
      assert.equal(params.get('lomin'), '9.5');
      assert.equal(params.get('lomax'), '11.5');
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('filters cached quantized-cell results back to the requested bbox', async () => {
    const { module, cleanup } = await importListMilitaryFlights();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      LOCAL_API_MODE: undefined,
      WS_RELAY_URL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let openskyCalls = 0;
    let redisGetCalls = 0;
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        redisGetCalls += 1;
        return jsonResponse({
          result: JSON.stringify({
            flights: [
              { id: 'cache-in', location: { latitude: 10.2, longitude: 10.2 } },
              { id: 'cache-out', location: { latitude: 9.8, longitude: 10.2 } },
            ],
            clusters: [],
          }),
        });
      }
      if (raw.includes('opensky-network.org/api/states/all')) {
        openskyCalls += 1;
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const result = await module.listMilitaryFlights({}, request);
      assert.equal(redisGetCalls, 1, 'handler should read quantized cache first');
      assert.equal(openskyCalls, 0, 'cache hit should avoid upstream fetch');
      assert.deepEqual(
        result.flights.map((flight) => flight.id),
        ['cache-in'],
        'cached quantized-cell payload must be re-filtered to request bbox',
      );
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  // #3277 — fetchStaleFallback NEG_TTL parity with the legacy
  // /api/military-flights handler. Without the negative cache, a sustained
  // relay+seed outage would Redis-hammer the stale key on every request.
  it('suppresses stale Redis read for 30s after a stale-key miss (NEG_TTL parity)', async () => {
    const { module, cleanup } = await importListMilitaryFlights();
    module._resetStaleNegativeCacheForTests();

    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      LOCAL_API_MODE: undefined,
      WS_RELAY_URL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const staleGetCalls = [];
    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        if (raw.includes('military%3Aflights%3Astale%3Av1')) {
          staleGetCalls.push(raw);
        }
        // Both keys empty — drives cachedFetchJson to call the fetcher
        // (which returns null because no relay) and then the handler falls
        // through to fetchStaleFallback (which returns null because stale
        // is also empty → arms the negative cache).
        return jsonResponse({ result: null });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const ctx = { request: new Request('https://wm.test/api/military/v1/list-military-flights') };

      // Call 1 — live empty + stale empty. Stale key MUST be read once,
      // and the negative cache MUST be armed for the next 30s.
      const r1 = await module.listMilitaryFlights(ctx, request);
      assert.deepEqual(r1.flights, [], 'no live, no stale → empty response');
      assert.equal(staleGetCalls.length, 1, 'first call reads stale key once');

      // Call 2 — within the 30s negative-cache window. Live cache may be
      // re-checked but the stale key MUST NOT be re-read.
      staleGetCalls.length = 0;
      const r2 = await module.listMilitaryFlights(ctx, request);
      assert.deepEqual(r2.flights, [], 'still empty during negative-cache window');
      assert.equal(
        staleGetCalls.length,
        0,
        'second call within NEG_TTL window must not re-read stale key',
      );

      // Reset the negative cache (simulates wall-clock advance past 30s) →
      // stale read should resume.
      module._resetStaleNegativeCacheForTests();
      const r3 = await module.listMilitaryFlights(ctx, request);
      assert.deepEqual(r3.flights, []);
      assert.equal(
        staleGetCalls.length,
        1,
        'after negative-cache reset, stale key is re-read',
      );
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('setCachedJson wire shape and failure reporting', { concurrency: 1 }, () => {
  it('emits POST / with body ["SET", key, value, "EX", String(ttl)]', async () => {
    // Pins the body-mode wire shape so a future "simplification" back to
    // URL-path encoding (`POST /set/{key}/{value}/EX/{ttl}`) fails loudly.
    // That regression silently broke large-payload writes (e.g. news:digest:v1
    // at ~126KB) because the self-hosted redis-rest-proxy runs Node's
    // http.createServer, which rejects URLs >~16KB with ECONNRESET.
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse({ result: 'OK' });
    };

    try {
      const key = 'news:digest:v1';
      const value = { items: [{ id: 'a' }, { id: 'b' }] };
      const ttl = 600;
      const ok = await redis.setCachedJson(key, value, ttl);

      assert.equal(ok, true, 'setCachedJson should return true on success');
      assert.equal(captured.length, 1, 'exactly one Redis write should be issued');
      const [req] = captured;
      assert.equal(req.init.method, 'POST');
      assert.equal(req.url, 'https://redis.test/', 'POST goes to base URL (not /set/...)');
      assert.equal(
        req.init.headers['Content-Type'],
        'application/json',
        'body-mode requires JSON Content-Type',
      );
      assert.deepEqual(
        JSON.parse(String(req.init.body)),
        ['SET', key, JSON.stringify(value), 'EX', String(ttl)],
        'body must carry the SET command + args verbatim',
      );
      assert.ok(
        !req.url.includes('/set/'),
        'URL must NOT carry payload in path — that was the original bug',
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns false and warns when Upstash returns an error in the body', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };

    globalThis.fetch = async () => jsonResponse({ error: 'WRONGTYPE' });

    try {
      const ok = await redis.setCachedJson('k', { v: 1 }, 30);
      assert.equal(ok, false, 'Upstash error must surface as false');
      assert.equal(warnings.length, 1, 'should warn exactly once');
      const [msg, detail] = warnings[0];
      assert.match(String(msg), /setCachedJson failed/);
      assert.equal(detail, 'WRONGTYPE', 'warn payload should be the Upstash error string');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('returns false and warns on non-2xx HTTP responses', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      async json() { return null; },
    });

    try {
      const ok = await redis.setCachedJson('k', { v: 1 }, 30);
      assert.equal(ok, false, 'HTTP failure must surface as false');
      assert.equal(warnings.length, 1, 'should warn exactly once');
      const [msg, detail] = warnings[0];
      assert.match(String(msg), /setCachedJson failed/);
      assert.equal(detail, 'HTTP 503', 'warn payload should name the HTTP status');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });
});

describe('getHashFieldsBatch empty-string handling (#3530)', { concurrency: 1 }, () => {
  it('preserves empty-string values, omits null/missing, and retains real strings', async () => {
    // Regression: getHashFieldsBatch used a truthy check (`if (values[i])`) that
    // dropped valid empty-string hash values. Real Redis hash values are
    // allowed to be the empty string, so a caller that round-trips "" will
    // silently lose it. The fix switches to a null/undefined check so "" is
    // preserved.
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let pipelineCalls = 0;
    globalThis.fetch = async (_url, init = {}) => {
      pipelineCalls += 1;
      const pipeline = JSON.parse(String(init.body));
      assert.equal(pipeline.length, 1);
      assert.equal(pipeline[0][0], 'HMGET');
      assert.deepEqual(pipeline[0].slice(2), ['name', 'empty', 'missing', 'real']);
      // Upstash HMGET returns an array of (string | null) in field order:
      //   - real value  -> "alice"
      //   - valid ""    -> ""
      //   - missing key -> null
      //   - real value  -> "ok"
      return jsonResponse([{ result: ['alice', '', null, 'ok'] }]);
    };

    try {
      const map = await redis.getHashFieldsBatch('user:42', ['name', 'empty', 'missing', 'real']);
      assert.equal(pipelineCalls, 1, 'should batch into one HMGET pipeline call');
      assert.equal(map.get('name'), 'alice', 'non-empty value is kept');
      assert.equal(map.get('empty'), '', 'empty-string value must be preserved (this is the bug)');
      assert.equal(map.has('missing'), false, 'null entries are omitted');
      assert.equal(map.get('real'), 'ok', 'non-empty value is kept');
      assert.equal(map.size, 3, 'map should contain only the three resolvable fields');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

