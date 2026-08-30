/**
 * Coverage for the passkey offer gate sequence
 * (`evaluatePasskeyOffer` in `src/app/passkey-offer-controller.ts`).
 *
 * The gates are tested directly, over injected effects, rather than through a
 * mounted controller — the same decoupling that lets `runClerkSurfaceOpen` be
 * tested without a browser. What this pins:
 *
 *   - **A cookie hydration is not a sign-in.** Auth state starts
 *     `{user: null, isPending: true}` and becomes a user when a cookie
 *     hydrates, so a naive detector fires on every page load for a returning
 *     user. This is the default case for returning users and the single
 *     highest-value assertion in the file.
 *   - **A failed Clerk load does not arm the detector.** Clerk publishes
 *     `{user: null, isPending: false}` on load failure — byte-identical to a
 *     genuine signed-out session — while keeping subscribers for a retry.
 *   - **Ordering is behavioural.** Every synchronous gate runs before the async
 *     platform-authenticator probe, so a desktop environment never probes.
 *   - **Cancellation before reservation spends nothing.** A superseded or
 *     overlay-blocked evaluation must not mount or claim an account slot.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  evaluatePasskeyOffer,
  identityMatches,
  type PasskeyEvaluationDeps,
  type PasskeyIdentity,
} from '@/app/passkey-offer-controller';

const READY: PasskeyIdentity = { accountKey: 'acct:a', sessionId: 'sess_1', ready: true };
const READY_B: PasskeyIdentity = { accountKey: 'acct:b', sessionId: 'sess_2', ready: true };
const SIGNED_OUT: PasskeyIdentity = { accountKey: null, sessionId: null, ready: false };

/** All gates open. Override one field per test to close exactly one gate. */
function deps(overrides: Partial<PasskeyEvaluationDeps> = {}) {
  const mount = vi.fn();
  const probe = vi.fn(async () => true);
  const reserve = vi.fn(async () => 'reserved' as const);
  const base: PasskeyEvaluationDeps = {
    armed: () => true,
    readEnvironment: () => ({ isDesktopApp: false, inIframe: false, hasPublicKeyCredential: true }),
    readIdentity: () => READY,
    alreadyOffered: () => false,
    capReached: () => false,
    platformAuthenticator: probe,
    blockedByOverlay: () => false,
    deferFrame: async () => {},
    claim: () => true,
    reserveAccountOffer: reserve,
    stillActive: () => true,
    mount,
    ...overrides,
  };
  return { d: base, mount, probe, reserve };
}

describe('identityMatches', () => {
  it('matches only when account, session, and readiness all agree', () => {
    expect(identityMatches(READY, { ...READY })).toBe(true);
    expect(identityMatches(READY, READY_B)).toBe(false);
  });

  it('rejects a DIFFERENT session for the same account', () => {
    // An account-key comparison alone would call this a match, and a passkey
    // could be written against a session the user has already replaced.
    expect(identityMatches(READY, { ...READY, sessionId: 'sess_9' })).toBe(false);
  });

  it('rejects the same account+session that has gone unready', () => {
    // e.g. the session gained a currentTask or lost isSignedIn mid-flight.
    expect(identityMatches(READY, { ...READY, ready: false })).toBe(false);
  });
});

describe('evaluatePasskeyOffer — the arming guard', () => {
  it('mounts after an authoritative signed-out observation (AE1)', async () => {
    const { d, mount } = deps();
    expect(await evaluatePasskeyOffer(d)).toBe('mounted');
    expect(mount).toHaveBeenCalledOnce();
  });

  it('does NOT mount on a cold cookie hydration (AE12)', async () => {
    // No signed-out state was ever observed, so this is a page load completing,
    // not a sign-in. Without this guard the prompt appears on every visit.
    const { d, mount, probe } = deps({ armed: () => false });
    expect(await evaluatePasskeyOffer(d)).toBe('not-armed');
    expect(mount).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not mount for a session that is not ready (AE11)', async () => {
    const { d, mount } = deps({ readIdentity: () => ({ ...READY, ready: false }) });
    expect(await evaluatePasskeyOffer(d)).toBe('not-ready');
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not mount when there is no account yet', async () => {
    const { d, mount } = deps({ readIdentity: () => SIGNED_OUT });
    expect(await evaluatePasskeyOffer(d)).toBe('not-ready');
    expect(mount).not.toHaveBeenCalled();
  });
});

