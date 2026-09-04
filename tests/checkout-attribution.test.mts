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

  it('non-mission checkouts carry context but no attribution fields', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();

    analytics.trackCheckoutStart(KNOWN_PRODUCT, true);

    const live = calls.find((c) => c.name === 'checkout-start');
    assert.equal(live!.data!.surface, 'dashboard');
    assert.equal('missionId' in live!.data!, false, 'no stored mission -> no missionId');
    assert.equal('panelKey' in live!.data!, false, 'panelKey must be absent on non-mission checkouts');
    // The baseline read segments checkout-starts by variant and device class.
    assert.equal(typeof live!.data!.variant, 'string');
    assert.equal(live!.data!.deviceClass, 'desktop');
    const pending = readPending(sessionStorage);
    assert.equal('missionId' in pending[0]!.data, false);
  });

  it('carries the ambient mission as context when no explicit attribution is given', async () => {
    const analytics = await import('../src/services/analytics.ts');
    const presets = await import('../src/services/mission-presets.ts');
    analytics.resetAnalyticsForTesting();
    const { calls } = installWindow();
    presets.saveMissionPreset('crisis-desk');

    analytics.trackCheckoutStart(KNOWN_PRODUCT, true);

    const live = calls.find((c) => c.name === 'checkout-start');
    assert.equal(live!.data!.missionId, 'crisis-desk', 'ambient mission context lost');
    assert.equal(live!.data!.surface, 'dashboard', 'ambient context must not fake a preview surface');
  });

  it('sanitizes crafted pending entries on replay (storage is attacker-writable)', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const { calls, sessionStorage } = installWindow();
    sessionStorage.setItem(PENDING_KEY, JSON.stringify([
      {
        event: 'checkout-start',
        data: {
          productId: 'pdt_crafted_junk',
          surface: 'evil-surface',
          authed: 'yes',
          missionId: 'crafted-mission',
          panelKey: 'crafted panel!',
          variant: 'crafted-variant',
          injected: 'x'.repeat(500),
        },
      },
      { event: 'checkout-failed', data: { status: 'crafted-status', extra: true } },
    ]));

    analytics.replayPendingConversionEvents();

    const start = calls.find((c) => c.name === 'checkout-start')!;
    assert.equal(start.data!.productId, 'unknown');
    assert.equal(start.data!.surface, 'dashboard');
    assert.equal(start.data!.authed, false);
    assert.equal(start.data!.missionId, 'unknown');
    assert.equal(start.data!.panelKey, 'unknown');
    assert.equal('injected' in start.data!, false, 'unknown keys must be dropped on replay');
    assert.equal('variant' in start.data!, false, 'a variant outside SITE_VARIANTS must be dropped on replay');
    assert.equal(start.data!.replayed, true);
    const failed = calls.find((c) => c.name === 'checkout-failed')!;
    assert.equal(failed.data!.status, 'other');
    assert.equal('extra' in failed.data!, false);
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
    assert.ok(src.includes('analyticsAttribution?: CheckoutAttribution'),
      'PendingCheckoutIntent must keep attribution for the post-sign-in resume');
    assert.ok(src.includes('analyticsAttribution: intent.analyticsAttribution'),
      'resumePendingCheckout must re-thread the stored attribution');
    assert.ok(
      (src.match(/analyticsAttribution: behavior\?\.analyticsAttribution/g) ?? []).length >= 2,
      'both pending-intent writes (signed-out AND token-expiry recovery) must carry analyticsAttribution',
    );
  });
});
