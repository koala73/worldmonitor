import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Inline implementation for Node.js test runner (the actual source is TypeScript).
// Mirrors the logic in src/utils/fetch-cache.ts so we can validate behaviour
// without a TS build step.

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_FACTOR = 5;
const MAX_ENTRIES = 500;

const cache = new Map();
const inflight = new Map();
let hits = 0;
let misses = 0;

function evictIfNeeded() {
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
  const excess = cache.size - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) {
    const entry = sorted[i];
    if (entry) cache.delete(entry[0]);
  }
}

async function executeFetch(url, headers, signal, parseAs, _fetchImpl) {
  const init = {};
  if (headers) init.headers = headers;
  if (signal) init.signal = signal;
  const response = await _fetchImpl(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = parseAs === 'text' ? await response.text() : await response.json();
  cache.set(url, { data, timestamp: Date.now() });
  evictIfNeeded();
  return data;
}

async function fetchWithCache(url, options = {}, _fetchImpl = globalThis.fetch) {
  const ttl = options.ttl ?? DEFAULT_TTL_MS;
  const staleTtl = options.staleTtl ?? ttl * DEFAULT_STALE_FACTOR;
  const now = Date.now();
  const entry = cache.get(url);

  if (entry && now - entry.timestamp <= ttl) {
    hits++;
    return entry.data;
  }

  if (entry && now - entry.timestamp <= staleTtl) {
    hits++;
    if (!inflight.has(url)) {
      const bgPromise = executeFetch(url, options.headers, undefined, options.parseAs, _fetchImpl);
      inflight.set(url, bgPromise);
      bgPromise.catch(() => {}).finally(() => inflight.delete(url));
    }
    return entry.data;
  }

  misses++;
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = executeFetch(url, options.headers, options.signal, options.parseAs, _fetchImpl);
  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(url);
  }
}

function clearFetchCache() {
  cache.clear();
  inflight.clear();
  hits = 0;
  misses = 0;
}

function getFetchCacheStats() {
  return { size: cache.size, hits, misses, inflightCount: inflight.size };
}

// ── Helpers ──────────────────────────────────────────────────────────

