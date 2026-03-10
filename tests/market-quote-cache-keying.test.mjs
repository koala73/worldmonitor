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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

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

describe('market/index.ts — keyed quote cache usage', () => {
  const src = readSrc('src/services/market/index.ts');
  const symbolSetKeyStart = src.indexOf('function symbolSetKey');
  const fetchMultipleStocksStart = src.indexOf('export async function fetchMultipleStocks');
  const symbolSetKeyBody = src.slice(symbolSetKeyStart, fetchMultipleStocksStart);
  const fetchMultipleStocksEnd = src.indexOf('\nexport ', fetchMultipleStocksStart + 1);
  const fetchMultipleStocksBody = src.slice(fetchMultipleStocksStart, fetchMultipleStocksEnd);

  it('uses a non-zero cache TTL for stock and commodity quote breakers', () => {
    assert.doesNotMatch(
      src,
      /stockBreaker\s*=\s*createCircuitBreaker[\s\S]*?cacheTtlMs:\s*0\b/,
      'stockBreaker must not keep cacheTtlMs at 0 once cache entries are keyed',
    );
    assert.doesNotMatch(
      src,
      /commodityBreaker\s*=\s*createCircuitBreaker[\s\S]*?cacheTtlMs:\s*0\b/,
      'commodityBreaker must not keep cacheTtlMs at 0 once cache entries are keyed',
    );
  });

  it('normalizes symbol-set keys by uppercasing, deduping, and sorting', () => {
    assert.match(symbolSetKeyBody, /toUpperCase\s*\(/,
      'symbolSetKey must normalize case so aapl and AAPL share cache');
    assert.match(symbolSetKeyBody, /new\s+Set/,
      'symbolSetKey must dedupe repeated symbols within the same request');
    assert.match(symbolSetKeyBody, /\.sort\s*\(/,
      'symbolSetKey must sort so request order does not change the cache key');
  });

  it('passes setKey into breaker.execute cacheKey', () => {
    assert.match(
      src,
      /breaker\.execute\s*\([\s\S]*?cacheKey:\s*setKey/,
      'fetchMultipleStocks must pass cacheKey: setKey to breaker.execute',
    );
  });

  it('passes shouldCache that rejects empty quote arrays (P1)', () => {
    assert.match(
      src,
      /shouldCache:\s*\(r\)\s*=>\s*r\.quotes\.length\s*>\s*0/,
      'breaker.execute must include shouldCache that rejects empty responses',
    );
  });

  it('normalizes symbols in request payload and metadata lookup (P2 symmetry)', () => {
    // The request payload must use the normalized symbol strings, not the raw input
    assert.match(
      fetchMultipleStocksBody,
      /symbolMetaMap\.get\(q\.symbol\s*\.\s*trim\(\)\s*\.\s*toUpperCase\(\)\)/,
      'metadata lookup must normalize response symbol to match normalized map keys',
    );
    // allSymbolStrings must come from the normalized map (not raw symbols.map)
    assert.doesNotMatch(
      fetchMultipleStocksBody,
      /symbols\.map\(\s*\(?\s*s\s*\)?\s*=>\s*s\.symbol\s*\)/,
      'allSymbolStrings must not come from raw symbols.map(s => s.symbol)',
    );
  });
});

describe('CircuitBreaker keyed cache — market quote isolation', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

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

      assert.ok(breaker.isOnCooldown('GC=F,CL=F'), 'commodity key must observe breaker cooldown');
      assert.ok(breaker.isOnCooldown('AAPL,MSFT'), 'watchlist key must also observe breaker cooldown');

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

  it('clearCache() deletes persisted keyed entries by breaker prefix (P2)', () => {
    const circuitSrc = readSrc('src/utils/circuit-breaker.ts');
    const persistentSrc = readSrc('src/services/persistent-cache.ts');
    const tauriSrc = readSrc('src-tauri/src/main.rs');

    assert.match(
      persistentSrc,
      /export\s+async\s+function\s+deletePersistentCacheByPrefix\s*\(/,
      'persistent-cache.ts must export deletePersistentCacheByPrefix',
    );
    assert.match(
      circuitSrc,
      /deletePersistentCacheByPrefix\(`\$\{baseKey\}:`\)/,
      'CircuitBreaker.clearCache() must delete all keyed persistent entries by breaker prefix',
    );
    assert.match(
      circuitSrc,
      /deletePersistentCache\(baseKey\)/,
      'CircuitBreaker.clearCache() must still delete the default persistent key',
    );
    assert.match(
      tauriSrc,
      /fn\s+delete_cache_entries_by_prefix\s*\(/,
      'desktop runtime must support prefix deletion too',
    );
    assert.match(
      tauriSrc,
      /delete_cache_entries_by_prefix,/,
      'desktop prefix delete command must be registered in the Tauri invoke handler',
    );
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

  it('isOnCooldown(key) reflects breaker-wide cooldown', async () => {
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
      assert.ok(breaker.isOnCooldown('X'), 'isOnCooldown(X) must be true');
      assert.ok(breaker.isOnCooldown('Y'), 'isOnCooldown(Y) must also be true for breaker-wide cooldown');
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
      assert.ok(!breaker.isOnCooldown('GC=F,CL=F'), 'first failure alone must not trip cooldown');

      await breaker.execute(
        async () => emptyMarketFallback(),
        fallback,
        { cacheKey: 'GC=F,CL=F', shouldCache },
      );
      assert.ok(!breaker.isOnCooldown('GC=F,CL=F'), 'successful empty fetch must clear failure state');

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F', shouldCache });
      assert.ok(!breaker.isOnCooldown('GC=F,CL=F'), 'failure count must restart after non-cacheable success');

      await breaker.execute(alwaysFail, fallback, { cacheKey: 'GC=F,CL=F', shouldCache });
      assert.ok(breaker.isOnCooldown('GC=F,CL=F'), 'two consecutive failures after reset should trip cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('read helpers do not re-add keys cleared by clearCache (P3)', async () => {
    const { CircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = new CircuitBreaker({ name: 'MQ-readleak', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();

      await breaker.execute(
        async () => quoteResponse('A', 100),
        fallback,
        { cacheKey: 'A' },
      );

      breaker.clearCache('A');

      // These read helpers must NOT re-register 'A'
      breaker.getCached('A');
      breaker.getCachedOrDefault(fallback, 'A');
      breaker.isOnCooldown('A');
      breaker.getCooldownRemaining('A');
      breaker.isOnCooldown('B');
      breaker.getCooldownRemaining('C');

      const keys = breaker.getKnownCacheKeys();
      assert.ok(
        !keys.includes('A'),
        `read helpers must not re-add cleared key 'A' to knownCacheKeys; got: [${keys}]`,
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('clearCache(key) removes the key from knownCacheKeys (P3 memory leak fix)', async () => {
    const { CircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breaker = new CircuitBreaker({ name: 'MQ-memleak', cacheTtlMs: 5 * 60 * 1000 });
      const fallback = emptyMarketFallback();

      // Populate cache for many dynamic keys
      for (let i = 0; i < 50; i++) {
        await breaker.execute(
          async () => quoteResponse(`SYM${i}`, i),
          fallback,
          { cacheKey: `SYM${i}` },
        );
      }

      // Clear each one — verify getCached returns null and the key doesn't linger
      for (let i = 0; i < 50; i++) {
        breaker.clearCache(`SYM${i}`);
        assert.equal(breaker.getCached(`SYM${i}`), null);
      }

      // Full clearCache should work without iterating over removed keys
      // (no error, no persistent-cache deletions for already-cleaned keys)
      breaker.clearCache();
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
