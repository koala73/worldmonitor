/**
 * Coverage for the eager boot shim (`src/app/passkey-offer-boot.ts`).
 *
 * The shim exists to keep ~12 KB of passkey code out of the first-paint chunk:
 * the offer cannot fire until someone signs in, and most page loads never do.
 * But deferring it introduces exactly one way to break the feature silently —
 * losing the arming observation.
 *
 * The shim also owns the reach decision, because that decision determines
 * whether the chunk is worth fetching at all. It hands off both for a fresh
 * sign-in and for a returning session, and runs every suppression BEFORE either
 * one so a user who is not going to be offered never pays for the import.
 *
 * These tests pin that ordering, the three suppression tiers, and the states
 * that must not arm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let authListener: (() => void) | null = null;
const state = {
  clerkLoaded: true,
  userId: null as string | null,
  passkeys: [] as unknown[],
  unsafeMetadata: {} as Record<string, unknown>,
};

vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (cb: () => void) => { authListener = cb; return () => { authListener = null; }; },
}));

vi.mock('@/services/clerk', () => ({
  getClerk: () => (state.clerkLoaded
    ? {
        user: state.userId
          ? { id: state.userId, passkeys: state.passkeys, unsafeMetadata: state.unsafeMetadata }
          : null,
      }
    : null),
}));

const loaded = { count: 0, preArmed: [] as (boolean | undefined)[], destroyed: 0, inited: 0 };

vi.mock('@/app/passkey-offer-controller', () => ({
  PasskeyOfferController: class {
    constructor(_ctx: unknown, opts?: { preArmed?: boolean }) {
      loaded.count += 1;
      loaded.preArmed.push(opts?.preArmed);
    }
    init() { loaded.inited += 1; }
    destroy() { loaded.destroyed += 1; }
  },
}));

import type { AppContext } from '@/app/app-context';
import { PasskeyOfferBoot } from '@/app/passkey-offer-boot';
import {
  derivePasskeyAccountKey,
  passkeyOfferStorageKey,
  readAccountOfferCount,
} from '@/services/passkey-offer-state';
import { getPasskeyOfferTrace, resetPasskeyOfferTrace } from '@/utils/passkey-offer-trace';

const ctx = { isDesktopApp: false } as unknown as AppContext;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  authListener = null;
  state.clerkLoaded = true;
  state.userId = null;
  state.passkeys = [];
  state.unsafeMetadata = {};
  localStorage.clear();
  loaded.count = 0;
  loaded.preArmed = [];
  loaded.destroyed = 0;
  loaded.inited = 0;
  resetPasskeyOfferTrace();
});

describe('PasskeyOfferBoot', () => {
  it('subscribes eagerly, so a fast sign-in is still caught', () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    // The whole point of an eager subscription: a listener exists before the
    // user has had any chance to sign in.
    expect(authListener).not.toBeNull();
    boot.destroy();
  });

  it('loads nothing while the visitor stays signed out', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    authListener?.();
    await flush();
    expect(loaded.count).toBe(0);
    boot.destroy();
  });

  it('hands off on a real sign-in, pre-armed so the offer is not lost', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();

    authListener?.();            // authoritative signed-out → arm
    state.userId = 'user_abc';
    authListener?.();            // sign-in → hand off
    await flush();

    expect(loaded.count).toBe(1);
    expect(loaded.inited).toBe(1);
    // Without preArmed the controller would re-derive arming from scratch,
    // never see a signed-out state, and drop the very offer this handoff exists
    // to deliver.
    expect(loaded.preArmed).toEqual([true]);
    boot.destroy();
  });

  it('DOES hand off for a returning session that has never been offered', async () => {
    // The production regression. This user is already signed in on page load,
    // so no signed-out state is ever observed. Under the old arming guard the
    // shim stopped here and the entire already-signed-in population was never
    // asked; the live trace read
    // ['clerk-absent', 'cold-hydration-suppressed' x3].
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    boot.init();
    authListener?.();
    await flush();

    expect(loaded.count).toBe(1);
    expect(loaded.preArmed).toEqual([true]);
    boot.destroy();
  });

  it('does NOT hand off once the lifetime account cap is spent', async () => {
    // The backstop, checked in the shim rather than the controller so a capped
    // user never fetches a ~12 KB chunk that would only bail out.
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    state.unsafeMetadata = { wmPasskeyOfferCount: 3 };
    boot.init();
    authListener?.();
    await flush();

    expect(loaded.count).toBe(0);
    expect(getPasskeyOfferTrace()).toContain('offer-cap-reached');
    boot.destroy();
  });

  it('still hands off below the cap', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    state.unsafeMetadata = { wmPasskeyOfferCount: 2 };
    boot.init();
    authListener?.();
    await flush();

    expect(loaded.count).toBe(1);
    boot.destroy();
  });

  it('DOES hand off on a new device even though the account has a passkey', async () => {
    // The multi-device fix. An account-wide passkey count says nothing about
    // whether a credential is usable on THIS browser, so it must not suppress.
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    state.passkeys = [{ id: 'pk_1' }, { id: 'pk_2' }];
    boot.init();
    authListener?.();
    await flush();

    expect(loaded.count).toBe(1);
    boot.destroy();
  });

  it('counts the legacy single-shot record as one offer, not zero', async () => {
    // Anyone suppressed under the old "once per account, ever" policy must not
    // restart from zero and collect a fresh run of prompts.
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    state.unsafeMetadata = { wmPasskeyOfferedAt: 1_700_000_000_000 };
    boot.init();
    authListener?.();
    await flush();

    // One of three spent, so this device is still offered — but the count is
    // seeded, not reset.
    expect(loaded.count).toBe(1);
    expect(readAccountOfferCount({ unsafeMetadata: state.unsafeMetadata })).toBe(1);
    boot.destroy();
  });

  it('does NOT hand off when the local ledger already holds the account', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    localStorage.setItem(
      passkeyOfferStorageKey(derivePasskeyAccountKey('user_abc') as string),
      JSON.stringify({ at: Date.now() }),
    );
    boot.init();
    authListener?.();
    await flush();

    expect(loaded.count).toBe(0);
    expect(getPasskeyOfferTrace()).toContain('already-offered');
    boot.destroy();
  });

  it('does NOT arm on a user-null reading while Clerk is absent', async () => {
    // A failed SDK load publishes a user-null state indistinguishable from a
    // real signed-out session. The retry that hydrates an existing cookie is a
    // returning session, not a sign-in, and must be recorded as one — arming
    // here would misattribute every Clerk load failure as a fresh sign-in.
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    state.clerkLoaded = false;
    authListener?.();            // looks signed out, but Clerk never loaded
    state.clerkLoaded = true;
    state.userId = 'user_abc';
    authListener?.();            // retry succeeds and hydrates the cookie
    await flush();

    expect(getPasskeyOfferTrace()).toEqual([
      'clerk-absent',
      'load-returning-session',
      'import-started',
    ]);
    boot.destroy();
  });

  it('loads the controller at most once', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    authListener?.();
    state.userId = 'user_abc';
    authListener?.();
    await flush();
    authListener?.();
    await flush();
    expect(loaded.count).toBe(1);
    boot.destroy();
  });

  it('destroys the loaded controller when torn down', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    authListener?.();
    state.userId = 'user_abc';
    authListener?.();
    await flush();

    boot.destroy();
    expect(loaded.destroyed).toBe(1);
  });

  it('is safe to destroy before any handoff', () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    expect(() => boot.destroy()).not.toThrow();
    expect(loaded.count).toBe(0);
  });
});

describe('diagnostic trace', () => {
  it('distinguishes a returning session from a fresh sign-in', async () => {
    // The trace lives in the shim because on a suppressed path the controller
    // never loads, so controller-side instrumentation could never report it.
    // These two reasons are what let a live trace answer HOW the user arrived.
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    boot.init();
    authListener?.();
    await flush();
    expect(getPasskeyOfferTrace()).toEqual(['load-returning-session', 'import-started']);
    boot.destroy();
  });

  it('records the arming observation and the handoff, in order', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    authListener?.();
    state.userId = 'user_abc';
    authListener?.();
    await flush();
    expect(getPasskeyOfferTrace()).toEqual(['signed-out-observed', 'load-sign-in', 'import-started']);
    boot.destroy();
  });

  it('records clerk-absent rather than staying silent', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    state.clerkLoaded = false;
    boot.init();
    authListener?.();
    await flush();
    expect(getPasskeyOfferTrace()).toEqual(['clerk-absent']);
    boot.destroy();
  });

  it('records nothing that is not a closed-vocabulary member', async () => {
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    authListener?.();
    state.userId = 'user_abc';
    authListener?.();
    await flush();
    // No account key, user id, or session id may ever reach the trace.
    for (const entry of getPasskeyOfferTrace()) {
      expect(entry).not.toContain('user_');
      expect(entry).not.toContain('acct:');
    }
    boot.destroy();
  });
});
