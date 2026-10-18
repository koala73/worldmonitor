import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_BILLING_PORTAL_TTL_MS,
  captureBillingPortalIntentFromUrl,
  resumePendingBillingPortal,
} from '../src/services/billing-portal-intent.ts';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function harness(userId: string | null, outcome: 'opened' | 'open-failed' | 'no-customer' = 'opened') {
  const calls = { auth: 0, portal: 0, toasts: [] as string[] };
  let user = userId;
  return {
    calls,
    signIn: (id: string) => { user = id; },
    deps: (storage: ReturnType<typeof memoryStorage>, now = 1_000) => ({
      getUserId: () => user,
      openAuth: () => { calls.auth += 1; },
      openPortal: async () => {
        calls.portal += 1;
        return outcome === 'no-customer'
          ? { outcome } as const
          : { outcome, url: 'https://customer.dodopayments.com/session/x' } as const;
      },
      notify: (m: string) => { calls.toasts.push(m); },
      now: () => now,
      storage,
    }),
  };
}

it('capture strips only billing=portal from the URL and persists the intent', () => {
  const storage = memoryStorage();
  let replaced = '';
  const captured = captureBillingPortalIntentFromUrl({
    location: { href: 'https://www.worldmonitor.app/dashboard?billing=portal&ref=abc#map' },
    replaceUrl: (u) => { replaced = u; },
    now: () => 1_000,
    storage,
  });
  assert.equal(captured, true);
  assert.equal(replaced, 'https://www.worldmonitor.app/dashboard?ref=abc#map');
  assert.equal(storage.map.size, 1);
});

it('capture ignores other billing values and plain dashboard loads', () => {
  for (const href of [
    'https://www.worldmonitor.app/dashboard',
    'https://www.worldmonitor.app/dashboard?billing=checkout',
  ]) {
    const storage = memoryStorage();
    assert.equal(captureBillingPortalIntentFromUrl({ location: { href }, replaceUrl: () => {}, storage }), false);
    assert.equal(storage.map.size, 0);
  }
});

it('signed-in landing opens the portal once and consumes the intent', async () => {
  const storage = memoryStorage();
  captureBillingPortalIntentFromUrl({
    location: { href: 'https://www.worldmonitor.app/dashboard?billing=portal' },
    replaceUrl: () => {}, now: () => 1_000, storage,
  });
  const h = harness('user_1');
  // Boot path and the auth listener race; only one may navigate.
  const [a, b] = await Promise.all([
    resumePendingBillingPortal(h.deps(storage), true),
    resumePendingBillingPortal(h.deps(storage)),
  ]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(h.calls.portal, 1);
  assert.equal(h.calls.auth, 0);
  assert.equal(storage.map.size, 0);
  assert.equal(await resumePendingBillingPortal(h.deps(storage)), false);
  assert.equal(h.calls.portal, 1);
});

it('signed-out landing opens sign-in, then the post-auth resume opens the portal', async () => {
  const storage = memoryStorage();
  captureBillingPortalIntentFromUrl({
    location: { href: 'https://www.worldmonitor.app/dashboard?billing=portal' },
    replaceUrl: () => {}, now: () => 1_000, storage,
  });
  const h = harness(null);
  assert.equal(await resumePendingBillingPortal(h.deps(storage), true), false);
  assert.equal(h.calls.auth, 1);
  assert.equal(h.calls.portal, 0);

  h.signIn('user_1');
  assert.equal(await resumePendingBillingPortal(h.deps(storage, 1_000 + 60_000)), true);
  assert.equal(h.calls.portal, 1);
});

it('an abandoned intent expires instead of ambushing a later sign-in', async () => {
  const storage = memoryStorage();
  storage.setItem('wm-pending-billing-portal', '1000');
  const h = harness('user_1');
  assert.equal(await resumePendingBillingPortal(h.deps(storage, 1_000 + PENDING_BILLING_PORTAL_TTL_MS + 1)), false);
  assert.equal(h.calls.portal, 0);
  assert.equal(storage.map.size, 0);
});

it('no intent: a normal sign-in neither opens auth nor the portal', async () => {
  const h = harness(null);
  assert.equal(await resumePendingBillingPortal(h.deps(memoryStorage())), false);
  assert.deepEqual([h.calls.auth, h.calls.portal], [0, 0]);
});

it('no session storage: a signed-in landing still opens the portal', async () => {
  const h = harness('user_1');
  const deps = { ...h.deps(memoryStorage()), storage: null };
  assert.equal(await resumePendingBillingPortal(deps, true), true);
  assert.equal(h.calls.portal, 1);
});

it('portal outcomes that open nothing tell the user', async () => {
  for (const [outcome, text] of [
    ['open-failed', /allow pop-ups/],
    ['no-customer', /support@worldmonitor\.app/],
  ] as const) {
    const h = harness('user_1', outcome);
    await resumePendingBillingPortal({ ...h.deps(memoryStorage()), storage: null }, true);
    assert.equal(h.calls.toasts.length, 1);
    assert.match(h.calls.toasts[0]!, text);
  }
});
