/**
 * The Convex watch path's listener fan-out (#5632 review follow-up).
 *
 * `tests/entitlement-listener-fanout.test.mts` proves the isolation itself, but
 * it can only reach `resetEntitlementState()` — the one emission site that
 * works without a Convex client. That leaves the site that actually matters
 * uncovered: reverting the watch callback to a raw `for (const cb of listeners)
 * cb(result)` loop keeps that suite green, so the guard's own regression would
 * be invisible. This file drives the real `initEntitlementSubscription` with
 * the Convex client stubbed, captures the update callback the module hands to
 * `onUpdate`, and invokes it — the same path a live snapshot takes.
 *
 * Lives under `tests/dom/` because that is the repo's only vitest project
 * covering `tests/`, and `vi.mock` is what makes the convex-client seam
 * stubbable; it needs no DOM of its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Snapshot = { planKey: string; features: { tier: number }; validUntil: number } | null;
type UpdateCallback = (result: Snapshot) => void;

/** The callback `initEntitlementSubscription` registers with `client.onUpdate`. */
let captured: UpdateCallback | null = null;
let unsubscribed = 0;
let watchCurrent = true;
let watchUserId = 'user_1';

vi.mock('@/services/convex-client', () => ({
  getConvexClient: async () => ({
    onUpdate: (_query: unknown, _args: unknown, cb: UpdateCallback) => {
      captured = cb;
      return { unsubscribe: () => unsubscribed++ };
    },
  }),
  getConvexApi: async () => ({ entitlements: { getEntitlementsForUser: 'q' } }),
  waitForConvexAuth: async () => true,
  waitForConvexAuthForUser: async () => true,
}));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: watchUserId }),
}));

const {
  initEntitlementSubscription,
  destroyEntitlementSubscription,
  onEntitlementChange,
  getEntitlementState,
  resetEntitlementState,
} = await import('@/services/entitlements');

const PRO: Snapshot = { planKey: 'pro', features: { tier: 1 }, validUntil: Date.now() + 86_400_000 };

let cleanup: Array<() => void> = [];

beforeEach(async () => {
  captured = null;
  unsubscribed = 0;
  watchCurrent = true;
  watchUserId = 'user_1';
  cleanup = [];
  // `initialized` latches after the first success, so tear down between cases.
  destroyEntitlementSubscription();
  await initEntitlementSubscription('user_1', () => watchCurrent);
  expect(captured).not.toBeNull();
});

afterEach(() => {
  for (const off of cleanup) off();
  cleanup = [];
  resetEntitlementState();
  destroyEntitlementSubscription();
});

function subscribe(fn: (state: Snapshot) => void): void {
  cleanup.push(onEntitlementChange(fn as (s: unknown) => void));
}

describe('Convex watch fan-out (#5632)', () => {
  it('keeps notifying later listeners when an earlier one throws', () => {
    const order: string[] = [];
    subscribe(() => {
      order.push('first');
      throw new Error('listener blew up');
    });
    subscribe(() => order.push('second'));

    // The real path a live entitlement snapshot takes.
    expect(() => captured!(PRO)).not.toThrow();

    expect(order).toEqual(['first', 'second']);
  });

  it('still commits the snapshot when a listener throws', () => {
    // The throw must not strand `currentState` on the previous value — every
    // later reader (hasTier, isEntitled, the gates) reads that field directly.
    subscribe(() => {
      throw new Error('bad');
    });

    captured!(PRO);

    expect(getEntitlementState()).toEqual(PRO);
  });

  it('drops a late snapshot after the account handoff becomes stale', () => {
    const seen: Snapshot[] = [];
    subscribe((state) => seen.push(state));
    watchUserId = 'user_2';

    captured!(PRO);

    expect(getEntitlementState()).toBeNull();
    expect(seen).toEqual([]);
  });
});
