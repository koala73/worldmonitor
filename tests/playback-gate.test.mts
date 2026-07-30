/**
 * #5632 — the playback-gate decision chain.
 *
 * `src/services/playback-gate.ts` is a zero-import leaf, so this suite needs no
 * DOM, no Convex and no Vite globals. The wiring that feeds it live state is
 * covered separately by `tests/dom/playback-gate-wiring.test.mts`.
 *
 * The shape under test is affirmative denial with ONE deliberate asymmetry: a
 * pending Clerk session hides the control (bounded wait) while a missing
 * entitlement snapshot shows it (unbounded — a skipped Convex subscription
 * never resolves, and hiding there is the permanent lockout this issue is
 * about).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePlaybackGate, type PlaybackGateInputs } from '@/services/playback-gate';

/** Signed-in free user with a loaded snapshot — the one state that must deny. */
function inputs(overrides: Partial<PlaybackGateInputs> = {}): PlaybackGateInputs {
  return {
    premiumAccess: false,
    authPending: false,
    signedIn: true,
    entitlementLoaded: true,
    ...overrides,
  };
}

describe('resolvePlaybackGate — decision chain', () => {
  it('denies the baseline: signed in, snapshot loaded, no premium path', () => {
    assert.equal(resolvePlaybackGate(inputs()), 'denied');
  });

  it('shows the control whenever a premium path matched', () => {
    assert.equal(resolvePlaybackGate(inputs({ premiumAccess: true })), 'visible');
  });

  it('shows the control to a signed-in user with NO entitlement snapshot', () => {
    // The regression this issue exists for. A late, failed or skipped Convex
    // subscription is an unknown that may never resolve — never over-gate.
    assert.equal(resolvePlaybackGate(inputs({ entitlementLoaded: false })), 'visible');
  });

  it('denies an anonymous visitor even though they have no snapshot either', () => {
    // Signed-out is the one affirmative denial reachable without a snapshot,
    // so it must be checked BEFORE the null-snapshot allowance above —
    // otherwise every anonymous visitor falls through to `visible`.
    assert.equal(
      resolvePlaybackGate(inputs({ signedIn: false, entitlementLoaded: false })),
      'denied',
    );
  });

  it('reports pending — not denied — while Clerk auth is still resolving', () => {
    // Distinct from `denied` so the caller can hide the control without
    // charging the funnel a gate hit for a user who was never gated.
    assert.equal(
      resolvePlaybackGate(inputs({ authPending: true, signedIn: false, entitlementLoaded: false })),
      'pending',
    );
  });

  it('shows the control to a premium session before auth or Convex settle', () => {
    // The desktop runtime path: WORLDMONITOR_API_KEY present, no Clerk session
    // will ever exist, no entitlement row will ever arrive.
    assert.equal(
      resolvePlaybackGate(
        inputs({
          premiumAccess: true,
          authPending: true,
          signedIn: false,
          entitlementLoaded: false,
        }),
      ),
      'visible',
    );
  });

  it('never denies a signed-in session on the strength of a pending auth read', () => {
    // A cookie-backed subscriber mid-hydration must not be denied — pending
    // outranks every affirmative-denial branch below it.
    assert.equal(resolvePlaybackGate(inputs({ authPending: true })), 'pending');
  });

  it('only ever denies when we hold affirmative evidence', () => {
    // Exhaustive sweep of the 16-state input space: assert that no combination
    // reaches `denied` without either a settled signed-out session or a loaded
    // snapshot on a signed-in one. A future reordering that lets an unknown
    // fall through to denial fails here, not in production.
    for (const premiumAccess of [false, true]) {
      for (const authPending of [false, true]) {
        for (const signedIn of [false, true]) {
          for (const entitlementLoaded of [false, true]) {
            const state = { premiumAccess, authPending, signedIn, entitlementLoaded };
            const verdict = resolvePlaybackGate(state);
            if (verdict !== 'denied') continue;

            assert.equal(premiumAccess, false, `premium session denied: ${JSON.stringify(state)}`);
            assert.equal(authPending, false, `pending session denied: ${JSON.stringify(state)}`);
            assert.ok(
              !signedIn || entitlementLoaded,
              `signed-in session denied with no snapshot: ${JSON.stringify(state)}`,
            );
          }
        }
      }
    }
  });
});
