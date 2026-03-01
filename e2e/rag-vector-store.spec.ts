import { expect, test, type Page } from '@playwright/test';

let sharedPage: Page;

test.describe('RAG vector store (worker-side)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    sharedPage = await browser.newPage();
    await sharedPage.goto('/tests/runtime-harness.html');
    const supported = await sharedPage.evaluate(async () => {
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      const ok = await mlWorker.init();
      if (!ok) return false;
      await mlWorker.loadModel('embeddings');
      return true;
    });
    if (!supported) test.skip(true, 'ML worker not supported');
  });

  test.afterAll(async () => {
    await sharedPage?.close();
  });

  async function clearVectorDB() {
    await sharedPage.evaluate(async () => {
      const dbs = await indexedDB.databases?.() ?? [];
      for (const db of dbs) {
        if (db.name === 'worldmonitor_vector_store') indexedDB.deleteDatabase(db.name);
      }
    });
  }

  test('ingest → count → search round-trip', async () => {
    await clearVectorDB();
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');

      const items = [
        { text: 'Iran sanctions debate intensifies in Washington', pubDate: Date.now() - 86400000, source: 'Reuters', url: 'https://example.com/1' },
        { text: 'Ukraine frontline positions shift near Bakhmut', pubDate: Date.now() - 172800000, source: 'AP', url: 'https://example.com/2' },
        { text: 'China trade talks resume with EU delegation', pubDate: Date.now() - 259200000, source: 'BBC', url: 'https://example.com/3' },
      ];

      const stored = await mlWorker.vectorStoreIngest(items);
      const count = await mlWorker.vectorStoreCount();
      const results = await mlWorker.vectorStoreSearch(['Iran sanctions policy'], 5, 0.3);

      return { stored, count, results, topText: results[0]?.text ?? '' };
    });

    expect(result.stored).toBe(3);
    expect(result.count).toBe(3);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.topText).toContain('Iran');
    expect(result.results[0]!.score).toBeGreaterThanOrEqual(0.3);
  });

  test('minScore filtering excludes dissimilar results', async () => {
    await clearVectorDB();
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');

      await mlWorker.vectorStoreIngest([
        { text: 'Weather forecast sunny skies tomorrow morning', pubDate: Date.now(), source: 'Weather', url: '' },
      ]);

      const results = await mlWorker.vectorStoreSearch(['Iran nuclear weapons program sanctions'], 5, 0.8);
      return { count: results.length };
    });

    expect(result.count).toBe(0);
  });

  test('search returns empty when embeddings model not loaded', async () => {
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');
      await mlWorker.unloadModel('embeddings');
      const results = await mlWorker.vectorStoreSearch(['test query'], 5, 0.3);
      // Reload embeddings for subsequent tests
      await mlWorker.loadModel('embeddings');
      return { count: results.length };
    });

    expect(result.count).toBe(0);
  });

  test('deduplicates across multi-query matches keeping max score', async () => {
    await clearVectorDB();
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');

      await mlWorker.vectorStoreIngest([
        { text: 'Military operations expand in eastern regions', pubDate: Date.now(), source: 'Reuters', url: 'https://example.com/1' },
      ]);

      const results = await mlWorker.vectorStoreSearch(
        ['military operations', 'eastern military expansion'],
        5,
        0.2,
      );

      return { count: results.length };
    });

    expect(result.count).toBe(1);
  });

  test('handles empty URL in items', async () => {
    await clearVectorDB();
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');

      const stored = await mlWorker.vectorStoreIngest([
        { text: 'Headline without a URL', pubDate: Date.now(), source: 'Test', url: '' },
        { text: 'Another headline no URL', pubDate: Date.now(), source: 'Test', url: '' },
      ]);

      const count = await mlWorker.vectorStoreCount();
      return { stored, count };
    });

    expect(result.stored).toBe(2);
    expect(result.count).toBe(2);
  });

  test('worker-unavailable path degrades gracefully', async () => {
    const result = await sharedPage.evaluate(async () => {
      const mod = await import('/src/services/ml-worker.ts');
      const { mlWorker } = mod;

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

  test('queue resilience after IDB error', async () => {
    await clearVectorDB();
    const result = await sharedPage.evaluate(async () => {
      const { mlWorker } = await import('/src/services/ml-worker.ts');

      await mlWorker.vectorStoreIngest([
        { text: 'Valid headline about economic policy', pubDate: Date.now(), source: 'Reuters', url: 'https://example.com/1' },
      ]);
      const countBefore = await mlWorker.vectorStoreCount();

      indexedDB.deleteDatabase('worldmonitor_vector_store');

      try {
        await mlWorker.vectorStoreIngest([
          { text: 'Headline during IDB disruption', pubDate: Date.now(), source: 'Test', url: '' },
        ]);
      } catch {
        // Expected — IDB handle was invalidated
      }

      await mlWorker.vectorStoreIngest([
        { text: 'Recovery headline after IDB reset', pubDate: Date.now(), source: 'AP', url: 'https://example.com/3' },
      ]);
      const countAfter = await mlWorker.vectorStoreCount();

      return { countBefore, countAfter, recovered: countAfter > 0 };
    });

    expect(result.countBefore).toBe(1);
    expect(result.recovered).toBe(true);
  });
});
