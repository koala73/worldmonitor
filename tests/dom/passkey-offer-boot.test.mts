/**
 * Coverage for the eager boot shim (`src/app/passkey-offer-boot.ts`).
 *
 * The shim exists to keep ~12 KB of passkey code out of the first-paint chunk:
 * the offer cannot fire until someone signs in, and most page loads never do.
 * But deferring it introduces exactly one way to break the feature silently —
 * losing the arming observation.
 *
 * The detector may only arm on an AUTHORITATIVE signed-out state (Clerk loaded,
 * no session). So the shim must subscribe eagerly, not on idle: a user who
 * signs in quickly would otherwise be seen as already-signed-in with no prior
 * signed-out reading, and would never be offered. These tests pin that, plus
 * the two states that must NOT arm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let authListener: (() => void) | null = null;
const state = { clerkLoaded: true, userId: null as string | null };

vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (cb: () => void) => { authListener = cb; return () => { authListener = null; }; },
}));

vi.mock('@/services/clerk', () => ({
  getClerk: () => (state.clerkLoaded ? { user: state.userId ? { id: state.userId } : null } : null),
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

const ctx = { isDesktopApp: false } as unknown as AppContext;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  authListener = null;
  state.clerkLoaded = true;
  state.userId = null;
  loaded.count = 0;
  loaded.preArmed = [];
  loaded.destroyed = 0;
  loaded.inited = 0;
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

  it('does NOT hand off on a cold cookie hydration', async () => {
    // No signed-out state was ever observed — this is a page load completing,
    // not a sign-in, and is the case that would otherwise prompt every visit.
    const boot = new PasskeyOfferBoot(ctx);
    state.userId = 'user_abc';
    boot.init();
    authListener?.();
    await flush();
    expect(loaded.count).toBe(0);
    boot.destroy();
  });

  it('does NOT arm on a user-null reading while Clerk is absent', async () => {
    // A failed SDK load publishes a user-null state indistinguishable from a
    // real signed-out session. Arming on it would fire the offer when the
    // retry hydrates an existing cookie.
    const boot = new PasskeyOfferBoot(ctx);
    boot.init();
    state.clerkLoaded = false;
    authListener?.();            // looks signed out, but Clerk never loaded
    state.clerkLoaded = true;
    state.userId = 'user_abc';
    authListener?.();            // retry succeeds and hydrates the cookie
    await flush();
    expect(loaded.count).toBe(0);
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
