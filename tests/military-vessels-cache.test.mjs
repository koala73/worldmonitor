import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/services/military-vessels.ts'), 'utf8');
const circuitBreakerUrl = pathToFileURL(resolve(root, 'src/utils/circuit-breaker.ts')).href;

describe('military vessel refresh cadence', () => {
  it('uses one 30-second breaker cache for AIS vessel snapshots', () => {
    assert.match(
      source,
      /cacheTtlMs:\s*30\s*\*\s*1000/,
      'the breaker must own the 30-second vessel refresh cadence',
    );
    assert.doesNotMatch(
      source,
      /vesselCache|CACHE_TTL/,
      'the service must not retain a second in-memory vessel cache',
    );
  });

  it('refreshes the breaker-backed snapshot after its cache window expires', async () => {
    const { clearAllCircuitBreakers, createCircuitBreaker } = await import(
      `${circuitBreakerUrl}?t=${Date.now()}-military-vessels-cache`,
    );
    const breaker = createCircuitBreaker({
      name: 'Military Vessel Refresh Cadence Test',
      cacheTtlMs: 30,
      persistCache: false,
    });
    let refreshCount = 0;

    try {
      const fetchSnapshot = async () => ({ snapshot: ++refreshCount });
      const fallback = { snapshot: 0 };

      assert.deepEqual(await breaker.execute(fetchSnapshot, fallback), { snapshot: 1 });
      assert.deepEqual(await breaker.execute(fetchSnapshot, fallback), { snapshot: 1 });
      assert.equal(refreshCount, 1, 'a fresh breaker cache entry must avoid a second refresh');

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      assert.deepEqual(
        await breaker.execute(fetchSnapshot, fallback, { staleRefreshMode: 'await' }),
        { snapshot: 2 },
      );
      assert.equal(refreshCount, 2, 'an expired breaker cache entry must refresh the snapshot');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
