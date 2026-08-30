/**
 * Checkout attribution end to end (plan 2026-08-30-001, U2).
 *
 * Contract under test:
 *  1. A checkout started from a mission preview records surface + missionId +
 *     panelKey both on the live `checkout-start` event and in the durable
 *     pending-conversion entry (sessionStorage), so the attribution survives
 *     the Dodo/sign-in redirect.
 *  2. `replayPendingConversionEvents` re-emits the stored event with the same
 *     attribution plus `replayed: true`.
 *  3. Existing non-mission checkouts are unchanged: `surface: 'dashboard'`,
 *     no mission fields.
 *  4. Attribution ids are bucketed — a crafted mission id collapses to
 *     'unknown' before it can reach Umami (same rule as productId).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const PENDING_KEY = 'wm-conversion-pending';
const KNOWN_PRODUCT = 'pdt_0Nbtt71uObulf7fGXhQup';

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

function installWindow(): { calls: TrackedCall[]; sessionStorage: MemoryStorage } {
  const calls: TrackedCall[] = [];
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const fakeWindow: Record<string, unknown> = {
    sessionStorage,
    localStorage,
    innerWidth: 1280,
    umami: {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    },
  };
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

describe('mission-attributed checkout-start (U2)', () => {
  afterEach(cleanupWindow);

  it('records surface, missionId, panelKey on the event and the pending entry', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackCheckoutStart(KNOWN_PRODUCT, true, 'mission-preview', {
      missionId: 'osint-newsroom',
      panelKey: 'gdelt-intel',
    });

    const live = calls.find((c) => c.name === 'checkout-start');
    assert.ok(live, 'checkout-start not emitted');
    assert.equal(live.data!.surface, 'mission-preview');
    assert.equal(live.data!.missionId, 'osint-newsroom');
    assert.equal(live.data!.panelKey, 'gdelt-intel');

    const pending = readPending(sessionStorage);
    assert.equal(pending.length, 1, 'pending-conversion entry missing');
    assert.equal(pending[0]!.data.missionId, 'osint-newsroom');
    assert.equal(pending[0]!.data.panelKey, 'gdelt-intel');
    assert.equal(pending[0]!.data.surface, 'mission-preview');
  });

  it('replays the stored attribution after a simulated redirect', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const first = installWindow();
    analytics.trackCheckoutStart(KNOWN_PRODUCT, false, 'mission-preview', {
      missionId: 'macro-market-watch',
      panelKey: 'macro-signals',
    });
    const stored = first.sessionStorage.getItem(PENDING_KEY)!;
    cleanupWindow();

    // Simulated post-redirect boot: fresh window, the durable entry carried over.
    const second = installWindow();
    second.sessionStorage.setItem(PENDING_KEY, stored);
    analytics.replayPendingConversionEvents();

    const replayed = second.calls.find((c) => c.name === 'checkout-start');
    assert.ok(replayed, 'replay did not emit checkout-start');
    assert.equal(replayed.data!.replayed, true);
    assert.equal(replayed.data!.missionId, 'macro-market-watch');
    assert.equal(replayed.data!.panelKey, 'macro-signals');
    assert.equal(replayed.data!.surface, 'mission-preview');
  });

  it('leaves non-mission checkouts unchanged (no attribution fields)', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackCheckoutStart(KNOWN_PRODUCT, true);

    const live = calls.find((c) => c.name === 'checkout-start');
    assert.equal(live!.data!.surface, 'dashboard');
    assert.equal('missionId' in live!.data!, false, 'missionId must be absent on non-mission checkouts');
    assert.equal('panelKey' in live!.data!, false, 'panelKey must be absent on non-mission checkouts');
    const pending = readPending(sessionStorage);
    assert.equal('missionId' in pending[0]!.data, false);
  });

  it('buckets crafted attribution ids to "unknown" before storage', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackCheckoutStart(KNOWN_PRODUCT, true, 'mission-preview', {
      missionId: 'crafted<script>',
      panelKey: 'not a panel!',
    });

    const live = calls.find((c) => c.name === 'checkout-start');
    assert.equal(live!.data!.missionId, 'unknown');
    assert.equal(live!.data!.panelKey, 'unknown');
    assert.equal(readPending(sessionStorage)[0]!.data.missionId, 'unknown');
  });
});

describe('checkout service threading', () => {
  it('startCheckout passes the attribution through to trackCheckoutStart', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/services/checkout.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('analyticsAttribution?: CheckoutAttribution'),
      'checkout behavior must accept analyticsAttribution');
    assert.ok(src.includes('behavior?.analyticsAttribution'),
      'startCheckout must thread analyticsAttribution into trackCheckoutStart');
  });
});