describe('evaluatePasskeyOffer — capability gates', () => {
  it('rejects the desktop app WITHOUT probing the authenticator (AE5)', async () => {
    // Ordering is the assertion: a synchronous gate must short-circuit before
    // the async probe, or the desktop exclusion costs a round trip.
    const { d, mount, probe } = deps({
      readEnvironment: () => ({ isDesktopApp: true, inIframe: false, hasPublicKeyCredential: true }),
    });
    expect(await evaluatePasskeyOffer(d)).toBe('ineligible-environment');
    expect(probe).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('rejects an iframe without probing', async () => {
    const { d, probe } = deps({
      readEnvironment: () => ({ isDesktopApp: false, inIframe: true, hasPublicKeyCredential: true }),
    });
    expect(await evaluatePasskeyOffer(d)).toBe('ineligible-environment');
    expect(probe).not.toHaveBeenCalled();
  });

  it('DOES mount on a new device even though the account has a passkey', async () => {
    // AE4 reversed deliberately. A platform passkey lives in one authenticator:
    // Touch ID on a Mac syncs to that person's Apple devices and nowhere else.
    // The old account-wide passkey gate meant a Mac passkey blocked the offer
    // on Windows, where no usable credential exists. The per-device record is
    // now the only suppression, so this evaluation must reach a mount.
    const { d, mount } = deps({ alreadyOffered: () => false, capReached: () => false });
    expect(await evaluatePasskeyOffer(d)).toBe('mounted');
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('does not mount once the lifetime account cap is spent', async () => {
    // The backstop for a browser that cannot keep a device record at all and
    // would otherwise be prompted on every single page load.
    const { d, mount, probe } = deps({ capReached: () => true });
    expect(await evaluatePasskeyOffer(d)).toBe('offer-cap-reached');
    expect(probe).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('reports the DEVICE record ahead of the cap when both would suppress', async () => {
    // Diagnosis depends on telling these apart: one means "asked here before",
    // the other means "asked too many times overall".
    const { d } = deps({ alreadyOffered: () => true, capReached: () => true });
    expect(await evaluatePasskeyOffer(d)).toBe('already-offered');
  });

  it('does not mount when the ledger already holds this account (AE6)', async () => {
    const { d, mount, probe } = deps({ alreadyOffered: () => true });
    expect(await evaluatePasskeyOffer(d)).toBe('already-offered');
    expect(probe).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not mount without a platform authenticator', async () => {
    const { d, mount } = deps({ platformAuthenticator: async () => false });
    expect(await evaluatePasskeyOffer(d)).toBe('no-platform-authenticator');
    expect(mount).not.toHaveBeenCalled();
  });

  it('checks the ledger scoped to the evaluated account', async () => {
    const alreadyOffered = vi.fn(() => false);
    const { d } = deps({ alreadyOffered });
    await evaluatePasskeyOffer(d);
    expect(alreadyOffered).toHaveBeenCalledWith('acct:a');
  });
});

describe('evaluatePasskeyOffer — overlay arbitration', () => {
  it('yields to an overlay present at evaluation time, spending nothing (AE9)', async () => {
    const { d, mount, probe } = deps({ blockedByOverlay: () => true });
    expect(await evaluatePasskeyOffer(d)).toBe('blocked-by-overlay');
    expect(mount).not.toHaveBeenCalled();
    // Never probed, and — critically — never mounted, so no ledger write and
    // no `shown` event. A yielded offer is not a spent one (AE10).
    expect(probe).not.toHaveBeenCalled();
  });

  it('yields to an overlay that opens during the deferred frame', async () => {
    // The pre-defer check passed; the overlay opened inside the frame. A
    // one-shot check would mount underneath a focus trap.
    let open = false;
    const { d, mount } = deps({
      blockedByOverlay: () => open,
      deferFrame: async () => { open = true; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('blocked-by-overlay');
    expect(mount).not.toHaveBeenCalled();
  });
});

describe('evaluatePasskeyOffer — stale-work cancellation', () => {
  it('discards when the account switches during the probe (AE13a)', async () => {
    let identity: PasskeyIdentity = READY;
    const { d, mount } = deps({
      readIdentity: () => identity,
      platformAuthenticator: async () => { identity = READY_B; return true; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('discards when the account switches during the deferred frame (AE13a)', async () => {
    let identity: PasskeyIdentity = READY;
    const { d, mount } = deps({
      readIdentity: () => identity,
      deferFrame: async () => { identity = READY_B; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('discards when the SAME account gains a pending task mid-flight', async () => {
    let identity: PasskeyIdentity = READY;
    const { d, mount } = deps({
      readIdentity: () => identity,
      deferFrame: async () => { identity = { ...READY, ready: false }; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('discards when the same account receives a new session mid-flight', async () => {
    let identity: PasskeyIdentity = READY;
    const { d, mount } = deps({
      readIdentity: () => identity,
      deferFrame: async () => { identity = { ...READY, sessionId: 'sess_new' }; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('re-reads the ledger after the defer, so a sibling tab prevents a duplicate', async () => {
    let offered = false;
    const { d, mount } = deps({
      alreadyOffered: () => offered,
      deferFrame: async () => { offered = true; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('already-offered');
    expect(mount).not.toHaveBeenCalled();
  });

  it('re-reads the account cap after the defer', async () => {
    let capped = false;
    const { d, mount, reserve } = deps({
      capReached: () => capped,
      deferFrame: async () => { capped = true; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('offer-cap-reached');
    expect(reserve).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('is single-flight: a losing claim does not mount', async () => {
    // Clerk can emit twice for one session during a deferred probe. Without the
    // claim, that is two mounts, two ledger writes, and two `shown` events.
    const { d, mount, reserve } = deps({ claim: () => false });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(reserve).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not mount when the server reports the account cap spent', async () => {
    const { d, mount } = deps({ reserveAccountOffer: async () => 'cap-reached' });
    expect(await evaluatePasskeyOffer(d)).toBe('offer-cap-reached');
    expect(mount).not.toHaveBeenCalled();
  });

  it('fails closed when the account reservation is unavailable', async () => {
    const { d, mount } = deps({ reserveAccountOffer: async () => 'unavailable' });
    expect(await evaluatePasskeyOffer(d)).toBe('offer-reservation-unavailable');
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not mount when the identity changes during the reservation', async () => {
    let identity: PasskeyIdentity = READY;
    const { d, mount } = deps({
      readIdentity: () => identity,
      reserveAccountOffer: async () => { identity = READY_B; return 'reserved'; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not mount when its controller is destroyed during the reservation', async () => {
    let active = true;
    const { d, mount } = deps({
      stillActive: () => active,
      reserveAccountOffer: async () => { active = false; return 'reserved'; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('superseded');
    expect(mount).not.toHaveBeenCalled();
  });

  it('mounts hidden when an overlay opens during the reservation', async () => {
    let overlayOpen = false;
    const { d, mount } = deps({
      blockedByOverlay: () => overlayOpen,
      reserveAccountOffer: async () => { overlayOpen = true; return 'reserved'; },
    });
    expect(await evaluatePasskeyOffer(d)).toBe('mounted');
    expect(mount).toHaveBeenCalledWith(READY, true);
  });

  it('mounts exactly once when two evaluations race for one claim', async () => {
    let claimed = false;
    const mount = vi.fn();
    const claim = () => { if (claimed) return false; claimed = true; return true; };
    const shared = deps({ claim, mount }).d;
    const results = await Promise.all([
      evaluatePasskeyOffer({ ...shared, mount }),
      evaluatePasskeyOffer({ ...shared, mount }),
    ]);
    expect(results.filter((r) => r === 'mounted')).toHaveLength(1);
    expect(mount).toHaveBeenCalledOnce();
  });

  it('passes the evaluated identity to mount, so the card is bound to it', async () => {
    const { d, mount } = deps();
    await evaluatePasskeyOffer(d);
    expect(mount).toHaveBeenCalledWith(READY, false);
  });
});
