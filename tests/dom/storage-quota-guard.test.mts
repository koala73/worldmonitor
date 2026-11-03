// Runtime proof of the storage-quota backoff split (#8690, replacing the
// source-text checks in save-to-storage-quota-guard.test.mjs): once a quota
// error has been seen, persistent-cache writes stop (they are disposable and
// were the writes that filled storage), while user preference writes through
// saveToStorage keep being attempted, because a preference such as
// worldmonitor-panels that silently never persists is data loss.
//
// The quota flag is module state with no reset, so the cases below run in
// order: the cache writes first, then the flag is tripped, then both paths
// are observed with the flag set.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));
vi.mock('@/services/tauri-bridge', () => ({ invokeTauri: vi.fn() }));

import { isStorageQuotaExceeded } from '@/utils/storage-quota';
import { saveToStorage } from '@/utils';
import { deletePersistentCache, setPersistentCache } from '@/services/persistent-cache';

const CACHE_KEY = 'worldmonitor-persistent-cache:feed';

/**
 * Own the store: happy-dom's localStorage does not route through
 * Storage.prototype, so a prototype spy never sees the writes. A Map-backed
 * stub makes every setItem observable and lets one write fail on demand.
 */
class MemoryStorage {
  readonly store = new Map<string, string>();
  readonly writes: Array<[string, string]> = [];
  failNextWith: Error | null = null;
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failNextWith) { const err = this.failNextWith; this.failNextWith = null; throw err; }
    this.writes.push([key, String(value)]);
    this.store.set(key, String(value));
  }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
  get length(): number { return this.store.size; }
}

const storage = new MemoryStorage();

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

beforeAll(() => {
  vi.stubGlobal('localStorage', storage);
  // happy-dom has no IndexedDB; make that explicit so the cache takes its
  // localStorage fallback path whatever the environment grows later.
  Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
});

beforeEach(() => {
  storage.writes.length = 0;
  storage.failNextWith = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage quota backoff', () => {
  it('writes persistent cache entries to localStorage before any quota error', async () => {
    expect(isStorageQuotaExceeded()).toBe(false);
    await setPersistentCache('feed', { items: [1] }, 123);
    expect(JSON.parse(storage.getItem(CACHE_KEY)!)).toEqual({ key: 'feed', data: { items: [1] }, updatedAt: 123 });
    expect(storage.writes.map(([key]) => key)).toEqual([CACHE_KEY]);
  });

  it('saveToStorage reports a quota error as a failed write and trips the backoff flag', () => {
    storage.failNextWith = quotaError();
    expect(saveToStorage('worldmonitor-panels', { news: { enabled: true } })).toBe(false);
    expect(storage.writes).toEqual([]);
    expect(isStorageQuotaExceeded()).toBe(true);
  });

  it('stops persistent cache writes and removals once the quota is exceeded', async () => {
    expect(isStorageQuotaExceeded()).toBe(true);
    await setPersistentCache('feed-2', { items: [2] }, 456);
    expect(storage.writes).toEqual([]);
    expect(storage.getItem('worldmonitor-persistent-cache:feed-2')).toBeNull();
    await deletePersistentCache('feed');
    expect(storage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('keeps attempting user preference writes after the quota is exceeded', () => {
    expect(isStorageQuotaExceeded()).toBe(true);
    expect(saveToStorage('worldmonitor-panels', { news: { enabled: false } })).toBe(true);
    expect(storage.writes).toEqual([['worldmonitor-panels', JSON.stringify({ news: { enabled: false } })]]);
    expect(storage.getItem('worldmonitor-panels')).toBe(JSON.stringify({ news: { enabled: false } }));
  });

  it('still reports a non-quota write failure as a failed write', () => {
    storage.failNextWith = new Error('SecurityError');
    expect(saveToStorage('worldmonitor-theme', 'dark')).toBe(false);
    expect(storage.writes).toEqual([]);
  });
});
