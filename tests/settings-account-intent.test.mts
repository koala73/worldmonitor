import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_ACCOUNT_SETTINGS_TTL_MS,
  createAccountSettingsIntent,
} from '../src/services/settings-account-intent.ts';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

type Auth = { isPending: boolean; userId: string | null };

function harness(initial: Auth, options: { canSignIn?: boolean; href?: string; storage?: ReturnType<typeof memoryStorage> | null; now?: number } = {}) {
  let auth = initial;
  let now = options.now ?? 1_000;
  const calls = { account: 0, settings: 0, signIn: 0, replaced: [] as string[] };
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const intent = createAccountSettingsIntent({
    getAuth: () => auth,
    canSignIn: () => options.canSignIn ?? true,
    openAccount: () => { calls.account += 1; },
    openSettings: () => { calls.settings += 1; },
    openSignIn: () => { calls.signIn += 1; },
    now: () => now,
    storage,
  });
  const capture = (href = options.href ?? 'https://www.worldmonitor.app/dashboard?settings=account') =>
    intent.capture({ href }, (url) => { calls.replaced.push(url); });
  return {
    intent,
    calls,
    storage,
    capture,
    setAuth: (next: Auth) => { auth = next; },
    advance: (ms: number) => { now += ms; },
  };
}

it('captures ?settings=account, strips only that param and keeps utm_* for attribution', () => {
  const h = harness({ isPending: true, userId: null });
  const captured = h.capture('https://www.worldmonitor.app/dashboard?settings=account&utm_source=email&utm_campaign=bf#x');
  assert.equal(captured, true);
  assert.deepEqual(h.calls.replaced, ['https://www.worldmonitor.app/dashboard?utm_source=email&utm_campaign=bf#x']);
  assert.equal(h.intent.isPending(), true);
});

it('ignores other settings values and URLs without the param', () => {
  const h = harness({ isPending: false, userId: 'u1' });
  assert.equal(h.capture('https://www.worldmonitor.app/dashboard?settings=notifications'), false);
  assert.equal(h.capture('https://www.worldmonitor.app/dashboard?utm_source=email'), false);
  assert.equal(h.intent.isPending(), false);
  assert.equal(h.intent.resume(), 'none');
  assert.equal(h.calls.account, 0);
});

// Clerk loads on idle, so at boot a signed-in subscriber is still pending.
// Opening Settings then would land on Display: Account is unavailable until
// the session settles, and settling never moves the open page.
it('waits while auth is pending, then opens Account once the session settles signed in', () => {
  const h = harness({ isPending: true, userId: null });
  h.capture();
  assert.equal(h.intent.resume(), 'waiting');
  assert.equal(h.calls.account + h.calls.settings + h.calls.signIn, 0);

  h.setAuth({ isPending: false, userId: 'u1' });
  assert.equal(h.intent.resume(), 'opened');
  assert.equal(h.calls.account, 1);
  assert.equal(h.intent.isPending(), false);
  // A second auth emission (the entitlement refresh, a token rotation) does not reopen.
  assert.equal(h.intent.resume(), 'none');
  assert.equal(h.calls.account, 1);
});

it('asks a signed-out visitor to sign in once, then opens Account after sign-in', () => {
  const h = harness({ isPending: true, userId: null });
  h.capture();
  h.setAuth({ isPending: false, userId: null });
  assert.equal(h.intent.resume(), 'sign-in');
  assert.equal(h.intent.resume(), 'sign-in');
  assert.equal(h.calls.signIn, 1, 'the sign-in prompt opens once per page load');
  assert.equal(h.calls.account, 0);

  h.setAuth({ isPending: false, userId: 'u1' });
  assert.equal(h.intent.resume(), 'opened');
  assert.equal(h.calls.account, 1);
});

// An OAuth sign-in leaves the page and returns to a URL the map sync already
// rewrote, so the intent must survive in session storage.
it('resumes after a sign-in redirect from session storage', () => {
  const storage = memoryStorage();
  const first = harness({ isPending: false, userId: null }, { storage });
  first.capture();
  assert.equal(first.intent.resume(), 'sign-in');

  const second = harness({ isPending: false, userId: 'u1' }, { storage, now: 1_000 + 60_000 });
  assert.equal(second.capture('https://www.worldmonitor.app/dashboard'), false);
  assert.equal(second.intent.isPending(), true);
  assert.equal(second.intent.resume(), 'opened');
  assert.equal(second.calls.account, 1);
  assert.equal(storage.map.size, 0);
});

it('drops a stored intent older than the TTL', () => {
  const storage = memoryStorage();
  harness({ isPending: false, userId: null }, { storage }).capture();
  const later = harness({ isPending: false, userId: 'u1' }, { storage, now: 1_000 + PENDING_ACCOUNT_SETTINGS_TTL_MS + 1 });
  assert.equal(later.intent.isPending(), false);
  assert.equal(later.intent.resume(), 'none');
  assert.equal(later.calls.account, 0);
  assert.equal(storage.map.size, 0);
});

it('opens Settings without a sign-in prompt in a build that offers no sign-in', () => {
  const h = harness({ isPending: false, userId: null }, { canSignIn: false });
  h.capture();
  assert.equal(h.intent.resume(), 'opened');
  assert.equal(h.calls.settings, 1);
  assert.equal(h.calls.signIn, 0);
  assert.equal(h.intent.isPending(), false);
});

it('still opens Account on this load when session storage is unavailable', () => {
  const h = harness({ isPending: true, userId: null }, { storage: null });
  assert.equal(h.capture(), true);
  h.setAuth({ isPending: false, userId: 'u1' });
  assert.equal(h.intent.resume(), 'opened');
  assert.equal(h.calls.account, 1);
});

// A visitor who dismisses sign-in and signs in from the header much later,
// without reloading, must not be ambushed by Settings.
it('expires an intent captured on this load after the TTL, with or without storage', () => {
  for (const storage of [memoryStorage(), null]) {
    const h = harness({ isPending: false, userId: null }, { storage });
    h.capture();
    assert.equal(h.intent.resume(), 'sign-in');
    h.advance(PENDING_ACCOUNT_SETTINGS_TTL_MS + 1);
    h.setAuth({ isPending: false, userId: 'u1' });
    assert.equal(h.intent.isPending(), false);
    assert.equal(h.intent.resume(), 'none');
    assert.equal(h.calls.account, 0);
  }
});

it('still opens Account within the TTL on this load without storage', () => {
  const h = harness({ isPending: false, userId: null }, { storage: null });
  h.capture();
  h.intent.resume();
  h.advance(PENDING_ACCOUNT_SETTINGS_TTL_MS - 1);
  h.setAuth({ isPending: false, userId: 'u1' });
  assert.equal(h.intent.resume(), 'opened');
  assert.equal(h.calls.account, 1);
});
