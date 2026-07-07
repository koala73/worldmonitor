/**
 * Durable checkout-success delivery (#4934 round-2 F2).
 *
 * The entitlement watcher reloads the dashboard the moment Pro lands —
 * often before the deferred Umami queue flushes, which would silently drop
 * the terminal funnel event. Contract under test:
 *
 *   1. delivered normally → the sessionStorage marker is cleared, so a
 *      later boot replays nothing (no double-count);
 *   2. reload before delivery → the marker survives, and
 *      replayPendingCheckoutSuccess() re-emits the event (replayed:true);
 *   3. replay after successful delivery is a no-op.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const PENDING_KEY = 'wm-checkout-success-pending';

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

function installWindow(
  storage: MemoryStorage,
  opts: { withUmami: boolean },
): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const fakeWindow: Record<string, unknown> = { sessionStorage: storage };
  if (opts.withUmami) {
    fakeWindow.umami = {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    };
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  return calls;
}

describe('checkout-start product bucketing (#4934 round-4 F2)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('collapses unknown product ids to "unknown" and passes known ids through', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow(new MemoryStorage(), { withUmami: true });

    analytics.trackCheckoutStart('pdt_evil_injected_via_url', true, 'dashboard-resume');
    analytics.trackCheckoutStart('pdt_0Nbtt71uObulf7fGXhQup', true);

    assert.equal(calls[0]!.data!.productId, 'unknown', 'crafted id must not reach analytics verbatim');
    assert.equal(calls[1]!.data!.productId, 'pdt_0Nbtt71uObulf7fGXhQup', 'catalog id must pass through');
  });
});

describe('/pro funnel replay across the Dodo redirect (#4934 rounds 5+6)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('replays sanitized events and clears the marker ON DELIVERY (tracker present)', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    storage.setItem('wm-pro-funnel-pending', JSON.stringify([
      { event: 'checkout-start', data: { productId: 'pdt_0Nbtt71uObulf7fGXhQup', surface: 'pro-resume', authed: true } },
      { event: 'checkout-start', data: { productId: 'pdt_crafted_junk', surface: 'nonsense', authed: 'yes' } },
      { event: 'totally-made-up-event', data: { productId: 'x' } },
      'garbage-entry',
    ]));
    const calls = installWindow(storage, { withUmami: true });

    analytics.replayPendingProFunnelEvents();

    assert.deepEqual(calls, [
      {
        name: 'checkout-start',
        data: { productId: 'pdt_0Nbtt71uObulf7fGXhQup', surface: 'pro-resume', authed: true, replayed: true },
      },
      {
        name: 'checkout-start',
        data: { productId: 'unknown', surface: 'pro-page', authed: true, replayed: true },
      },
    ], 'unknown events dropped; crafted fields collapsed to closed vocabularies');
    assert.equal(storage.getItem('wm-pro-funnel-pending'), null,
      'marker must clear once a replayed event actually delivers');
  });

  it('survives a pre-delivery reload: marker persists (sanitized) until delivery (round-6)', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    storage.setItem('wm-pro-funnel-pending', JSON.stringify([
      { event: 'checkout-start', data: { productId: 'pdt_crafted_junk', surface: 'pro-resume', authed: true } },
      { event: 'not-a-real-event', data: {} },
    ]));
    // Tracker NOT loaded yet — replay can only queue in memory.
    installWindow(storage, { withUmami: false });
    analytics.replayPendingProFunnelEvents();

    const persisted = JSON.parse(storage.getItem('wm-pro-funnel-pending') ?? 'null');
    assert.deepEqual(persisted, [
      { event: 'checkout-start', data: { productId: 'unknown', surface: 'pro-resume', authed: true } },
    ], 'marker must survive pre-delivery, rewritten to the sanitized survivors only');

    // Entitlement-watcher reload: in-memory queue dies, storage survives.
    analytics.resetAnalyticsForTesting();
    const calls = installWindow(storage, { withUmami: true });
    analytics.replayPendingProFunnelEvents();

    assert.deepEqual(calls, [
      { name: 'checkout-start', data: { productId: 'unknown', surface: 'pro-resume', authed: true, replayed: true } },
    ], 'the reload must retry the replay, not drop it');
    assert.equal(storage.getItem('wm-pro-funnel-pending'), null, 'marker clears after the retry delivers');
  });

  it('is a no-op on ordinary boots and clears malformed/unreplayable storage', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const empty = new MemoryStorage();
    const noCalls = installWindow(empty, { withUmami: true });
    analytics.replayPendingProFunnelEvents();
    assert.deepEqual(noCalls, []);

    analytics.resetAnalyticsForTesting();
    const malformed = new MemoryStorage();
    malformed.setItem('wm-pro-funnel-pending', '{not json');
    const stillNoCalls = installWindow(malformed, { withUmami: true });
    analytics.replayPendingProFunnelEvents();
    assert.deepEqual(stillNoCalls, []);
    assert.equal(malformed.getItem('wm-pro-funnel-pending'), null,
      'unreplayable payload must be cleared so it cannot loop');
  });
});

describe('durable checkout-success', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('clears the marker on actual delivery, so nothing replays later', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    const calls = installWindow(storage, { withUmami: true });

    analytics.trackCheckoutSuccess('url-return');
    assert.deepEqual(calls, [{ name: 'checkout-success', data: { source: 'url-return' } }]);
    assert.equal(storage.getItem(PENDING_KEY), null, 'marker must clear on delivery');

    // Simulated later boot: replay must be a no-op.
    analytics.resetAnalyticsForTesting();
    const laterCalls = installWindow(storage, { withUmami: true });
    analytics.replayPendingCheckoutSuccess();
    assert.deepEqual(laterCalls, [], 'delivered event must not be double-counted');
  });

  it('replays the event on the next boot when a reload beat the queue flush', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const storage = new MemoryStorage();
    // No umami yet — the tracker had not loaded when the reload happened.
    installWindow(storage, { withUmami: false });

    analytics.trackCheckoutSuccess('url-return');
    assert.equal(storage.getItem(PENDING_KEY), 'url-return', 'marker must persist until delivery');

    // Reload: in-memory queue is gone, sessionStorage survives in the tab.
    analytics.resetAnalyticsForTesting();
    const calls = installWindow(storage, { withUmami: true });
    analytics.replayPendingCheckoutSuccess();

    assert.deepEqual(calls, [
      { name: 'checkout-success', data: { source: 'url-return', replayed: true } },
    ]);
    assert.equal(storage.getItem(PENDING_KEY), null, 'marker must clear once the replay delivers');
  });
});
