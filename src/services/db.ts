import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'newsreader';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // NormalizedStory store
      if (!db.objectStoreNames.contains('stories')) {
        const stories = db.createObjectStore('stories', { keyPath: 'id' });
        stories.createIndex('publishedAt', 'publishedAt');
        stories.createIndex('clusterId', 'clusterId');
        stories.createIndex('source', 'source');
        stories.createIndex('region', 'region');
        stories.createIndex('category_publishedAt', ['category', 'publishedAt']);
      }

      // StoryCluster store
      if (!db.objectStoreNames.contains('clusters')) {
        const clusters = db.createObjectStore('clusters', { keyPath: 'clusterId' });
        clusters.createIndex('firstSeen', 'firstSeen');
        clusters.createIndex('sourceCount', 'sourceCount');
        clusters.createIndex('region', 'region');
      }

      // CachedNarration store
      if (!db.objectStoreNames.contains('narrations')) {
        const narrations = db.createObjectStore('narrations', { keyPath: 'clusterId' });
        narrations.createIndex('expiresAt', 'expiresAt');
      }
    },
  });

  return dbPromise;
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['stories', 'clusters', 'narrations'], 'readwrite');
  await Promise.all([
    tx.objectStore('stories').clear(),
    tx.objectStore('clusters').clear(),
    tx.objectStore('narrations').clear(),
    tx.done,
  ]);
}

export async function exportAllData(): Promise<Record<string, unknown[]>> {
  const db = await getDb();
  const [stories, clusters, narrations] = await Promise.all([
    db.getAll('stories'),
    db.getAll('clusters'),
    db.getAll('narrations'),
  ]);
  return { stories, clusters, narrations };
}