function mockFetch(data, { ok = true, status = 200, delay = 0, asText = false } = {}) {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    return {
      ok,
      status,
      json: async () => data,
      text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
    };
  };
  fn.callCount = () => callCount;
  return fn;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('fetchWithCache', () => {
  beforeEach(() => {
    clearFetchCache();
  });

  it('returns parsed JSON by default', async () => {
    const payload = { hello: 'world' };
    const fetcher = mockFetch(payload);
    const result = await fetchWithCache('https://example.com/api', {}, fetcher);
    assert.deepEqual(result, payload);
  });

  it('returns text when parseAs is "text"', async () => {
    const fetcher = mockFetch('<xml>data</xml>');
    const result = await fetchWithCache('https://example.com/xml', { parseAs: 'text' }, fetcher);
    assert.equal(result, '<xml>data</xml>');
  });

  it('returns cached data within TTL without refetching', async () => {
    const fetcher = mockFetch({ value: 1 });
    await fetchWithCache('https://example.com/a', { ttl: 10_000 }, fetcher);
    assert.equal(fetcher.callCount(), 1);

    const result = await fetchWithCache('https://example.com/a', { ttl: 10_000 }, fetcher);
    assert.deepEqual(result, { value: 1 });
    assert.equal(fetcher.callCount(), 1, 'Should not re-fetch within TTL');
  });

  it('tracks hit and miss counts', async () => {
    const fetcher = mockFetch({ v: 1 });
    await fetchWithCache('https://example.com/stats', { ttl: 10_000 }, fetcher);
    assert.equal(getFetchCacheStats().misses, 1);
    assert.equal(getFetchCacheStats().hits, 0);

    await fetchWithCache('https://example.com/stats', { ttl: 10_000 }, fetcher);
    assert.equal(getFetchCacheStats().hits, 1);
  });

  it('deduplicates concurrent requests to the same URL', async () => {
    const fetcher = mockFetch({ concurrent: true }, { delay: 50 });
    const [r1, r2, r3] = await Promise.all([
      fetchWithCache('https://example.com/dedup', {}, fetcher),
      fetchWithCache('https://example.com/dedup', {}, fetcher),
      fetchWithCache('https://example.com/dedup', {}, fetcher),
    ]);
    assert.deepEqual(r1, { concurrent: true });
    assert.deepEqual(r2, { concurrent: true });
    assert.deepEqual(r3, { concurrent: true });
    assert.equal(fetcher.callCount(), 1, 'Only one fetch should have been made');
  });

  it('throws on non-ok response and does not cache errors', async () => {
    const fetcher = mockFetch(null, { ok: false, status: 500 });
    await assert.rejects(
      () => fetchWithCache('https://example.com/err', {}, fetcher),
      { message: 'HTTP 500' },
    );
    assert.equal(getFetchCacheStats().size, 0, 'Should not cache errors');
  });

  it('serves stale data during background revalidation', async () => {
    // Seed the cache with old data
    cache.set('https://example.com/swr', { data: { old: true }, timestamp: Date.now() - 70_000 });

    const fetcher = mockFetch({ fresh: true }, { delay: 50 });
    // With default TTL (60s), entry is stale. With default staleTtl (300s), it's revalidatable.
    const result = await fetchWithCache('https://example.com/swr', { ttl: 60_000 }, fetcher);
    assert.deepEqual(result, { old: true }, 'Should return stale data immediately');
    assert.equal(fetcher.callCount(), 1, 'Background fetch should have been triggered');

    // Wait for background revalidation to complete
    await new Promise(r => setTimeout(r, 100));

    // Now the cache should have fresh data
    const fresh = await fetchWithCache('https://example.com/swr', { ttl: 60_000 }, fetcher);
    assert.deepEqual(fresh, { fresh: true }, 'Should now return fresh data');
  });

  it('fetches fresh data when stale TTL is exceeded', async () => {
    // Seed with very old data (beyond staleTtl)
    cache.set('https://example.com/expired', { data: { expired: true }, timestamp: Date.now() - 400_000 });

    const fetcher = mockFetch({ new: true });
    // staleTtl = 5 * 60_000 = 300_000ms. 400_000ms is beyond.
    const result = await fetchWithCache('https://example.com/expired', { ttl: 60_000 }, fetcher);
    assert.deepEqual(result, { new: true }, 'Should perform blocking fetch for expired data');
    assert.equal(fetcher.callCount(), 1);
  });

  it('different URLs get separate cache entries', async () => {
    const fetcher1 = mockFetch({ url: 'a' });
    const fetcher2 = mockFetch({ url: 'b' });
    await fetchWithCache('https://example.com/a', {}, fetcher1);
    await fetchWithCache('https://example.com/b', {}, fetcher2);
    assert.equal(getFetchCacheStats().size, 2);
  });

  it('clearFetchCache resets everything', async () => {
    const fetcher = mockFetch({ v: 1 });
    await fetchWithCache('https://example.com/clear', {}, fetcher);
    assert.equal(getFetchCacheStats().size, 1);
    clearFetchCache();
    assert.equal(getFetchCacheStats().size, 0);
    assert.equal(getFetchCacheStats().hits, 0);
    assert.equal(getFetchCacheStats().misses, 0);
  });

  it('evicts oldest entries when cache exceeds MAX_ENTRIES', async () => {
    // Fill cache beyond limit
    const fetcher = mockFetch({ v: 1 });
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      cache.set(`https://example.com/${i}`, { data: { i }, timestamp: Date.now() - (MAX_ENTRIES + 10 - i) * 1000 });
    }
    // Trigger eviction by fetching a new URL
    await fetchWithCache('https://example.com/trigger-evict', {}, fetcher);
    assert.ok(cache.size <= MAX_ENTRIES + 1, `Cache size ${cache.size} should be <= ${MAX_ENTRIES + 1}`);
  });

  it('passes headers through to fetch', async () => {
    let capturedInit = null;
    const fetcher = async (url, init) => {
      capturedInit = init;
      return { ok: true, json: async () => ({}) };
    };
    await fetchWithCache('https://example.com/headers', { headers: { Authorization: 'Bearer token' } }, fetcher);
    assert.deepEqual(capturedInit.headers, { Authorization: 'Bearer token' });
  });

  it('background revalidation failure keeps stale data intact', async () => {
    cache.set('https://example.com/bg-fail', { data: { stale: true }, timestamp: Date.now() - 70_000 });

    const fetcher = async () => { throw new Error('Network error'); };
    const result = await fetchWithCache('https://example.com/bg-fail', { ttl: 60_000 }, fetcher);
    assert.deepEqual(result, { stale: true }, 'Should return stale data');

    // Wait for background to settle
    await new Promise(r => setTimeout(r, 50));

    // Cache should still have the stale data (not evicted by error)
    assert.ok(cache.has('https://example.com/bg-fail'), 'Stale data should remain in cache');
    assert.deepEqual(cache.get('https://example.com/bg-fail').data, { stale: true });
  });
});
