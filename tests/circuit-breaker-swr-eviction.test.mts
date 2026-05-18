/**
 * Regression for #3795 review-2 P1: when the circuit breaker's
 * stale-while-revalidate refresh returns a result that fails
 * `shouldCache` AND the caller has opted into `evictOnRefreshFailure`,
 * the existing stale cache entry MUST be evicted so the next call sees
 * no cache and runs the live path. Without eviction, SWR keeps serving
 * the stale entry indefinitely once upstream starts returning
 * degraded/empty responses.
 *
 * The eviction is opt-in by design — some callers (e.g. market quotes)
 * explicitly WANT the old "preserve previous good data across
 * transient blips" behaviour. That case is covered by
 * tests/market-quote-cache-keying.test.mjs (`SWR background refresh
 * respects shouldCache predicate`); this file covers the opt-in path
 * used by flight-prices and any other time-sensitive surface where the
 * degraded state is itself the important signal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CIRCUIT_BREAKER_URL = pathToFileURL(
  resolve(root, 'src/utils/circuit-breaker.ts'),
).href;

interface Payload {
  quotes: string[];
}

describe('CircuitBreaker — evictOnRefreshFailure (#3795 review-2)', () => {
  it('opt-in eviction: returns fresh empty on call after refresh fails shouldCache, NOT the stale prior entry', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-swr-evict`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      let callCount = 0;
      // Call 1 → live quotes (passes shouldCache).
      // Calls 2+ → empty (fails shouldCache).
      const fn = async (): Promise<Payload> => {
        callCount++;
        return callCount === 1 ? { quotes: ['real'] } : { quotes: [] };
      };
      const shouldCache = (r: Payload) => r.quotes.length > 0;
      const fallback: Payload = { quotes: [] };
      const opts = { shouldCache, evictOnRefreshFailure: true };

      const breaker = createCircuitBreaker({
        name: 'SWR Eviction Test (opt-in)',
        cacheTtlMs: 30,
        persistCache: false,
      });

      const r1 = await breaker.execute(fn, fallback, opts);
      assert.deepEqual(r1.quotes, ['real']);
      assert.equal(callCount, 1);

      await new Promise(r => setTimeout(r, 50));

      const r2 = await breaker.execute(fn, fallback, opts);
      assert.deepEqual(r2.quotes, ['real'], 'SWR must serve the stale entry immediately');

      await new Promise(r => setTimeout(r, 50));
      assert.equal(callCount, 2, 'background refresh must have fired');

      const r3 = await breaker.execute(fn, fallback, opts);
      assert.deepEqual(
        r3.quotes,
        [],
        'after refresh fails shouldCache, next call MUST run live and surface the degraded shape — not keep serving stale',
      );
      assert.equal(callCount, 3, 'fn must be re-invoked because cache was evicted');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('default behaviour preserved: without evictOnRefreshFailure, refresh that fails shouldCache keeps the stale entry', async () => {
    // Mirrors the market-quote-cache-keying test's intent: transient
    // upstream blips must NOT wipe previously-good cached data when the
    // caller hasn't opted into eviction.
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-swr-preserve`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      let callCount = 0;
      const fn = async (): Promise<Payload> => {
        callCount++;
        return callCount === 1 ? { quotes: ['real'] } : { quotes: [] };
      };
      const shouldCache = (r: Payload) => r.quotes.length > 0;
      const fallback: Payload = { quotes: [] };
      const opts = { shouldCache }; // no evictOnRefreshFailure → default false

      const breaker = createCircuitBreaker({
        name: 'SWR Preserve Test (default)',
        cacheTtlMs: 30,
        persistCache: false,
      });

      await breaker.execute(fn, fallback, opts);
      await new Promise(r => setTimeout(r, 50));
      await breaker.execute(fn, fallback, opts); // serves stale + bg refresh fails shouldCache
      await new Promise(r => setTimeout(r, 50));

      // Stale entry must SURVIVE — caller wants the previous good data
      // across transient upstream blips.
      const r3 = await breaker.execute(fn, fallback, opts);
      assert.deepEqual(
        r3.quotes,
        ['real'],
        'default behaviour: stale good data must survive a refresh that fails shouldCache',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
