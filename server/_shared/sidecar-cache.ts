/**
 * In-memory TTL + LRU cache for the Tauri sidecar.
 * Activated only when LOCAL_API_MODE === 'tauri-sidecar'.
 * No top-level side effects; sweep timer starts lazily on first write.
 */

const MAX_ENTRIES = 500;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_SINGLE_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB
const MIN_TTL_S = 10;
const MAX_TTL_S = 86_400;
const SWEEP_INTERVAL_MS = 60_000;

interface CacheEntry {
  value: string; // JSON-stringified
  expiresAt: number;
  size: number;
}

const store = new Map<string, CacheEntry>();
let totalBytes = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

let hitCount = 0;
let missCount = 0;

function startSweepIfNeeded(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.expiresAt <= now) {
        totalBytes -= entry.size;
        store.delete(k);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }
}

function evictLRU(): void {
  // Collect keys to evict first, then delete (avoids mutating Map during iteration)
  const keysToEvict: string[] = [];
  for (const [k, entry] of store) {
    if (store.size - keysToEvict.length < MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    keysToEvict.push(k);
    totalBytes -= entry.size;
  }
  for (const k of keysToEvict) store.delete(k);
}

export function sidecarCacheGet(key: string): unknown | null {
  const entry = store.get(key);
  if (!entry) {
    missCount++;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    totalBytes -= entry.size;
    store.delete(key);
    missCount++;
    return null;
  }
  // Move to end for LRU (re-insert)
  store.delete(key);
  store.set(key, entry);
  hitCount++;
  return JSON.parse(entry.value);
}

export function sidecarCacheSet(key: string, value: unknown, ttlSeconds: number): void {
  const clamped = Math.max(MIN_TTL_S, Math.min(MAX_TTL_S, ttlSeconds));
  const json = JSON.stringify(value);
  // Rough byte estimate: JS strings are UTF-16 (2 bytes per code unit).
  // Overestimates for ASCII-heavy JSON; effective limits are ~half the stated max.
  const size = json.length * 2;

  if (size > MAX_SINGLE_VALUE_BYTES) {
    console.warn(`[sidecar-cache] rejecting key "${key}": ${(size / 1024 / 1024).toFixed(1)} MB exceeds 2 MB limit`);
    return;
  }

  // Remove old entry if exists
  const existing = store.get(key);
  if (existing) {
    totalBytes -= existing.size;
    store.delete(key);
  }

  // Evict if needed
  if (store.size >= MAX_ENTRIES || totalBytes + size > MAX_BYTES) {
    evictLRU();
  }

  store.set(key, {
    value: json,
    expiresAt: Date.now() + clamped * 1000,
    size,
  });
  totalBytes += size;

  startSweepIfNeeded();
}

export function sidecarCacheStats(): { entries: number; bytes: number; hits: number; misses: number } {
  return { entries: store.size, bytes: totalBytes, hits: hitCount, misses: missCount };
}

