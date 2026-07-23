import type { AuthSession } from './auth-state';
import { getSubscription } from './billing';
import { deriveBillingUxState, getBillingGateOverride } from './billing-state';
import { getEntitlementState } from './entitlements';
import { getSecretState } from './runtime-config';
import { isProUser } from './widget-store';

export enum PanelGateReason {
  NONE = 'none',           // show content (pro user, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
  FREE_TIER = 'free_tier', // "Upgrade to Pro"
  // #4771 billing-aware refinements of FREE_TIER — the user has (or had) paid
  // evidence, so a generic Upgrade CTA would be misleading.
  PAYMENT_ON_HOLD = 'payment_on_hold', // "Update Payment" (payment failed, retry window)
  RENEWAL_PENDING = 'renewal_pending', // "Refresh Status" (renewal verification in progress)
  RENEWAL_FAILED = 'renewal_failed',   // "Manage Billing" (provider check failed)
  LAPSED = 'lapsed',                   // "Resubscribe" (provider confirmed coverage ended)
}

/**
 * Single source of truth for premium access.
 * Covers all access paths: desktop API key, tester keys (wm-pro-key / wm-widget-key),
 * Clerk Pro role, and Convex Dodo entitlement (the latter two via isProUser).
 *
 * The Convex entitlement check is the authoritative signal for paying
 * customers — Clerk `publicMetadata.plan` is NOT written by our webhook
 * pipeline, so a user with a valid Dodo subscription would otherwise show
 * as free here even though isPanelEntitled() already allowed them past
 * the panel-rendering gate. That split caused paying users to see the
 * "Upgrade to Pro" paywall overlay on top of panels they were entitled to,
 * reproducing the 2026-04-17/18 duplicate-subscription incident.
 *
 * isEntitled() is folded into isProUser() (see widget-store.ts) so every
 * call site that checks isProUser — widgets, search, event handlers —
 * agrees with panel gating. That keeps this function a thin union of
 * signals that aren't already covered by isProUser.
 */
export function hasPremiumAccess(authState?: AuthSession): boolean {
  if (getSecretState('WORLDMONITOR_API_KEY').present) return true;
  if (isProUser()) return true;
  if (authState?.user?.role === 'pro') return true;
  return false;
}

/**
 * Determine gating reason for a premium panel given current auth state.
 * Non-premium panels always return NONE.
 */
export function getPanelGateReason(
  authState: AuthSession,
  isPremium: boolean,
): PanelGateReason {
  // Non-premium panels are never gated
  if (!isPremium) return PanelGateReason.NONE;

  // API key, tester key, or Clerk Pro: always unlocked
  if (hasPremiumAccess(authState)) return PanelGateReason.NONE;

  // Web gating based on Clerk auth state
  if (!authState.user) return PanelGateReason.ANONYMOUS;
  return PanelGateReason.FREE_TIER;
}

/**
 * #4771: refine a generic FREE_TIER verdict with the customer's billing
 * state. A paying user whose local renewal evidence went stale (missed or
 * exhausted webhook) must see "we're verifying your renewal" — not an
 * Upgrade CTA that pushes them toward duplicate checkout. Reads the same
 * reactive snapshots the payment-failure banner uses, so panel copy and
 * banner always agree. Non-FREE_TIER reasons pass through untouched:
 * anonymous users have no billing state, and NONE means access works.
 */
export function resolveBillingAwareGateReason(reason: PanelGateReason): PanelGateReason {
  if (reason !== PanelGateReason.FREE_TIER) return reason;
  const state = deriveBillingUxState(getSubscription(), getEntitlementState(), Date.now());
  switch (getBillingGateOverride(state)) {
    case 'payment_on_hold':
      return PanelGateReason.PAYMENT_ON_HOLD;
    case 'renewal_pending':
      return PanelGateReason.RENEWAL_PENDING;
    case 'renewal_failed':
      return PanelGateReason.RENEWAL_FAILED;
    case 'lapsed':
      return PanelGateReason.LAPSED;
    default:
      return reason;
  }
}
