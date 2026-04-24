/**
 * State-machine tests for createEntitlementWatchdog.
 *
 * This module is the fallback that unblocks the Dodo wallet-return
 * deadlock: when Dodo's overlay completes a payment but never emits
 * checkout.status / checkout.redirect_requested, the watchdog polls
 * /api/me/entitlement until the webhook flips isPro, then fires onPro.
 * See PR #3357 / skill dodo-wallet-return-skips-postmessage.
 *
 * Scenarios covered:
 *   - Wallet-return path: N isPro:false polls then isPro:true -> onPro
 *     fires exactly once.
 *   - Timeout cap: isPro never flips -> poller self-terminates without
 *     firing onPro (we'd rather strand than falsely promote).
 *   - Missing token: tick is a no-op; poller keeps trying.
 *   - Non-200 responses (401 / 404 / 5xx): tick swallows, poller keeps
 *     trying.
 *   - Fetch rejects (offline / abort): tick swallows, poller keeps
 *     trying.
 *   - Idempotence: once onPro has fired, later ticks do not re-fire.
 *   - stop(): clears the interval immediately, onPro never called.
 *   - Double-start: second start() while active is a no-op.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEntitlementWatchdog,
  type EntitlementWatchdogDeps,
} from '@/services/entitlement-watchdog';

interface Harness {
  deps: EntitlementWatchdogDeps;
  /** Drive N ticks synchronously, resolving between each. */
  tickTimes: (n: number) => Promise<void>;
  /** Advance the fake clock by ms without firing ticks. */
  advanceTime: (ms: number) => void;
  fetchCalls: number;
  tokenCalls: number;
  onProCalls: number;
  /** Active interval callback, or null if stopped. */
  getActiveCb: () => (() => void) | null;
}

/**
 * Build a harness whose fetch response is driven by `respond`, called
 * for each tick. Returning null from `respond` means "reject" (simulates
 * network error / AbortError). Returning a Response-shaped object drives
 * the ok / json branches.
 */
function buildHarness(
  respond: (tickIndex: number) => { ok: boolean; body?: unknown } | null,
  tokenProvider: (tickIndex: number) => string | null = () => 'tok_test',
): Harness {
  let activeId: number | null = null;
  let activeCb: (() => void) | null = null;
  let nextId = 1;
  let fakeNow = 1_000;
  let tickIndex = 0;
  const harness: Harness = {
    deps: {} as EntitlementWatchdogDeps,
    tickTimes: async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        if (!activeCb) return;
        activeCb();
        // Drain microtasks + the tick's async chain (await getToken,
        // await fetch, await resp.json). 3 macro yields is enough at
        // this depth; node:test runs synchronously otherwise.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    advanceTime: (ms: number): void => { fakeNow += ms; },
    fetchCalls: 0,
    tokenCalls: 0,
    onProCalls: 0,
    getActiveCb: () => activeCb,
  };
  harness.deps = {
    getToken: async () => {
      const t = tokenProvider(harness.tokenCalls);
      harness.tokenCalls++;
      return t;
    },
    fetch: async (_input: unknown, _init?: unknown) => {
      const idx = harness.fetchCalls;
      harness.fetchCalls++;
      const r = respond(idx);
      if (r === null) {
        throw new Error('simulated fetch error');
      }
      return {
        ok: r.ok,
        status: r.ok ? 200 : 500,
        json: async () => r.body ?? {},
      } as unknown as Response;
    },
    setInterval: ((cb: () => void, _ms: number) => {
      activeCb = cb;
      activeId = nextId++;
      return activeId;
    }) as typeof setInterval,
    clearInterval: ((id: number) => {
      if (id === activeId) {
        activeCb = null;
        activeId = null;
      }
    }) as typeof clearInterval,
    now: () => fakeNow,
    onPro: () => {
      harness.onProCalls++;
    },
  };
  // Also register tickIndex for future extension
  void tickIndex;
  return harness;
}

