/**
 * Country history upsell clicks (#11410, review on #11414). The link goes to
 * /pro in the same tab, often before the deferred Umami tracker has loaded, so
 * the click is kept in the durable pending-conversion entry and replayed on the
 * next dashboard boot, like pro-banner-click. It has its own event name because
 * pending entries are forgotten by event name: sharing country-history-action
 * would let a delivered date-select drop a stored upsell click.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const PENDING_KEY = 'wm-conversion-pending';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

type TrackedCall = { name: string; data?: Record<string, unknown> };

function installWindow(withTracker = true): { calls: TrackedCall[]; sessionStorage: MemoryStorage } {
  const calls: TrackedCall[] = [];
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const fakeWindow: Record<string, unknown> = { sessionStorage, localStorage, innerWidth: 1280 };
  if (withTracker) {
    fakeWindow.umami = {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    };
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  return { calls, sessionStorage };
}

function cleanupWindow(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

function readPending(storage: MemoryStorage): Array<{ event: string; data: Record<string, unknown> }> {
  const raw = storage.getItem(PENDING_KEY);
  return raw ? JSON.parse(raw) : [];
}

describe('country history upsell click', () => {
  afterEach(cleanupWindow);

  it('emits once per page load and keeps a durable copy', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackCountryHistoryUpsellClick(7);
    analytics.trackCountryHistoryUpsellClick(7);

    assert.deepEqual(
      calls.filter((c) => c.name === 'country-history-upsell-click').map((c) => c.data),
      [{ allowedDays: 7 }],
    );
    assert.deepEqual(readPending(sessionStorage), [{ event: 'country-history-upsell-click', data: { allowedDays: 7 } }]);
  });

  it('replays a click that navigated away before the tracker loaded', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const first = installWindow(false);
    analytics.trackCountryHistoryUpsellClick(90);
    const stored = first.sessionStorage.getItem(PENDING_KEY);
    assert.ok(stored, 'the click must be stored before the navigation');
    cleanupWindow();

    analytics.resetAnalyticsForTesting();
    const second = installWindow();
    second.sessionStorage.setItem(PENDING_KEY, stored);
    analytics.replayPendingConversionEvents();

    assert.deepEqual(
      second.calls.filter((c) => c.name === 'country-history-upsell-click').map((c) => c.data),
      [{ allowedDays: 90, replayed: true }],
    );
  });

  it('sanitizes a crafted stored click on replay', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();
    sessionStorage.setItem(PENDING_KEY, JSON.stringify([
      { event: 'country-history-upsell-click', data: { allowedDays: 'x'.repeat(50), country: 'US' } },
    ]));

    analytics.replayPendingConversionEvents();

    assert.deepEqual(
      calls.find((c) => c.name === 'country-history-upsell-click')?.data,
      { allowedDays: 7, replayed: true },
    );
  });
});
