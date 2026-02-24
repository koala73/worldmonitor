import { expect, test } from '@playwright/test';

/**
 * Circuit Breaker persistent cache tests.
 *
 * Each test creates a CircuitBreaker directly (avoiding the global registry),
 * exercises the persistence path via IndexedDB, and cleans up after itself.
 */
test.describe('circuit breaker persistent cache', () => {

  test('recordSuccess persists data to IndexedDB', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { getPersistentCache, deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-persist-${Date.now()}`;
      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 60_000,
        persistCache: true,
      });

      const payload = { value: 42 };
      try {
        const result = await breaker.execute(async () => payload, { value: 0 });

        // Give fire-and-forget write time to complete
        await new Promise((r) => setTimeout(r, 200));

        const entry = await getPersistentCache<{ value: number }>(`breaker:${name}`);

        return {
          executeResult: result.value,
          persistedData: entry?.data?.value ?? null,
          persistedAge: entry ? Date.now() - entry.updatedAt : null,
        };
      } finally {
        await deletePersistentCache(`breaker:${name}`);
      }
    });

    expect(result.executeResult).toBe(42);
    expect(result.persistedData).toBe(42);
    expect(result.persistedAge).not.toBeNull();
    expect(result.persistedAge as number).toBeLessThan(5000);
  });

  test('new breaker instance hydrates from IndexedDB on first execute', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { setPersistentCache, deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-hydrate-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      // Pre-seed IndexedDB with a recent entry (simulating a previous session)
      await setPersistentCache(cacheKey, { value: 99 });

      let fetchCalled = false;
      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 60_000,
        persistCache: true,
      });

      try {
        const result = await breaker.execute(async () => {
          fetchCalled = true;
          return { value: -1 };
        }, { value: 0 });

        return {
          result: result.value,
          fetchCalled,
          dataState: breaker.getDataState().mode,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    // Should serve hydrated data, NOT call fetch
    expect(result.result).toBe(99);
    expect(result.fetchCalled).toBe(false);
    expect(result.dataState).toBe('cached');
  });

  test('expired persistent entry triggers fresh fetch (TTL respected)', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-ttl-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      // Pre-seed IndexedDB with an entry that's older than the TTL.
      // We do this by writing directly to IndexedDB with an old timestamp.
      const DB_NAME = 'worldmonitor_persistent_cache';
      const STORE = 'entries';

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({
            key: cacheKey,
            data: { value: 111 },
            updatedAt: Date.now() - 120_000, // 2 minutes ago
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      let fetchCalled = false;
      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 5_000, // 5 second TTL — the persistent entry (2min old) is expired
        persistCache: true,
      });

      try {
        const result = await breaker.execute(async () => {
          fetchCalled = true;
          return { value: 222 };
        }, { value: 0 });

        // Wait for fire-and-forget write
        await new Promise((r) => setTimeout(r, 200));

        return {
          result: result.value,
          fetchCalled,
          dataState: breaker.getDataState().mode,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    // Persistent entry was expired, so fetch MUST have been called
    expect(result.fetchCalled).toBe(true);
    expect(result.result).toBe(222);
    expect(result.dataState).toBe('live');
  });

  test('persistent entry older than 24h stale ceiling is not hydrated', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-stale-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      const DB_NAME = 'worldmonitor_persistent_cache';
      const STORE = 'entries';

      // Seed with a 25-hour-old entry
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({
            key: cacheKey,
            data: { value: 333 },
            updatedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      let fetchCalled = false;
      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 999_999_999, // Very long TTL — would serve if hydrated
        persistCache: true,
      });

      try {
        const result = await breaker.execute(async () => {
          fetchCalled = true;
          return { value: 444 };
        }, { value: 0 });

        return {
          result: result.value,
          fetchCalled,
          dataState: breaker.getDataState().mode,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    // 25h entry exceeds 24h ceiling, should NOT be hydrated — fetch must fire
    expect(result.fetchCalled).toBe(true);
    expect(result.result).toBe(444);
    expect(result.dataState).toBe('live');
  });

  test('clearCache removes persistent entry from IndexedDB', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { getPersistentCache, deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-clear-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 60_000,
        persistCache: true,
      });

      try {
        // Populate cache
        await breaker.execute(async () => ({ value: 555 }), { value: 0 });
        await new Promise((r) => setTimeout(r, 200));

        const beforeClear = await getPersistentCache<{ value: number }>(cacheKey);

        // Clear cache
        breaker.clearCache();
        await new Promise((r) => setTimeout(r, 200));

        const afterClear = await getPersistentCache<{ value: number }>(cacheKey);

        return {
          beforeClearValue: beforeClear?.data?.value ?? null,
          afterClearValue: afterClear?.data?.value ?? null,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    expect(result.beforeClearValue).toBe(555);
    expect(result.afterClearValue).toBeNull();
  });

  test('persistCache disabled when cacheTtlMs is 0', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { getPersistentCache, deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-disabled-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 0, // Should auto-disable persistence
      });

      try {
        await breaker.execute(async () => ({ value: 666 }), { value: 0 });
        await new Promise((r) => setTimeout(r, 200));

        const entry = await getPersistentCache<{ value: number }>(cacheKey);

        return {
          persisted: entry?.data?.value ?? null,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    // cacheTtlMs=0 auto-disables persistence — nothing should be in IndexedDB
    expect(result.persisted).toBeNull();
  });

  test('network failure after reload serves persistent fallback', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { CircuitBreaker } = await import('/src/utils/circuit-breaker.ts');
      const { setPersistentCache, deletePersistentCache } = await import('/src/services/persistent-cache.ts');

      const name = `test-fallback-${Date.now()}`;
      const cacheKey = `breaker:${name}`;

      // Seed IndexedDB with data that is OUTSIDE cacheTtlMs but WITHIN 24h ceiling.
      // This simulates a reload 30 minutes after last successful fetch.
      await setPersistentCache(cacheKey, { value: 777 });

      // Backdate the updatedAt to 30 minutes ago
      const DB_NAME = 'worldmonitor_persistent_cache';
      const STORE = 'entries';
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({
            key: cacheKey,
            data: { value: 777 },
            updatedAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      const breaker = new CircuitBreaker<{ value: number }>({
        name,
        cacheTtlMs: 600_000, // 10 min TTL — 30min entry is expired
        persistCache: true,
      });

      try {
        // Fetch fails — should fall back to stale persistent data via getCachedOrDefault
        const result = await breaker.execute(async () => {
          throw new Error('Network failure');
        }, { value: 0 });

        return {
          result: result.value,
          dataState: breaker.getDataState().mode,
        };
      } finally {
        await deletePersistentCache(cacheKey);
      }
    });

    // Stale persistent data (777) is better than default (0)
    expect(result.result).toBe(777);
    expect(result.dataState).toBe('unavailable');
  });
});
