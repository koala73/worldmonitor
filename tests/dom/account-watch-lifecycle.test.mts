import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  clientReady: Promise.resolve(),
  failClient: false,
  watches: [] as Array<{
    update: (value: unknown) => void;
    error: (error: Error) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/services/convex-client', () => ({
  getConvexClient: async () => {
    await harness.clientReady;
    if (harness.failClient) throw new Error('chunk unavailable');
    return {
      onUpdate: (_query: unknown, _args: unknown, update: (value: unknown) => void, error: (error: Error) => void) => {
        const unsubscribe = vi.fn();
        harness.watches.push({ update, error, unsubscribe });
        return Object.assign(unsubscribe, { unsubscribe });
      },
    };
  },
  getConvexApi: async () => ({
    entitlements: { getEntitlementsForUser: 'entitlements' },
    payments: { billing: { getSubscriptionForUser: 'subscription' } },
  }),
  waitForConvexAuth: async () => true,
  waitForConvexAuthForUser: async () => true,
}));
vi.mock('@/services/clerk', () => ({ getCurrentClerkUser: () => ({ id: 'A' }) }));
vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: () => {} }));

import {
  initEntitlementSubscription, destroyEntitlementSubscription, resetEntitlementState,
  getEntitlementState, onEntitlementChange,
} from '@/services/entitlements';
import {
  initSubscriptionWatch, destroySubscriptionWatch, getSubscription, onSubscriptionChange,
} from '@/services/billing';

const machines = [
  { name: 'entitlement', start: initEntitlementSubscription, stop: destroyEntitlementSubscription,
    read: getEntitlementState, subscribe: onEntitlementChange },
  { name: 'billing', start: initSubscriptionWatch, stop: destroySubscriptionWatch,
    read: getSubscription, subscribe: onSubscriptionChange },
];
const cleanups: Array<() => void> = [];
beforeEach(() => {
  destroyEntitlementSubscription();
  resetEntitlementState();
  destroySubscriptionWatch();
  harness.watches = [];
  harness.clientReady = Promise.resolve();
  harness.failClient = false;
});
afterEach(() => {
  cleanups.splice(0).forEach(off => off());
  destroyEntitlementSubscription();
  resetEntitlementState();
  destroySubscriptionWatch();
});

for (const machine of machines) {
  describe(`${machine.name} watch ownership`, () => {
    it('attaches one watch for overlapping initialization and releases it', async () => {
      await Promise.all([machine.start('A'), machine.start('A')]);
      machine.stop();
      expect(harness.watches).toHaveLength(1);
      expect(harness.watches[0]!.unsubscribe).toHaveBeenCalledOnce();
    });

    it('does not attach after destroy while initialization is pending', async () => {
      let release!: () => void;
      harness.clientReady = new Promise<void>(resolve => { release = resolve; });
      const pending = machine.start('A');
      machine.stop();
      release();
      await pending;
      expect(harness.watches).toHaveLength(0);
      await machine.start('A');
      expect(harness.watches).toHaveLength(1);
    });

    it('ignores queued success and error callbacks from a destroyed same-account watch', async () => {
      await machine.start('A');
      const retired = harness.watches[0]!;
      machine.stop();
      await machine.start('A');
      const current = harness.watches[1]!;
      const snapshot = { planKey: 'pro', features: { tier: 1 }, validUntil: Date.now() + 60_000 };
      current.update(snapshot);
      const listener = vi.fn();
      cleanups.push(machine.subscribe(listener));
      listener.mockClear();
      retired.update(null);
      retired.error(new Error('retired transport'));
      expect(machine.read()).toEqual(snapshot);
      expect(listener).not.toHaveBeenCalled();
    });

    it('allows retry after failed initialization', async () => {
      harness.failClient = true;
      await machine.start('A');
      harness.failClient = false;
      await machine.start('A');
      expect(harness.watches).toHaveLength(1);
    });
  });
}

describe('billing notification isolation', () => {
  it.each(['success', 'error'] as const)('delivers %s after an earlier listener throws', async (outcome) => {
    await initSubscriptionWatch('A');
    cleanups.push(onSubscriptionChange(() => { throw new Error('broken consumer'); }));
    const survivor = vi.fn();
    cleanups.push(onSubscriptionChange(survivor));
    const snapshot = {
      status: 'active', planKey: 'pro_monthly', displayName: 'Pro',
      currentPeriodEnd: Date.now() + 60_000, renewalVerificationState: null,
    };
    const watch = harness.watches[0]!;
    const expected = outcome === 'success' ? snapshot : null;
    expect(() => outcome === 'success'
      ? watch.update(snapshot)
      : watch.error(new Error('query failed'))).not.toThrow();
    expect(survivor).toHaveBeenLastCalledWith(expected);
    expect(getSubscription()).toEqual(expected);
  });
});
