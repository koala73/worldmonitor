import { getDb } from '@/services/db';
import type { CachedNarration } from '@/types/news-reader';

interface StoredNarration extends Omit<CachedNarration, 'generatedAt' | 'expiresAt'> {
  generatedAt: string;
  expiresAt: string;
}

function toStored(n: CachedNarration): StoredNarration {
  return { ...n, generatedAt: n.generatedAt.toISOString(), expiresAt: n.expiresAt.toISOString() };
}

function fromStored(s: StoredNarration): CachedNarration {
  return { ...s, generatedAt: new Date(s.generatedAt), expiresAt: new Date(s.expiresAt) };
}

const BRIEF_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const ANCHOR_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours

export function getBriefExpiry(): Date {
  return new Date(Date.now() + BRIEF_TTL_MS);
}

export function getAnchorExpiry(): Date {
  return new Date(Date.now() + ANCHOR_TTL_MS);
}

export async function getCachedNarration(clusterId: string): Promise<CachedNarration | null> {
  const db = await getDb();
  const stored = await db.get('narrations', clusterId);
  if (!stored) return null;
  const narration = fromStored(stored as unknown as StoredNarration);
  // Check expiry
  if (narration.expiresAt < new Date()) {
    await db.delete('narrations', clusterId);
    return null;
  }
  return narration;
}

export async function putNarration(narration: CachedNarration): Promise<void> {
  const db = await getDb();
  await db.put('narrations', toStored(narration));
}

export async function cleanupExpiredNarrations(): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('narrations', 'readwrite');
  const index = tx.store.index('expiresAt');
  const range = IDBKeyRange.upperBound(new Date().toISOString());
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
