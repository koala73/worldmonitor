import { expect, test } from '@playwright/test';

test.describe('RAG vector store (worker-side)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');
    await page.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const dbs = await indexedDB.databases?.() ?? [];
      for (const db of dbs) {
        if (db.name === 'worldmonitor_vector_store') indexedDB.deleteDatabase(db.name);
      }
    });
  });

  test('ingest → count → search round-trip', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true, reason: 'ML worker not supported' };

      await mlWorker.loadModel('embeddings');

      const items = [
        { text: 'Iran sanctions debate intensifies in Washington', pubDate: Date.now() - 86400000, source: 'Reuters', url: 'https://example.com/1' },
        { text: 'Ukraine frontline positions shift near Bakhmut', pubDate: Date.now() - 172800000, source: 'AP', url: 'https://example.com/2' },
        { text: 'China trade talks resume with EU delegation', pubDate: Date.now() - 259200000, source: 'BBC', url: 'https://example.com/3' },
      ];

      const stored = await mlWorker.vectorStoreIngest(items);
      const count = await mlWorker.vectorStoreCount();
      const results = await mlWorker.vectorStoreSearch(['Iran sanctions policy'], 5, 0.3);

      return { skip: false, stored, count, results, topText: results[0]?.text ?? '' };
    });

    if (result.skip) {
      test.skip(true, result.reason);
      return;
    }

    expect(result.stored).toBe(3);
    expect(result.count).toBe(3);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.topText).toContain('Iran');
    expect(result.results[0]!.score).toBeGreaterThanOrEqual(0.3);
  });

  test('minScore filtering excludes dissimilar results', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true };

      await mlWorker.loadModel('embeddings');

      await mlWorker.vectorStoreIngest([
        { text: 'Weather forecast sunny skies tomorrow morning', pubDate: Date.now(), source: 'Weather', url: '' },
      ]);

      const results = await mlWorker.vectorStoreSearch(['Iran nuclear weapons program sanctions'], 5, 0.8);
      return { skip: false, count: results.length };
    });

    if (result.skip) {
      test.skip(true, 'ML worker not supported');
      return;
    }

    expect(result.count).toBe(0);
  });

  test('search returns empty when embeddings model not loaded', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true };

      const results = await mlWorker.vectorStoreSearch(['test query'], 5, 0.3);
      return { skip: false, count: results.length };
    });

    if (result.skip) {
      test.skip(true, 'ML worker not supported');
      return;
    }

    expect(result.count).toBe(0);
  });

  test('deduplicates across multi-query matches keeping max score', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true };

      await mlWorker.loadModel('embeddings');

      await mlWorker.vectorStoreIngest([
        { text: 'Military operations expand in eastern regions', pubDate: Date.now(), source: 'Reuters', url: 'https://example.com/1' },
      ]);

      const results = await mlWorker.vectorStoreSearch(
        ['military operations', 'eastern military expansion'],
        5,
        0.2,
      );

      return { skip: false, count: results.length };
    });

    if (result.skip) {
      test.skip(true, 'ML worker not supported');
      return;
    }

    expect(result.count).toBe(1);
  });

  test('handles empty URL in items', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true };

      await mlWorker.loadModel('embeddings');

      const stored = await mlWorker.vectorStoreIngest([
        { text: 'Headline without a URL', pubDate: Date.now(), source: 'Test', url: '' },
        { text: 'Another headline no URL', pubDate: Date.now(), source: 'Test', url: '' },
      ]);

      const count = await mlWorker.vectorStoreCount();
      return { skip: false, stored, count };
    });

    if (result.skip) {
      test.skip(true, 'ML worker not supported');
      return;
    }

    expect(result.stored).toBe(2);
    expect(result.count).toBe(2);
  });

  test('worker-unavailable path degrades gracefully', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const mod = await import('/src/services/ml-worker.ts');
      const MLWorkerManagerClass = (mod as unknown as { MLWorkerManager: new () => typeof mod.mlWorker }).MLWorkerManager;

      if (!MLWorkerManagerClass) {
        const { mlWorker } = mod;
        if (!mlWorker.isAvailable) {
          const ingestResult = await mlWorker.vectorStoreIngest([
            { text: 'test', pubDate: Date.now(), source: 'Test', url: '' },
          ]);
          const searchResult = await mlWorker.vectorStoreSearch(['test'], 5, 0.3);
          const countResult = await mlWorker.vectorStoreCount();
          return { stored: ingestResult, searchCount: searchResult.length, count: countResult };
        }
      }

      const { mlWorker } = mod;
      if (!mlWorker.isAvailable) {
        const ingestResult = await mlWorker.vectorStoreIngest([
          { text: 'test', pubDate: Date.now(), source: 'Test', url: '' },
        ]);
        const searchResult = await mlWorker.vectorStoreSearch(['test'], 5, 0.3);
        const countResult = await mlWorker.vectorStoreCount();
        return { stored: ingestResult, searchCount: searchResult.length, count: countResult };
      }

      const fresh = Object.create(Object.getPrototypeOf(mlWorker));
      Object.assign(fresh, { worker: null, isReady: false, pendingRequests: new Map(), loadedModels: new Set(), capabilities: null });
      const ingestResult = await fresh.vectorStoreIngest([
        { text: 'test', pubDate: Date.now(), source: 'Test', url: '' },
      ]);
      const searchResult = await fresh.vectorStoreSearch(['test'], 5, 0.3);
      const countResult = await fresh.vectorStoreCount();
      return { stored: ingestResult, searchCount: searchResult.length, count: countResult };
    });

    expect(result.stored).toBe(0);
    expect(result.searchCount).toBe(0);
    expect(result.count).toBe(0);
  });

  test('queue resilience after IDB error', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return { skip: true };

      await mlWorker.loadModel('embeddings');

      await mlWorker.vectorStoreIngest([
        { text: 'Valid headline about economic policy', pubDate: Date.now(), source: 'Reuters', url: 'https://example.com/1' },
      ]);
      const countBefore = await mlWorker.vectorStoreCount();

      // Delete the IDB while the worker holds a handle — next op should fail then recover
      indexedDB.deleteDatabase('worldmonitor_vector_store');

      // This ingest may fail internally (stale IDB handle), but should not break the queue
      try {
        await mlWorker.vectorStoreIngest([
          { text: 'Headline during IDB disruption', pubDate: Date.now(), source: 'Test', url: '' },
        ]);
      } catch {
        // Expected — IDB handle was invalidated
      }

      // Queue should recover: subsequent ops work after IDB reconnect
      await mlWorker.vectorStoreIngest([
        { text: 'Recovery headline after IDB reset', pubDate: Date.now(), source: 'AP', url: 'https://example.com/3' },
      ]);
      const countAfter = await mlWorker.vectorStoreCount();

      return { skip: false, countBefore, countAfter, recovered: countAfter > 0 };
    });

    if (result.skip) {
      test.skip(true, 'ML worker not supported');
      return;
    }

    expect(result.countBefore).toBe(1);
    expect(result.recovered).toBe(true);
  });
});
