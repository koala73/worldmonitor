import { getDb } from '@/services/db';
import type { NormalizedStory } from '@/types/news-reader';

// ── Serialization helpers (IndexedDB can't store Date directly reliably) ──

interface StoredStory extends Omit<NormalizedStory, 'publishedAt' | 'ingestedAt'> {
  publishedAt: string;
  ingestedAt: string;
}

function toStored(story: NormalizedStory): StoredStory {
  return {
    ...story,
    publishedAt: story.publishedAt.toISOString(),
    ingestedAt: story.ingestedAt.toISOString(),
  };
}

function fromStored(stored: StoredStory): NormalizedStory {
  return {
    ...stored,
    publishedAt: new Date(stored.publishedAt),
    ingestedAt: new Date(stored.ingestedAt),
  };
}

// ── CRUD operations ───────────────────────────────────────────────────────

export async function putStory(story: NormalizedStory): Promise<void> {
  const db = await getDb();
  await db.put('stories', toStored(story));
}

export async function putStories(stories: NormalizedStory[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('stories', 'readwrite');
  for (const story of stories) {
    tx.store.put(toStored(story));
  }
  await tx.done;
}

export async function getStory(id: string): Promise<NormalizedStory | undefined> {
  const db = await getDb();
  const stored = await db.get('stories', id);
  return stored ? fromStored(stored as unknown as StoredStory) : undefined;
}

export async function getStoriesByCluster(clusterId: string): Promise<NormalizedStory[]> {
  const db = await getDb();
  const index = db.transaction('stories').store.index('clusterId');
  const stored = await index.getAll(clusterId);
  return stored.map(s => fromStored(s as unknown as StoredStory));
}

export async function getRecentStories(limit = 100): Promise<NormalizedStory[]> {
  const db = await getDb();
  const tx = db.transaction('stories');
  const index = tx.store.index('publishedAt');
  const results: NormalizedStory[] = [];
  let cursor = await index.openCursor(null, 'prev');
  while (cursor && results.length < limit) {
    results.push(fromStored(cursor.value as unknown as StoredStory));
    cursor = await cursor.continue();
  }
  return results;
}

export async function getAllStoryIds(): Promise<Set<string>> {
  const db = await getDb();
  const keys = await db.getAllKeys('stories');
  return new Set(keys as string[]);
}

export async function getStoriesAfter(since: Date): Promise<NormalizedStory[]> {
  const db = await getDb();
  const index = db.transaction('stories').store.index('publishedAt');
  const range = IDBKeyRange.lowerBound(since.toISOString());
  const stored = await index.getAll(range);
  return stored.map(s => fromStored(s as unknown as StoredStory));
}

export async function deleteOldStories(olderThan: Date): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('stories', 'readwrite');
  const index = tx.store.index('publishedAt');
  const range = IDBKeyRange.upperBound(olderThan.toISOString());
  let cursor = await index.openCursor(range);
  let deleted = 0;
  while (cursor) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

export async function updateStoryCluster(storyId: string, clusterId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('stories', 'readwrite');
  const story = await tx.store.get(storyId);
  if (story) {
    (story as Record<string, unknown>).clusterId = clusterId;
    await tx.store.put(story);
  }
  await tx.done;
}
