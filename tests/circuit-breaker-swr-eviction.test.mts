/**
 * Regression for #3795 review-2 P1: when the circuit breaker's
 * stale-while-revalidate refresh returns a result that fails
 * `shouldCache`, the existing stale cache entry MUST be evicted so the
 * next call sees no cache and runs the live path. Without eviction,
 * SWR keeps serving the stale entry indefinitely once upstream starts
 * returning degraded/empty responses.
 *
 * Companion of the (now-merged) flight-prices fail-closed work: every
 * breaker caller using `shouldCache` with persistCache + SWR has the
 * same latent bug if not fixed here.
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

describe('CircuitBreaker — SWR refresh evicts stale entry when shouldCache fails (#3795 review-2)', () => {
  it('returns fresh empty result on call after refresh fails shouldCache, NOT the stale prior entry', async () => {
    // Dynamic import with a cache-busting query so each test gets its
    // own module-level breaker registry.
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

      const breaker = createCircuitBreaker({
        name: 'SWR Eviction Test',
        cacheTtlMs: 30, // 30ms so we hit SWR quickly
        persistCache: false,
      });

      // Call 1: cache miss → fn runs → real data cached.
      const r1 = await breaker.execute(fn, fallback, { shouldCache });
      assert.deepEqual(r1.quotes, ['real']);
      assert.equal(callCount, 1);

      // Wait for TTL to lapse so call 2 enters the SWR branch.
      await new Promise(r => setTimeout(r, 50));

      // Call 2: cache stale → returns stale + triggers background refresh.
      const r2 = await breaker.execute(fn, fallback, { shouldCache });
      assert.deepEqual(r2.quotes, ['real'], 'SWR must serve the stale entry immediately');

      // Wait for the background refresh promise to settle. The refresh
      // calls fn (call 2 returns empty), which fails shouldCache, and
      // (post-fix) evicts the stale entry.
      await new Promise(r => setTimeout(r, 50));
      assert.equal(callCount, 2, 'background refresh must have fired');

      // Call 3: WITH eviction (the fix) → cache empty → fn runs in the
      // synchronous live path and returns the fresh empty quotes.
      // WITHOUT eviction → stale 'real' served again, looping forever.
      const r3 = await breaker.execute(fn, fallback, { shouldCache });
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
});
