/**
 * Historical-playback gate (#5632).
 *
 * The control used to be hidden behind `authState.user?.role === 'pro'`, but
 * nothing in this codebase writes Clerk `publicMetadata.plan`/`role`, so that
 * field reads `'free'` for every account — the control rendered for nobody.
 *
 * Playback is a Pro takeaway (tier >= 1), not a Pro Business one, so the
 * positive signal is `hasPremiumAccess()`. What is NOT delegated to it is the
 * failure direction: it returns `false` for every "we don't know yet" state,
 * and shipping that verbatim would trade a permanent gate on a dead field for
 * a permanent gate on a missing snapshot.
 *
 * Zero-import leaf on purpose: it is unit-tested under `tsx --test` (no jsdom,
 * no Vite globals), and both the services and app layers consume it. Keep it
 * that way — see the same constraint on `export-gate.ts`.
 */

export interface PlaybackGateInputs {
  /**
   * `hasPremiumAccess(authState)` — desktop WORLDMONITOR_API_KEY, browser
   * tester keys, Clerk pro role, or a live Convex entitlement.
   */
  premiumAccess: boolean;
  /** Clerk auth still resolving (the boot default — auth-state.ts:19). */
  authPending: boolean;
  signedIn: boolean;
  /**
   * An entitlement snapshot has arrived. `false` covers both "still in flight"
   * and "never coming" — `initEntitlementSubscription` gives up silently when
   * VITE_CONVEX_URL is unset or Convex auth misses its 10s window.
   */
  entitlementLoaded: boolean;
}

/**
 * `'pending'` and `'denied'` both hide the control; they differ in what we
 * KNOW. Only `'denied'` is an affirmative "this session is not entitled" and
 * therefore the only verdict that may be counted as a gate hit — folding the
 * boot state into the funnel metric would bury real denials under a tick from
 * every page load, including subscribers who were never gated at all.
 */
export type PlaybackGateVerdict = 'visible' | 'pending' | 'denied';

/**
 * Decide whether the playback control is shown.
 *
 * Order matters, and the two "unknown" states resolve DIFFERENTLY on purpose:
 *
 *   1. premium access      → visible (covers every entitlement path at once)
 *   2. auth pending        → pending. Bounded whenever Clerk is configured: it
 *      hydrates within its ~4s idle window and the subscription re-runs this
 *      immediately after. (With no publishable key `isPending` is sticky —
 *      clerk.ts's `isClerkAuthEnabled` exists for that case — but no entitled
 *      session can be stuck behind it, since every premium path short-circuits
 *      at step 1 and `isEntitled()` transitively requires Clerk anyway.)
 *      Waiting costs a subscriber a brief delay; the alternative flashes a
 *      Pro-only control into every anonymous visitor's header and then yanks it.
 *   3. signed out          → denied. The only affirmative denial available
 *      without a snapshot — anonymous sessions have no entitlement row to read.
 *   4. no snapshot yet     → VISIBLE. Unbounded, unlike step 2: a skipped or
 *      failed Convex subscription never resolves, so hiding here would be a
 *      permanent lockout for a paying customer rather than a boot blip. Never
 *      over-gate (post-mortem: src/app/panel-layout.ts:723-748). A signed-in
 *      free user therefore sees the control until their snapshot lands; the
 *      caller must handle losing it mid-use (event-handlers.ts exitPlayback).
 *   5. otherwise           → denied. Signed in, snapshot loaded, and no premium
 *      path matched — the one state we affirmatively know is unentitled. An
 *      expired or lapsed row lands here too, which is correct: `isEntitled()`
 *      already rejected it on `validUntil`.
 */
export function resolvePlaybackGate(input: PlaybackGateInputs): PlaybackGateVerdict {
  if (input.premiumAccess) return 'visible';
  if (input.authPending) return 'pending';
  if (!input.signedIn) return 'denied';
  if (!input.entitlementLoaded) return 'visible';
  return 'denied';
}
