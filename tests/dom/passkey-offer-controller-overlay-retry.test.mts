/**
 * Regression coverage for the P1 found in review on PR #7353.
 *
 * Clerk's own sign-in modal matches the shared modal predicate (it renders a
 * `.cl-modalBackdrop`), and the auth emission arrives while that modal is still
 * on screen. The evaluation therefore returned `blocked-by-overlay` — correctly,
 * since mounting under a focus trap is the worst available outcome — but nothing
 * ever re-triggered it:
 *
 *   - the auth listener does not fire again for the same session, and
 *   - the overlay MutationObserver bailed out whenever no prompt was mounted.
 *
 * Net effect: an eligible user completed sign-in and was simply never offered a
 * passkey. That is the single most common path through this feature, so the bug
 * would have made the whole thing look like it did nothing.
 *
 * These tests drive the real controller with the leaf services mocked, because
 * the pure gate function cannot see this — the defect lives entirely in the
 * controller's retry wiring.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let authListener: (() => void) | null = null;
type Reservation = 'reserved' | 'cap-reached' | 'unavailable';
let reservationCalls = 0;
let reserveImpl: () => Promise<Reservation> = async () => 'reserved';

const state = {
  clerkLoaded: true,
  userId: null as string | null,
  sessionId: 'sess_1' as string | null,
  ready: false,
  passkeys: [] as unknown[],
};

vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (cb: () => void) => { authListener = cb; return () => { authListener = null; }; },
}));

vi.mock('@/services/clerk', () => ({
  getClerk: () => (state.clerkLoaded
    ? { user: state.userId ? { id: state.userId, passkeys: state.passkeys } : null, session: state.sessionId ? { id: state.sessionId } : null }
    : null),
}));

vi.mock('@/services/passkey-offer-reservation', () => ({
  reserveAccountOffer: () => {
    reservationCalls += 1;
    return reserveImpl();
  },
}));

vi.mock('@/services/passkeys', async (orig) => {
  const actual = await orig<typeof import('@/services/passkeys')>();
  return {
    ...actual,
    // Always a capable browser; the environment gate is covered elsewhere.
    readPasskeyEnvironmentFacts: () => ({ isDesktopApp: false, inIframe: false, hasPublicKeyCredential: true }),
    readPasskeySessionFacts: () => ({ isSignedIn: state.ready, sessionStatus: state.ready ? 'active' : 'pending', hasCurrentTask: false }),
    hasPlatformAuthenticator: async () => true,
    createPasskey: async () => 'created' as const,
  };
});

vi.mock('@/services/analytics', () => ({
  trackPasskeyOfferShown: vi.fn(),
  trackPasskeyOfferAccepted: vi.fn(),
  trackPasskeyOfferCreated: vi.fn(),
  trackPasskeyOfferFailed: vi.fn(),
  trackPasskeyOfferDismissed: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({ t: (k: string) => k }));

import { PasskeyOfferController } from '@/app/passkey-offer-controller';

import type { AppContext } from '@/app/app-context';

const ctx = { isDesktopApp: false } as unknown as AppContext;

/** Stand in for Clerk's sign-in modal, which renders a `.cl-modalBackdrop`. */
function openClerkModal(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'cl-modalBackdrop';
  // happy-dom reports zero rects, so make the visibility probe answer honestly.
  (overlay as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  document.body.appendChild(overlay);
  return overlay;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeController() {
  const memoryStore = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memoryStore.get(k) ?? null,
    setItem: (k: string, v: string) => { memoryStore.set(k, v); },
    removeItem: (k: string) => { memoryStore.delete(k); },
  };
  return new PasskeyOfferController(ctx, { storage, scheduleFrame: (cb) => cb() });
}

const mounted = () => document.querySelectorAll('.passkey-offer-prompt').length;

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  authListener = null;
  state.clerkLoaded = true;
  state.userId = null;
  state.sessionId = 'sess_1';
  state.ready = false;
  state.passkeys = [];
  reservationCalls = 0;
  reserveImpl = async () => 'reserved';
});

