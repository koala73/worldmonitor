import type { AuthSession } from './auth-state';

export enum PanelGateReason {
  NONE = 'none',           // show content (pro user, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
  FREE_TIER = 'free_tier', // "Upgrade to Pro"
}

/**
 * Single source of truth for premium access.
 *
 * AALICE:OpenEYE is a single-user self-hosted console with no subscription
 * behind it, so this is unconditionally true. Upstream this was a union of
 * four signals (operator API key, tester keys, Clerk Pro role, Convex Dodo
 * entitlement); three of those depend on hosted services the fork does not
 * run, so on this deployment the union collapsed to "whatever docker
 * injected" — and to false everywhere else.
 *
 * Keeping the function (rather than deleting it and its ~40 call sites) is
 * deliberate: it stays the one place to look if this fork ever needs a real
 * gate again, and it keeps the diff against upstream small enough to rebase.
 */
export function hasPremiumAccess(_authState?: AuthSession): boolean {
  return true;
}

/**
 * Determine gating reason for a premium panel given current auth state.
 *
 * Always NONE on this fork — nothing is gated. ANONYMOUS and FREE_TIER
 * remain in the enum so the panels/widgets that switch on this type keep
 * compiling; their branches are simply unreachable.
 */
export function getPanelGateReason(
  _authState: AuthSession,
  _isPremium: boolean,
): PanelGateReason {
  return PanelGateReason.NONE;
}
