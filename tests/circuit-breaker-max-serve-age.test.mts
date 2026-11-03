/**
 * `maxServeAgeMs` is a per-call ceiling on how old a cached entry may be when
 * it is served (fresh hit, stale-while-revalidate, cooldown, or recovery
 * probe fallback). GDELT intelligence passes one hour so the breaker cannot
 * outlive the service's own last-good limit (#8509 known gap). Callers that
 * omit it keep the old behaviour: a stale entry is served until replaced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CIRCUIT_BREAKER_URL = pathToFileURL(resolve(root, 'src/utils/circuit-breaker.ts')).href;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failing = async (): Promise<string> => { throw new Error('offline'); };

async function freshBreaker(tag: string) {
  const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-${tag}`);
  mod.clearAllCircuitBreakers();
  const breaker = mod.createCircuitBreaker({ name: `MaxServeAge ${tag}`, cacheTtlMs: 10, cooldownMs: 60_000, persistCache: false });
  return { breaker, clear: () => mod.clearAllCircuitBreakers() };
}

async function openCooldown(breaker: { execute: (...args: unknown[]) => Promise<unknown> }) {
  await breaker.execute(failing, 'fallback', { cacheKey: 'other-a' });
  await breaker.execute(failing, 'fallback', { cacheKey: 'other-b' });
}

describe('CircuitBreaker — maxServeAgeMs', () => {
  it('without the option, an old entry is still served on SWR and on cooldown (unchanged)', async () => {
    const { breaker, clear } = await freshBreaker('default');
    try {
      assert.equal(await breaker.execute(async () => 'live', 'fallback', { cacheKey: 'k' }), 'live');
      await sleep(80);
      assert.equal(await breaker.execute(failing, 'fallback', { cacheKey: 'k' }), 'live');
      await sleep(5);
      await openCooldown(breaker);
      assert.equal(breaker.isOnCooldown(), true);
      assert.equal(await breaker.execute(failing, 'fallback', { cacheKey: 'k' }), 'live');
    } finally {
      clear();
    }
  });

  it('serves an entry younger than maxServeAgeMs through SWR', async () => {
    const { breaker, clear } = await freshBreaker('young');
    try {
      const opts = { cacheKey: 'k', maxServeAgeMs: 10_000 };
      assert.equal(await breaker.execute(async () => 'live', 'fallback', opts), 'live');
      await sleep(30);
      assert.equal(await breaker.execute(failing, 'fallback', opts), 'live');
    } finally {
      clear();
    }
  });

  it('does not serve an entry older than maxServeAgeMs; runs live and returns the default on failure', async () => {
    const { breaker, clear } = await freshBreaker('old-swr');
    try {
      const opts = { cacheKey: 'k', maxServeAgeMs: 40 };
      assert.equal(await breaker.execute(async () => 'live', 'fallback', opts), 'live');
      await sleep(60);
      let calls = 0;
      const result = await breaker.execute(async () => { calls++; throw new Error('offline'); }, 'fallback', opts);
      assert.equal(result, 'fallback');
      assert.equal(calls, 1, 'the expired entry must not short-circuit the live call');
      assert.deepEqual(breaker.getKnownCacheKeys().includes('k'), false);
    } finally {
      clear();
    }
  });

  it('does not serve an entry older than maxServeAgeMs while on cooldown', async () => {
    const { breaker, clear } = await freshBreaker('old-cooldown');
    try {
      const opts = { cacheKey: 'k', maxServeAgeMs: 40 };
      assert.equal(await breaker.execute(async () => 'live', 'fallback', opts), 'live');
      await sleep(60);
      await openCooldown(breaker);
      assert.equal(breaker.isOnCooldown(), true);
      assert.equal(await breaker.execute(failing, 'fallback', opts), 'fallback');
      assert.equal(breaker.getDataState().mode, 'unavailable');
    } finally {
      clear();
    }
  });

  it('treats an entry with a non-finite timestamp as expired', async () => {
    const { breaker, clear } = await freshBreaker('nan');
    try {
      breaker.recordSuccess('legacy', 'k');
      (breaker as unknown as { cache: Map<string, { timestamp: number }> }).cache.get('k')!.timestamp = Number.NaN;
      assert.equal(await breaker.execute(failing, 'fallback', { cacheKey: 'k', maxServeAgeMs: 60_000 }), 'fallback');
    } finally {
      clear();
    }
  });
});