describe('createEntitlementWatchdog', () => {
  it('wallet-return path: fires onPro exactly once after isPro flips to true', async () => {
    const h = buildHarness((i) => ({ ok: true, body: { isPro: i >= 3 } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    // Three non-pro ticks, then pro tick -> onPro.
    await h.tickTimes(5);
    assert.equal(h.onProCalls, 1, 'onPro should fire exactly once');
    assert.equal(wd.isActive(), false, 'watchdog should stop after success');
    assert.equal(h.getActiveCb(), null, 'interval should be cleared');
  });

  it('timeout cap: never fires onPro if isPro stays false past timeoutMs', async () => {
    const h = buildHarness(() => ({ ok: true, body: { isPro: false } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 10_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(2);
    assert.equal(h.onProCalls, 0);
    assert.equal(wd.isActive(), true);
    // Push the clock past the timeoutMs cap and tick once more.
    h.advanceTime(11_000);
    await h.tickTimes(1);
    assert.equal(h.onProCalls, 0, 'onPro must NOT fire on timeout');
    assert.equal(wd.isActive(), false, 'watchdog self-terminates on timeout');
  });

  it('missing token: tick is a no-op, poller keeps running', async () => {
    const h = buildHarness(
      () => ({ ok: true, body: { isPro: true } }),
      (i) => (i < 2 ? null : 'tok_test'),
    );
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(3);
    assert.equal(h.fetchCalls, 1, 'fetch only runs when token is present');
    assert.equal(h.onProCalls, 1, 'onPro fires on the tick that got a token');
  });

  it('non-2xx response: tick swallows, poller continues', async () => {
    // First two ticks return 401, third returns isPro:true.
    const h = buildHarness((i) => (i < 2 ? { ok: false } : { ok: true, body: { isPro: true } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(3);
    assert.equal(h.onProCalls, 1);
    assert.equal(wd.isActive(), false);
  });

  it('fetch rejection: tick swallows, poller continues', async () => {
    // First tick rejects, second succeeds with isPro:true.
    const h = buildHarness((i) => (i === 0 ? null : { ok: true, body: { isPro: true } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(2);
    assert.equal(h.onProCalls, 1, 'poller survives a rejection and fires on next success');
  });

  it('idempotence: onPro does not fire twice if isPro stays true across ticks', async () => {
    const h = buildHarness(() => ({ ok: true, body: { isPro: true } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(5);
    assert.equal(h.onProCalls, 1, 'onPro only fires once even if stop races with later ticks');
  });

  it('stop(): clears interval immediately; onPro never fires', async () => {
    const h = buildHarness(() => ({ ok: true, body: { isPro: true } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    wd.stop();
    await h.tickTimes(3);
    assert.equal(h.onProCalls, 0);
    assert.equal(wd.isActive(), false);
    assert.equal(h.fetchCalls, 0, 'no fetches should happen after stop()');
  });

  it('double-start is a no-op while active', async () => {
    const h = buildHarness(() => ({ ok: true, body: { isPro: false } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    const cbBefore = h.getActiveCb();
    wd.start();
    const cbAfter = h.getActiveCb();
    assert.strictEqual(cbBefore, cbAfter, 'second start must not register a new interval');
  });

  it('start after onPro fired is a no-op (post-success reuse guard)', async () => {
    const h = buildHarness(() => ({ ok: true, body: { isPro: true } }));
    const wd = createEntitlementWatchdog(
      { endpoint: '/api/me/entitlement', intervalMs: 3_000, timeoutMs: 600_000 },
      h.deps,
    );
    wd.start();
    await h.tickTimes(1);
    assert.equal(h.onProCalls, 1);
    // Pretend caller mistakenly re-starts the same instance.
    wd.start();
    await h.tickTimes(2);
    assert.equal(h.onProCalls, 1, 'onPro must not re-fire after a prior success on the same instance');
  });
});
