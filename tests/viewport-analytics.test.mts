import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as analytics from '../src/services/analytics.ts';

afterEach(() => {
  analytics.resetAnalyticsForTesting();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

test('checkout and variant events sample the current window at every boundary', () => {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const storage = new Map<string, string>();
  const win = {
    innerWidth: 390,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    umami: { track: (name: string, data: Record<string, unknown>) => calls.push({ name, data }), identify() {} },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  for (const [width, band] of [[767, 'phone'], [768, 'stacked'], [899, 'stacked'], [900, 'narrow-split'], [1299, 'narrow-split'], [1300, 'wide']] as const) {
    win.innerWidth = width;
    analytics.trackCheckoutStart('unknown', false);
    analytics.trackCheckoutSuccess('url-return');
    analytics.trackVariantSwitch('full', 'tech');
    assert.deepEqual(calls.slice(-3).map(c => c.data.vw), [band, band, band]);
  }
});

test('first interaction is silent until touched and deduplicates across reloads', () => {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerWidth: 834,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    umami: { track: (name: string, data: Record<string, unknown>) => calls.push({ name, data }), identify() {} },
  } });
  assert.equal(calls.length, 0);
  analytics.replayPendingDashboardFirstInteraction();
  assert.equal(calls.length, 0, 'idle boot cannot invent a first touch');
  analytics.trackDashboardFirstInteraction('map');
  analytics.trackDashboardFirstInteraction('panel');
  analytics.resetAnalyticsForTesting();
  analytics.trackDashboardFirstInteraction('search');
  assert.deepEqual(calls, [{ name: 'dashboard-first-interaction', data: { vw: 'stacked', target: 'map' } }]);
});

test('queued events retain the width sampled before a resize', () => {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const win: Record<string, unknown> = { innerWidth: 767 };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  analytics.track('checkout-start', { surface: 'dashboard' });
  analytics.trackDashboardFirstInteraction('map');
  win.innerWidth = 1440;
  win.umami = { track: (name: string, data: Record<string, unknown>) => calls.push({ name, data }), identify() {} };
  win.requestAnimationFrame = (cb: () => void) => { cb(); return 1; };
  win.requestIdleCallback = (cb: () => void) => { cb(); return 1; };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    readyState: 'complete', querySelector: () => ({}),
  } });
  analytics.initAnalytics();
  assert.deepEqual(calls.map(c => c.data.vw), ['phone', 'phone']);
  analytics.trackDashboardFirstInteraction('panel');
  assert.equal(calls.length, 2, 'storage unavailable still deduplicates in this document');
});

test('durable dashboard and /pro checkout replay retain the originating width', () => {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const storage = new Map<string, string>();
  const win = {
    innerWidth: 390,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    umami: undefined as undefined | { track: (name: string, data: Record<string, unknown>) => void; identify: () => void },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  analytics.trackCheckoutStart('unknown', false);
  analytics.trackCheckoutSuccess('url-return');
  analytics.resetAnalyticsForTesting();
  win.innerWidth = 1440;
  win.umami = { track: (name, data) => calls.push({ name, data }), identify() {} };
  analytics.replayPendingConversionEvents();
  analytics.replayPendingCheckoutSuccess();
  storage.set('wm-pro-funnel-pending', JSON.stringify([
    { event: 'checkout-start', data: { productId: 'unknown', surface: 'pro-page', authed: true, vw: 'stacked' } },
    { event: 'checkout-start', data: { productId: 'unknown', surface: 'pro-resume', authed: true, vw: 'crafted' } },
  ]));
  analytics.replayPendingProFunnelEvents();
  assert.deepEqual(calls.map(c => [c.name, c.data.vw]), [
    ['checkout-start', 'phone'], ['checkout-success', 'phone'],
    ['checkout-start', 'stacked'], ['checkout-start', 'wide'],
  ]);
});

test('a first touch queued before navigation replays once with its original payload', () => {
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const storage = new Map<string, string>();
  const win: Record<string, unknown> = {
    innerWidth: 390,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  analytics.trackDashboardFirstInteraction('switcher');
  analytics.resetAnalyticsForTesting();
  win.innerWidth = 1440;
  win.umami = { track: (name: string, data: Record<string, unknown>) => calls.push({ name, data }), identify() {} };
  analytics.replayPendingDashboardFirstInteraction();
  analytics.trackDashboardFirstInteraction('map');
  analytics.resetAnalyticsForTesting();
  analytics.replayPendingDashboardFirstInteraction();
  assert.deepEqual(calls, [{ name: 'dashboard-first-interaction', data: { vw: 'phone', target: 'switcher' } }]);
});