describe('the account reservation stays single-flight', () => {
  it('does not start a second reservation for a repeated Clerk emission', async () => {
    let release!: (result: Reservation) => void;
    const pending = new Promise<Reservation>((resolve) => { release = resolve; });
    reserveImpl = () => pending;

    const c = makeController();
    c.init();
    authListener?.();
    await flush();

    state.userId = 'user_abc';
    state.ready = true;
    authListener?.();
    await flush();
    await flush();
    authListener?.();
    await flush();
    await flush();

    release('reserved');
    await flush();
    await flush();
    const calls = reservationCalls;
    const promptCount = mounted();
    c.destroy();

    expect(calls).toBe(1);
    expect(promptCount).toBe(1);
  });

  it('does not mount when destroy runs during the reservation', async () => {
    let release!: (result: Reservation) => void;
    const pending = new Promise<Reservation>((resolve) => { release = resolve; });
    reserveImpl = () => pending;

    const c = makeController();
    c.init();
    authListener?.();
    await flush();

    state.userId = 'user_abc';
    state.ready = true;
    authListener?.();
    await flush();
    await flush();
    c.destroy();

    release('reserved');
    await flush();
    await flush();
    const promptCount = mounted();
    c.destroy();

    expect(promptCount).toBe(0);
  });

  it('re-evaluates the new identity after the prior account reservation settles', async () => {
    let release!: (result: Reservation) => void;
    const first = new Promise<Reservation>((resolve) => { release = resolve; });
    reserveImpl = () => first;

    const c = makeController();
    c.init();
    authListener?.();
    await flush();

    state.userId = 'user_a';
    state.ready = true;
    authListener?.();
    await flush();
    await flush();

    state.userId = 'user_b';
    state.sessionId = 'sess_2';
    authListener?.();
    await flush();
    await flush();

    reserveImpl = async () => 'reserved';
    release('reserved');
    await flush();
    await flush();
    await flush();
    const calls = reservationCalls;
    const promptCount = mounted();
    c.destroy();

    expect(calls).toBe(2);
    expect(promptCount).toBe(1);
  });
});

describe('offer blocked by an overlay is retried when it closes', () => {
  it('mounts after Clerk’s sign-in modal closes, not never (PR #7353 P1)', async () => {
    const c = makeController();
    c.init();

    // 1. Authoritative signed-out observation arms the detector.
    authListener?.();
    await flush();

    // 2. Clerk's sign-in modal is still up when the session lands — the real
    //    sequence, and the one that used to lose the offer permanently.
    const modal = openClerkModal();
    state.userId = 'user_abc';
    state.ready = true;
    authListener?.();
    await flush();
    expect(mounted()).toBe(0);

    // 3. The modal closes. Nothing else will fire the auth listener, so the
    //    overlay observer has to be what brings the offer back.
    modal.remove();
    await flush();
    await flush();

    expect(mounted()).toBe(1);
    c.destroy();
  });

  it('does not retry when the overlay never blocked anything', async () => {
    const c = makeController();
    c.init();
    authListener?.();
    await flush();

    // An unrelated overlay opening and closing with no pending evaluation must
    // not conjure a prompt for a signed-out visitor.
    const modal = openClerkModal();
    await flush();
    modal.remove();
    await flush();

    expect(mounted()).toBe(0);
    c.destroy();
  });

  it('retries only once, and does not double-mount', async () => {
    const c = makeController();
    c.init();
    authListener?.();
    await flush();

    const modal = openClerkModal();
    state.userId = 'user_abc';
    state.ready = true;
    authListener?.();
    await flush();

    modal.remove();
    await flush();
    await flush();
    // A further unrelated mutation must not mount a second card.
    document.body.appendChild(document.createElement('span'));
    await flush();
    await flush();

    expect(mounted()).toBe(1);
    c.destroy();
  });
});

describe('the cached-mode banner drives --wm-bottom-banner (PR #7353 P2)', () => {
  const bannerVar = () => document.documentElement.style.getPropertyValue('--wm-bottom-banner');

  it('measures a banner that exists at init', async () => {
    const banner = document.createElement('div');
    banner.className = 'cached-mode-banner';
    Object.defineProperty(banner, 'getBoundingClientRect', { value: () => ({ height: 96 }) });
    document.body.appendChild(banner);

    const c = makeController();
    c.init();
    await flush();
    expect(bannerVar()).toBe('96px');
    c.destroy();
  });

  it('resets to 0px when the banner is removed, so the card does not float', async () => {
    const banner = document.createElement('div');
    banner.className = 'cached-mode-banner';
    Object.defineProperty(banner, 'getBoundingClientRect', { value: () => ({ height: 96 }) });
    document.body.appendChild(banner);

    const c = makeController();
    c.init();
    await flush();
    expect(bannerVar()).toBe('96px');

    banner.remove();
    await flush();
    await flush();
    expect(bannerVar()).toBe('0px');
    c.destroy();
  });

  it('re-binds when App.ts recreates the banner as a NEW element', async () => {
    const c = makeController();
    c.init();
    await flush();
    // With no banner present the controller leaves the inline property unset;
    // the `:root { --wm-bottom-banner: 0px }` rule in main.css is the default,
    // so an empty inline value and '0px' are the same thing here.
    expect(['', '0px']).toContain(bannerVar());

    const replacement = document.createElement('div');
    replacement.className = 'cached-mode-banner';
    Object.defineProperty(replacement, 'getBoundingClientRect', { value: () => ({ height: 145 }) });
    document.body.appendChild(replacement);
    await flush();
    await flush();

    expect(bannerVar()).toBe('145px');
    c.destroy();
  });

  it('clears the property on teardown', async () => {
    const banner = document.createElement('div');
    banner.className = 'cached-mode-banner';
    Object.defineProperty(banner, 'getBoundingClientRect', { value: () => ({ height: 96 }) });
    document.body.appendChild(banner);

    const c = makeController();
    c.init();
    await flush();
    c.destroy();
    expect(bannerVar()).toBe('0px');
  });
});
