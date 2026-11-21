// The breaking-alerts switch is an opt-out from a notification that fans out
// to the banner, push, Telegram, Slack and email. Absence is intent, not a
// default, so a write that did not land must not be reported as one.
//
// `updateAlertSettings` used to set the in-memory cache BEFORE the write and
// swallow the throw. `IntelligenceGapBadge` re-renders the switch from
// `getAlertSettings()`, i.e. from that cache, so the user saw the toggle move
// while nothing was persisted; the next page load read the old
// `enabled: true` and alerting resumed. `wm-breaking-alerts-v1` is also a
// CLOUD_SYNC_KEY, so the opt-out never reached the user's other devices.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SETTINGS_KEY = 'wm-breaking-alerts-v1';

/**
 * Own the store: happy-dom's localStorage does not route through
 * Storage.prototype, so a prototype spy never sees the writes.
 */
class MemoryStorage {
  readonly store = new Map<string, string>();
  failReadWith: Error | null = null;
  failWriteWith: Error | null = null;
  getItem(key: string): string | null {
    if (this.failReadWith) throw this.failReadWith;
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWriteWith) throw this.failWriteWith;
    this.store.set(key, String(value));
  }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
  get length(): number { return this.store.size; }
}

const storage = new MemoryStorage();

beforeAll(() => { vi.stubGlobal('localStorage', storage); });

beforeEach(() => {
  storage.store.clear();
  storage.failReadWith = null;
  storage.failWriteWith = null;
  vi.resetModules();
});

afterEach(() => { vi.restoreAllMocks(); });

const stored = () => {
  const raw = storage.store.get(SETTINGS_KEY);
  return raw === undefined ? null : JSON.parse(raw) as { enabled?: boolean };
};

describe('turning breaking alerts off reports whether it was actually saved', () => {
  it('a rejected write leaves neither storage nor the cache claiming the opt-out', async () => {
    const mod = await import('@/services/breaking-news-alerts');
    expect(mod.updateAlertSettings({ enabled: true })).toBe(true);
    expect(stored()!.enabled).toBe(true);

    storage.failWriteWith = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    expect(mod.updateAlertSettings({ enabled: false })).toBe(false);
    storage.failWriteWith = null;

    // What a re-render reads, and what the next page load would read.
    expect(mod.getAlertSettings().enabled).toBe(true);
    expect(stored()!.enabled).toBe(true);
  });

  it('a write that lands is reported and persisted', async () => {
    const mod = await import('@/services/breaking-news-alerts');
    expect(mod.updateAlertSettings({ enabled: false })).toBe(true);
    expect(mod.getAlertSettings().enabled).toBe(false);
    expect(stored()!.enabled).toBe(false);
  });

  it('a failed read does not pin the defaults for the rest of the page view', async () => {
    storage.store.set(SETTINGS_KEY, JSON.stringify({ enabled: false }));
    const mod = await import('@/services/breaking-news-alerts');

    storage.failReadWith = new DOMException('storage is not readable', 'SecurityError');
    expect(mod.getAlertSettings().enabled).toBe(true); // the default, as before
    storage.failReadWith = null;

    // Storage recovered, so the stored opt-out applies instead of a cached default.
    expect(mod.getAlertSettings().enabled).toBe(false);
  });

  it('positive control: a store that cannot be reached at all still yields the defaults', async () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      const mod = await import('@/services/breaking-news-alerts');
      expect(mod.getAlertSettings().enabled).toBe(true);
    } finally {
      vi.stubGlobal('localStorage', storage);
    }
  });
});
