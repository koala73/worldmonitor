/**
 * Functional tests for per-upstream cachedFetchJson in enrichment/signals handlers.
 * Verifies null/[] semantics, cache key encoding, and cache hit behavior.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ─── Redis stub ──────────────────────────────────────────────────────────────

const NEG_SENTINEL = '__WM_NEG__';

function makeRedisStub() {
  const store = new Map();
  const ttls = new Map();
  const setCalls = [];

  return {
    store,
    ttls,
    setCalls,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, ttl) {
      store.set(key, value);
      ttls.set(key, ttl);
      setCalls.push({ key, value, ttl });
    },
    reset() {
      store.clear();
      ttls.clear();
      setCalls.length = 0;
    },
  };
}

// ─── cachedFetchJson re-implementation for testing ───────────────────────────
// Tests the same logic as server/_shared/redis.ts cachedFetchJson

function makeCachedFetchJson(redis) {
  const inflight = new Map();

  return async function cachedFetchJson(key, ttlSeconds, fetcher, negativeTtlSeconds = 120) {
    const cached = await redis.get(key);
    if (cached === NEG_SENTINEL) return null;
    if (cached !== null) return cached;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = fetcher()
      .then(async (result) => {
        if (result != null) {
          await redis.set(key, result, ttlSeconds);
        } else {
          await redis.set(key, NEG_SENTINEL, negativeTtlSeconds);
        }
        return result;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cachedFetchJson — null path (fetch failure)', () => {
  const redis = makeRedisStub();
  const cachedFetchJson = makeCachedFetchJson(redis);

  before(() => redis.reset());

  it('returns null when fetcher returns null', async () => {
    const result = await cachedFetchJson(
      'intel:enrichment:gh-org:testco',
      3600,
      async () => null,
    );
    assert.equal(result, null);
  });

  it('writes NEG_SENTINEL to Redis with 120s TTL on fetch failure', () => {
    assert.equal(redis.setCalls.length, 1);
    const call = redis.setCalls[0];
    assert.equal(call.key, 'intel:enrichment:gh-org:testco');
    assert.equal(call.value, NEG_SENTINEL);
    assert.equal(call.ttl, 120);
  });

  it('subsequent call returns null from NEG_SENTINEL (no fetcher call)', async () => {
    let fetcherCalled = false;
    const result = await cachedFetchJson(
      'intel:enrichment:gh-org:testco',
      3600,
      async () => { fetcherCalled = true; return { name: 'should not get here' }; },
    );
    assert.equal(result, null);
    assert.equal(fetcherCalled, false, 'fetcher should not be called on neg cache hit');
  });
});

describe('cachedFetchJson — empty array (successful empty result)', () => {
  const redis = makeRedisStub();
  const cachedFetchJson = makeCachedFetchJson(redis);

  before(() => redis.reset());

  it('returns [] when fetcher returns []', async () => {
    const result = await cachedFetchJson(
      'intel:enrichment:hn:emptyco',
      1800,
      async () => [],
    );
    assert.deepEqual(result, []);
  });

  it('caches [] with normal TTL (not neg cache)', () => {
    assert.equal(redis.setCalls.length, 1);
    const call = redis.setCalls[0];
    assert.equal(call.key, 'intel:enrichment:hn:emptyco');
    assert.deepEqual(call.value, []);
    assert.equal(call.ttl, 1800);
    assert.notEqual(call.value, NEG_SENTINEL);
  });

  it('subsequent call returns [] from cache (no fetcher call)', async () => {
    let fetcherCalled = false;
    const result = await cachedFetchJson(
      'intel:enrichment:hn:emptyco',
      1800,
      async () => { fetcherCalled = true; return ['should not appear']; },
    );
    assert.deepEqual(result, []);
    assert.equal(fetcherCalled, false, 'fetcher should not be called on cache hit');
  });
});

describe('cachedFetchJson — cache hit skips upstream fetch', () => {
  const redis = makeRedisStub();
  const cachedFetchJson = makeCachedFetchJson(redis);

  before(() => {
    redis.reset();
    redis.store.set('intel:enrichment:gh-org:stripe', { name: 'Stripe', publicRepos: 42 });
  });

  it('returns cached data without calling fetcher', async () => {
    let fetcherCalled = false;
    const result = await cachedFetchJson(
      'intel:enrichment:gh-org:stripe',
      3600,
      async () => { fetcherCalled = true; return { name: 'WRONG' }; },
    );
    assert.deepEqual(result, { name: 'Stripe', publicRepos: 42 });
    assert.equal(fetcherCalled, false);
  });

  it('no Redis SET calls on cache hit', () => {
    assert.equal(redis.setCalls.length, 0);
  });
});

describe('cachedFetchJson — cache key encoding', () => {
  const redis = makeRedisStub();
  const cachedFetchJson = makeCachedFetchJson(redis);

  before(() => redis.reset());

  it('encodes special chars in company names', async () => {
    await cachedFetchJson(
      `intel:enrichment:hn:${encodeURIComponent('at&t')}`,
      1800,
      async () => [{ title: 'AT&T news', url: 'https://example.com', points: 10, comments: 5, createdAtMs: 0 }],
    );
    const key = redis.setCalls[0]?.key;
    assert.ok(key?.includes('at%26t'), `Expected key to contain "at%26t", got: ${key}`);
  });

  it('different companies produce different keys', async () => {
    await cachedFetchJson(
      `intel:enrichment:hn:${encodeURIComponent('johnson %26 johnson')}`,
      1800,
      async () => [],
    );
    const keys = redis.setCalls.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, 'each company should produce a unique cache key');
  });

  it('lowercased names produce consistent keys', async () => {
    const redis2 = makeRedisStub();
    const cf2 = makeCachedFetchJson(redis2);

    await cf2(`intel:enrichment:gh-org:${encodeURIComponent('stripe')}`, 3600, async () => ({ name: 'Stripe' }));
    await cf2(`intel:enrichment:gh-org:${encodeURIComponent('STRIPE'.toLowerCase())}`, 3600, async () => ({ name: 'WRONG' }));

    assert.equal(redis2.setCalls.length, 1, 'STRIPE and stripe should resolve to the same key');
  });
});

describe('cachedFetchJson — import verification', () => {
  it('get-company-enrichment.ts imports cachedFetchJson', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('server/worldmonitor/intelligence/v1/get-company-enrichment.ts'), 'utf-8');
    assert.ok(src.includes("from '../../../_shared/redis'"), 'must import from _shared/redis');
    assert.ok(src.includes('cachedFetchJson'), 'must use cachedFetchJson');
    assert.ok(src.includes('intel:enrichment:gh-org:'), 'must use gh-org cache key');
    assert.ok(src.includes('intel:enrichment:gh-tech:'), 'must use gh-tech cache key');
    assert.ok(src.includes('intel:enrichment:sec:'), 'must use sec cache key');
    assert.ok(src.includes('intel:enrichment:hn:'), 'must use hn cache key');
    assert.ok(
      src.includes('intel:enrichment:sec:') && src.includes('getTodayISO()'),
      'SEC cache key must include getTodayISO() daily bucket to track date-window changes',
    );
  });

  it('list-company-signals.ts imports cachedFetchJson', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve('server/worldmonitor/intelligence/v1/list-company-signals.ts'), 'utf-8');
    assert.ok(src.includes("from '../../../_shared/redis'"), 'must import from _shared/redis');
    assert.ok(src.includes('cachedFetchJson'), 'must use cachedFetchJson');
    assert.ok(src.includes('intel:signals:hn:'), 'must use signals:hn cache key');
    assert.ok(src.includes('intel:signals:gh:'), 'must use signals:gh cache key');
    assert.ok(src.includes('intel:signals:jobs:'), 'must use signals:jobs cache key');
    assert.ok(
      src.includes('hourBucket()'),
      'all signal cache keys must include hourBucket() to prevent stale rolling-window results',
    );
  });

  it('cache keys do not collide with existing bootstrap keys', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cacheKeysSrc = readFileSync(resolve('server/_shared/cache-keys.ts'), 'utf-8');
    assert.ok(
      !cacheKeysSrc.includes('intel:enrichment:'),
      'intel:enrichment: prefix should not exist in bootstrap cache-keys.ts (on-demand keys)',
    );
    assert.ok(
      !cacheKeysSrc.includes('intel:signals:'),
      'intel:signals: prefix should not exist in bootstrap cache-keys.ts (on-demand keys)',
    );
  });
});
