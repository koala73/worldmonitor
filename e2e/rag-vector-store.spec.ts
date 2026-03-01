import { expect, test } from '@playwright/test';

test.describe('vector-store (IndexedDB)', () => {
    test.beforeEach(async ({ page }) => {
        // Navigate to harness and clear IndexedDB to ensure a clean state
        await page.goto('/tests/runtime-harness.html');
        await page.evaluate(async () => {
            return new Promise<void>((resolve, reject) => {
                const req = indexedDB.deleteDatabase('worldmonitor_vector_store');
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
                req.onblocked = () => resolve(); // Assume cleared
            });
        });
    });

    test('stores, searches, and prunes vectors correctly', async ({ page }) => {
        // All IndexedDB interactions must happen inside the browser context
        const result = await page.evaluate(async () => {
            const {
                storeVectors,
                searchSimilar,
                getVectorCount,
                pruneOldVectors,
                VECTOR_TTL_MS
            } = await import('/src/services/vector-store.ts');

            // 1. Initial state
            const initialCount = await getVectorCount();

            // 2. Store mock vectors
            const now = Date.now();
            const mockVectors = [
                {
                    id: 'vec1',
                    text: 'Economic policy changing in Europe',
                    embedding: [1.0, 0.0, 0.0], // completely artificial 3D embedding for testing matching
                    pubDate: now,
                    source: 'Test Source',
                    url: 'http://test.com/1',
                },
                {
                    id: 'vec2',
                    text: 'New geopolitical alliances formed',
                    embedding: [0.0, 1.0, 0.0],
                    pubDate: now,
                    source: 'Test Source',
                    url: '',
                },
                {
                    id: 'vec3',
                    text: 'Old news that should be pruned',
                    embedding: [0.0, 0.0, 1.0],
                    pubDate: now - VECTOR_TTL_MS - 10000, // Older than TTL
                    source: 'Old Source',
                    url: '',
                }
            ];

            // To make TS happy, we define exact 384 dimensions matching the model, but since we pad with zero...
            // wait, the cosine similarity function simply correlates whatever arrays we pass. It just iterates Math.min(len) or similar.
            // Let's actually pad it to 384 dimensions to be safe if the cosine sim assumes equal length
            const pad = (arr: number[]) => {
                const full = new Array(384).fill(0);
                arr.forEach((val, i) => full[i] = val);
                return full;
            };

            const vectors = mockVectors.map(v => ({ ...v, embedding: pad(v.embedding) }));
            await storeVectors(vectors);

            const countAfterStore = await getVectorCount();

            // 3. Search Similar
            // Query looking for "Economy" -> matches vec1 (1.0, 0.0, 0.0)
            const queryVec = pad([0.9, 0.1, 0.0]);
            const searchResults = await searchSimilar(queryVec, 2);

            // 4. Prune Old Vectors
            await pruneOldVectors(now - VECTOR_TTL_MS);
            const countAfterPrune = await getVectorCount();

            return {
                initialCount,
                countAfterStore,
                searchResults: searchResults.map(r => ({ id: r.id })),
                countAfterPrune,
            };
        });

        // Validations
        expect(result.initialCount).toBe(0);
        expect(result.countAfterStore).toBe(3);

        // Should find vec1 as highest match
        expect(result.searchResults.length).toBeGreaterThan(0);
        expect(result.searchResults[0]!.id).toBe('vec1');

        // After pruning, the old vector (vec3) should be deleted
        expect(result.countAfterPrune).toBe(2);
    });
});
