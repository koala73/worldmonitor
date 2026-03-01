
import { isStorageQuotaExceeded, isQuotaError, markStorageQuotaExceeded } from '@/utils';

export interface VectorEntry {
  id: string; // Hash or unique identifier of the news item
  text: string; // The text content that was embedded (typically headline)
  embedding: number[]; // The vector embedding
  pubDate: number; // Publish date timestamp
  source: string; // News source
  url: string; // Link to the article
  tags?: string[]; // Optional tags (e.g. locationName)
}

const VECTOR_DB_NAME = 'worldmonitor_vector_store';
const VECTOR_DB_VERSION = 1;
const STORE_NAME = 'embeddings';
export const VECTOR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let dbPromise: Promise<IDBDatabase> | null = null;

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function getDatabase(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB unavailable for vector store'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);

    request.onerror = () => reject(request.error ?? new Error('Failed to open vector IndexedDB'));

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Create store with primary key 'id'
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // Create an index on pubDate to allow pruning old vectors
        store.createIndex('by_date', 'pubDate', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
  });

  return dbPromise;
}

/**
 * Persists an array of vectorized news entries to IndexedDB
 */
export async function storeVectors(entries: VectorEntry[]): Promise<void> {
  if (!isIndexedDbAvailable() || isStorageQuotaExceeded()) return;

  try {
    const db = await getDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      const store = tx.objectStore(STORE_NAME);
      for (const entry of entries) {
        store.put(entry);
      }
    });
  } catch (error) {
    if (isQuotaError(error)) {
      markStorageQuotaExceeded();
    }
    console.warn('[vector-store] Failed to store vectors', error);
  }
}

/**
 * Retrieves all stored vector entries
 * Memory implication: This could be large. We might want to limit this in a real scalable app,
 * but for client-side local RAG with recent news, it should be fine.
 */
export async function getAllVectors(): Promise<VectorEntry[]> {
  if (!isIndexedDbAvailable()) return [];

  try {
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result as VectorEntry[]);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('[vector-store] Failed to get all vectors', error);
    return [];
  }
}

/**
 * Returns the total count of stored vectors. Useful for tests and health checks.
 */
export async function getVectorCount(): Promise<number> {
  if (!isIndexedDbAvailable()) return 0;

  try {
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('[vector-store] Failed to get vector count', error);
    return 0;
  }
}

/**
 * Prunes vectors older than a certain timestamp to prevent unbounded growth.
 */
export async function pruneOldVectors(olderThanMs: number): Promise<void> {
  if (!isIndexedDbAvailable()) return;

  try {
    const db = await getDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_date');
      const range = IDBKeyRange.upperBound(olderThanMs);
      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  } catch (error) {
    console.warn('[vector-store] Failed to prune vectors', error);
  }
}

/**
 * Computes cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Searches the vector store for the most similar entries to the query embedding.
 */
export async function searchSimilar(queryEmbedding: number[], topK: number = 5): Promise<VectorEntry[]> {
  const allVectors = await getAllVectors();
  if (allVectors.length === 0) return [];

  const scoredEntries = allVectors.map(entry => ({
    entry,
    score: cosineSimilarity(queryEmbedding, entry.embedding)
  }));

  // Sort by highest score first
  scoredEntries.sort((a, b) => b.score - a.score);

  return scoredEntries.slice(0, topK).map(s => s.entry);
}
