/**
 * Pro strip click tracking.
 *
 * The free-user Pro strip's views were counted (gate-hit feature=pro-banner)
 * but its clicks were not. A click usually navigates straight to /pro, often
 * before the deferred Umami tracker has loaded, so the click is stored in the
 * durable pending-conversion entry (sessionStorage) and replayed on the next
 * dashboard boot, the same way dashboard checkout-start survives the Dodo
 * redirect.
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

describe('Pro strip click tracking', () => {
  afterEach(cleanupWindow);

  it('emits pro-banner-click with the strip state and keeps a durable copy', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackProBannerClick('upgrade');

    const live = calls.find((c) => c.name === 'pro-banner-click');
    assert.ok(live, 'pro-banner-click not emitted');
    assert.equal(live.data!.state, 'upgrade');
    const pending = readPending(sessionStorage);
    assert.deepEqual(pending.map((p) => [p.event, p.data.state]), [['pro-banner-click', 'upgrade']]);
  });

  it('replays a click that navigated away before the tracker loaded', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const first = installWindow(false);
    analytics.trackProBannerClick('lapsed');
    const stored = first.sessionStorage.getItem(PENDING_KEY);
    assert.ok(stored, 'the click must be stored before the navigation');
    cleanupWindow();

    analytics.resetAnalyticsForTesting();
    const second = installWindow();
    second.sessionStorage.setItem(PENDING_KEY, stored);
    analytics.replayPendingConversionEvents();

    const replayed = second.calls.find((c) => c.name === 'pro-banner-click');
    assert.ok(replayed, 'replay did not emit pro-banner-click');
    assert.equal(replayed.data!.state, 'lapsed');
    assert.equal(replayed.data!.replayed, true);
  });

  it('sanitizes a crafted stored click on replay', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();
    sessionStorage.setItem(PENDING_KEY, JSON.stringify([
      { event: 'pro-banner-click', data: { state: 'crafted', injected: 'x'.repeat(200) } },
    ]));

    analytics.replayPendingConversionEvents();

    const replayed = calls.find((c) => c.name === 'pro-banner-click')!;
    assert.deepEqual(replayed.data, { state: 'upgrade', replayed: true });
  });
});
