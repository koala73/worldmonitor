/**
 * Regression tests for keyed market quote breaker cache (#1325).
 *
 * Root cause: one shared breaker handled markets, sectors, and watchlists
 * with different symbol sets. Enabling a TTL on that shared cache would let
 * the previous request poison later calls with different symbols.
 *
 * Fix: keep the breaker shared for cooldown/failure tracking, but key its
 * cache by the normalized symbol set passed in from market/index.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CIRCUIT_BREAKER_URL = pathToFileURL(
  resolve(root, 'src/utils/circuit-breaker.ts'),
).href;

function emptyMarketFallback() {
  return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
}

function quoteResponse(symbol, price) {
  return {
    quotes: [{ symbol, price }],
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
  };
}

describe('CircuitBreaker keyed cache — market quote isolation', () => {
  it('caches different symbol sets independently within one breaker', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'Market Quotes', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();
      const techData = quoteResponse('AAPL', 201.25);
      const metalsData = quoteResponse('GLD', 302.1);

      await breaker.execute(async () => techData, fallback, { cacheKey: 'AAPL,MSFT,NVDA' });
      await breaker.execute(async () => metalsData, fallback, { cacheKey: 'GLD,SLV' });

      const cachedTech = await breaker.execute(async () => fallback, fallback, { cacheKey: 'AAPL,MSFT,NVDA' });
      const cachedMetals = await breaker.execute(async () => fallback, fallback, { cacheKey: 'GLD,SLV' });

      assert.equal(
        cachedTech.quotes[0]?.symbol,
        'AAPL',
        'tech symbol set must return its own cached payload',
      );
      assert.equal(
        cachedMetals.quotes[0]?.symbol,
        'GLD',
        'metals symbol set must return its own cached payload',
      );
      assert.notEqual(
        cachedTech.quotes[0]?.symbol,
        cachedMetals.quotes[0]?.symbol,
        'different symbol sets must not share one cached payload',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('global cooldown: failing key suppresses all keys, but cache remains isolated', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'Market Quotes',
        cacheTtlMs: 5 * 60 * 1000,
        maxFailures: 2,
        cooldownMs: 60_000,
      });
      const fallback = emptyMarketFallback();
      const watchlistData = quoteResponse('AAPL', 201.25);
      const alwaysFail = () => { throw new Error('upstream unavailable'); };

      // Cache a watchlist, then fail the commodity key twice to trip breaker-wide cooldown
      await breaker.execute(async () => watchlistData, fallback, { cacheKey: 'AAPL,MSFT' });
      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F' });
      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F' });

      assert.ok(breaker.isOnCooldown(), 'breaker must observe cooldown after repeated failures');

      // The commodity key has no cache, so cooldown should return the default fallback
      const commodityResult = await breaker.execute(
        async () => quoteResponse('GC=F', 2880.4),
        fallback,
        { cacheKey: 'GC=F,CL=F' },
      );
      assert.deepEqual(
        commodityResult,
        fallback,
        'an uncached symbol set on cooldown must not receive another set\'s cached quotes',
      );

      // The watchlist key is also on cooldown, but it must still serve its own cached data
      const watchlistResult = await breaker.execute(
        async () => quoteResponse('AAPL', 205),
        fallback,
        { cacheKey: 'AAPL,MSFT' },
      );
      assert.equal(
        watchlistResult.quotes[0]?.symbol,
        'AAPL',
        'cached watchlist must still serve its own data during breaker-wide cooldown',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('evicts least-recently-used entries when maxCacheEntries is reached', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-lru',
        cacheTtlMs: 5 * 60 * 1000,
        maxCacheEntries: 2,
      });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('A', 100), fallback, { cacheKey: 'A' });
      await breaker.execute(async () => quoteResponse('B', 110), fallback, { cacheKey: 'B' });

      // Access B again to make it MRU
      assert.equal((await breaker.execute(async () => fallback, fallback, { cacheKey: 'B' })).quotes[0]?.symbol, 'B');

      await breaker.execute(async () => quoteResponse('C', 120), fallback, { cacheKey: 'C' });

      const keys = breaker.getKnownCacheKeys();
      assert.equal(keys.includes('A'), false, 'LRU entry A should be evicted when cap is reached');
      assert.equal(keys.includes('B'), true, 'MRU entry B should be retained');
      assert.equal(keys.includes('C'), true, 'new key C should be retained');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('fresh hits update LRU order even before the cache first reaches capacity', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-lru-precap',
        cacheTtlMs: 5 * 60 * 1000,
        maxCacheEntries: 3,
      });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('A', 100), fallback, { cacheKey: 'A' });
      await breaker.execute(async () => quoteResponse('B', 110), fallback, { cacheKey: 'B' });

      assert.equal(
        breaker.getCached('A')?.quotes[0]?.symbol,
        'A',
        'fresh accessor should serve A before the cache reaches its cap',
      );

      await breaker.execute(async () => quoteResponse('C', 120), fallback, { cacheKey: 'C' });
      await breaker.execute(async () => quoteResponse('D', 130), fallback, { cacheKey: 'D' });

      const keys = breaker.getKnownCacheKeys();
      assert.equal(keys.includes('A'), true, 'fresh hit should protect A from later LRU eviction');
      assert.equal(keys.includes('B'), false, 'B should become the LRU entry and be evicted');
      assert.equal(keys.includes('C'), true, 'C should remain in cache');
      assert.equal(keys.includes('D'), true, 'D should remain in cache');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('does not touch stale/getCachedOrDefault reads for LRU ordering', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-lru-stale',
        cacheTtlMs: 1,
        maxCacheEntries: 2,
      });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('A', 100), fallback, { cacheKey: 'A' });
      await breaker.execute(async () => quoteResponse('B', 110), fallback, { cacheKey: 'B' });

      // Let both entries become stale
      await new Promise((r) => setTimeout(r, 10));

      // Stale accessor should not promote LRU order
      assert.equal(breaker.getCachedOrDefault(fallback, 'A').quotes[0]?.symbol, 'A');

      await breaker.execute(async () => quoteResponse('C', 120), fallback, { cacheKey: 'C' });

      const keys = breaker.getKnownCacheKeys();
      assert.equal(keys.includes('A'), false, 'stale read should not protect A from LRU eviction');
      assert.equal(keys.includes('B'), true, 'B should be evicted only if A was promoted');
      assert.equal(keys.includes('C'), true, 'C should remain after insertion');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('stale SWR hits still count as used for LRU before refresh completes', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-lru-swr',
        cacheTtlMs: 1,
        maxCacheEntries: 2,
      });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('A', 100), fallback, { cacheKey: 'A' });
      await breaker.execute(async () => quoteResponse('B', 110), fallback, { cacheKey: 'B' });
      await new Promise((r) => setTimeout(r, 10));

      const staleResult = await breaker.execute(
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return quoteResponse('A', 130);
        },
        fallback,
        { cacheKey: 'A' },
      );

      assert.equal(staleResult.quotes[0]?.price, 100, 'SWR should return stale data immediately');

      await breaker.execute(async () => quoteResponse('C', 120), fallback, { cacheKey: 'C' });

      const keysBeforeRefresh = breaker.getKnownCacheKeys();
      assert.equal(keysBeforeRefresh.includes('A'), true, 'served stale key A should stay resident');
      assert.equal(keysBeforeRefresh.includes('B'), false, 'B should be evicted after A is promoted by the stale hit');
      assert.equal(keysBeforeRefresh.includes('C'), true, 'new key C should be retained');

      await new Promise((r) => setTimeout(r, 60));
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('clearCache(key) only removes that key, leaving others intact', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-clear', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('AAPL', 150), fallback, { cacheKey: 'AAPL' });
      await breaker.execute(async () => quoteResponse('MSFT', 400), fallback, { cacheKey: 'MSFT' });

      breaker.clearCache('AAPL');

      assert.equal(breaker.getCached('AAPL'), null, 'cleared key must return null');
      assert.notEqual(breaker.getCached('MSFT'), null, 'other key must survive clearCache(key)');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('clearCache() with no argument removes all keyed entries', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-clearall', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('AAPL', 150), fallback, { cacheKey: 'AAPL' });
      await breaker.execute(async () => quoteResponse('MSFT', 400), fallback, { cacheKey: 'MSFT' });

      breaker.clearCache();

      assert.equal(breaker.getCached('AAPL'), null, 'AAPL must be gone after clearCache()');
      assert.equal(breaker.getCached('MSFT'), null, 'MSFT must be gone after clearCache()');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('getCached returns null for expired entries', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      // Use 1ms TTL so entries expire immediately
      const breaker = createCircuitBreaker({ name: 'MQ-expiry', cacheTtlMs: 1 });
      const fallback = emptyMarketFallback();

      await breaker.execute(async () => quoteResponse('AAPL', 150), fallback, { cacheKey: 'AAPL' });

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(
        breaker.getCached('AAPL'),
        null,
        'expired entry must return null from getCached',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('getCachedOrDefault returns stale data when entry exists but is expired', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-stale', cacheTtlMs: 1 });
      const fallback = emptyMarketFallback();
      const data = quoteResponse('AAPL', 150);

      await breaker.execute(async () => data, fallback, { cacheKey: 'AAPL' });
      await new Promise((r) => setTimeout(r, 10));

      const result = breaker.getCachedOrDefault(fallback, 'AAPL');
      assert.equal(
        result.quotes[0]?.symbol,
        'AAPL',
        'getCachedOrDefault must return stale data rather than default',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('works with no cacheKey (backward compat — uses default key)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-compat', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();
      const data = quoteResponse('SPY', 560);

      // Old-style call without cacheKey option
      await breaker.execute(async () => data, fallback);

      const cached = breaker.getCached();
      assert.notEqual(cached, null, 'data cached with default key must be retrievable');
      assert.equal(cached.quotes[0]?.symbol, 'SPY');

      // Keyed call must not interfere
      await breaker.execute(async () => quoteResponse('QQQ', 480), fallback, { cacheKey: 'QQQ' });
      const stillSpy = breaker.getCached();
      assert.equal(stillSpy.quotes[0]?.symbol, 'SPY', 'keyed entry must not overwrite default key');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('SWR background refresh is per-key (does not block other keys)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-swr', cacheTtlMs: 1 });
      const fallback = emptyMarketFallback();

      // Populate two keys
      await breaker.execute(async () => quoteResponse('AAPL', 150), fallback, { cacheKey: 'TECH' });
      await breaker.execute(async () => quoteResponse('GLD', 300), fallback, { cacheKey: 'METALS' });

      // Wait for TTL to expire (entries become stale but still in cache)
      await new Promise((r) => setTimeout(r, 10));

      let techRefreshCalled = false;
      let metalsRefreshCalled = false;

      // Both stale — SWR should fire separate background refreshes
      const techResult = await breaker.execute(
        async () => { techRefreshCalled = true; return quoteResponse('AAPL', 155); },
        fallback,
        { cacheKey: 'TECH' },
      );
      const metalsResult = await breaker.execute(
        async () => { metalsRefreshCalled = true; return quoteResponse('GLD', 305); },
        fallback,
        { cacheKey: 'METALS' },
      );

      // SWR returns stale data immediately
      assert.equal(techResult.quotes[0]?.price, 150, 'SWR must return stale tech data');
      assert.equal(metalsResult.quotes[0]?.price, 300, 'SWR must return stale metals data');

      // Wait for background refreshes to complete
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(techRefreshCalled, 'tech key must trigger its own SWR refresh');
      assert.ok(metalsRefreshCalled, 'metals key must trigger its own SWR refresh');

      // After refresh, fresh data should be in cache (use getCachedOrDefault
      // because the 1ms TTL means even the refreshed entry expires instantly)
      const freshTech = breaker.getCachedOrDefault(fallback, 'TECH');
      const freshMetals = breaker.getCachedOrDefault(fallback, 'METALS');
      assert.equal(freshTech.quotes[0]?.price, 155, 'tech key must have refreshed data');
      assert.equal(freshMetals.quotes[0]?.price, 305, 'metals key must have refreshed data');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('SWR background refresh respects shouldCache predicate', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-swr-empty', cacheTtlMs: 1 });
      const fallback = emptyMarketFallback();

      // Populate key with valid data
      await breaker.execute(
        async () => quoteResponse('GC=F', 2800),
        fallback,
        { cacheKey: 'COMMODITY', shouldCache: (r) => r.quotes.length > 0 },
      );

      // Wait for TTL to expire (stale entry triggers SWR)
      await new Promise((r) => setTimeout(r, 10));

      // SWR will try refresh → backend returns empty → shouldCache rejects it
      await breaker.execute(
        async () => emptyMarketFallback(),
        fallback,
        { cacheKey: 'COMMODITY', shouldCache: (r) => r.quotes.length > 0 },
      );

      // Wait for SWR background fire-and-forget
      await new Promise((r) => setTimeout(r, 50));

      // The old good data must survive — SWR must NOT overwrite with empty
      const cached = breaker.getCachedOrDefault(fallback, 'COMMODITY');
      assert.equal(
        cached.quotes[0]?.symbol,
        'GC=F',
        'SWR must not overwrite cache with empty response when shouldCache rejects it',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('success on another key resets global failure count before cooldown trips', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-perkey-reset',
        cacheTtlMs: 5 * 60 * 1000,
        maxFailures: 2,
        cooldownMs: 60_000,
      });
      const fallback = emptyMarketFallback();
      const alwaysFail = () => { throw new Error('fail'); };

      // One failure on key A increments the breaker-wide failure count
      await breaker.execute(alwaysFail, fallback, { cacheKey: 'A' });
      assert.ok(!breaker.isOnCooldown(), 'one failure must not trip cooldown');

      // Success on key B resets the same breaker-wide failure count
      await breaker.execute(async () => quoteResponse('B', 100), fallback, { cacheKey: 'B' });

      // Another failure on key A should count as the first failure again, not the second
      await breaker.execute(alwaysFail, fallback, { cacheKey: 'A' });
      assert.ok(!breaker.isOnCooldown(), 'success on key B must reset global failure count');

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'A' });
      assert.ok(breaker.isOnCooldown(), 'two new consecutive failures should trip cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('cooldown helpers reflect breaker-wide state without a cache key', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-anycooldown',
        cacheTtlMs: 5 * 60 * 1000,
        maxFailures: 1,
        cooldownMs: 60_000,
      });
      const fallback = emptyMarketFallback();

      assert.ok(!breaker.isOnCooldown(), 'fresh breaker must not be on cooldown');

      await breaker.execute(
        () => { throw new Error('fail'); },
        fallback,
        { cacheKey: 'X' },
      );

      assert.ok(breaker.isOnCooldown(), 'isOnCooldown() must be true when breaker is on cooldown');
      assert.ok(
        breaker.getCooldownRemaining() > 0,
        'getCooldownRemaining() must report remaining breaker cooldown seconds',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('empty responses are not cached when shouldCache rejects them (P1)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({ name: 'MQ-empty', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();

      // Execute with an empty response and shouldCache that rejects empties
      const result = await breaker.execute(
        async () => emptyMarketFallback(),
        fallback,
        { cacheKey: 'GC=F,CL=F', shouldCache: (r) => r.quotes.length > 0 },
      );

      assert.deepEqual(result.quotes, [], 'the empty result must still be returned to the caller');
      assert.equal(
        breaker.getCached('GC=F,CL=F'),
        null,
        'empty response must NOT be cached when shouldCache returns false',
      );

      // A subsequent call should try the fetch again, not serve stale empty data
      let secondFetchCalled = false;
      await breaker.execute(
        async () => { secondFetchCalled = true; return quoteResponse('GC=F', 2880); },
        fallback,
        { cacheKey: 'GC=F,CL=F', shouldCache: (r) => r.quotes.length > 0 },
      );

      assert.ok(secondFetchCalled, 'second call must invoke fn again since nothing was cached');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('non-cacheable successes still reset failures (P2)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'MQ-shouldcache-reset',
        cacheTtlMs: 5 * 60 * 1000,
        maxFailures: 2,
        cooldownMs: 60_000,
      });
      const fallback = emptyMarketFallback();
      const alwaysFail = () => { throw new Error('upstream unavailable'); };
      const shouldCache = (r) => r.quotes.length > 0;

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F', shouldCache });
      assert.ok(!breaker.isOnCooldown(), 'first failure alone must not trip cooldown');

      await breaker.execute(
        async () => emptyMarketFallback(),
        fallback,
        { cacheKey: 'GC=F,CL=F', shouldCache },
      );
      assert.ok(!breaker.isOnCooldown(), 'successful empty fetch must clear failure state');

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F', shouldCache });
      assert.ok(!breaker.isOnCooldown(), 'failure count must restart after non-cacheable success');

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F', shouldCache });
      assert.ok(breaker.isOnCooldown(), 'two consecutive failures after reset should trip cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
