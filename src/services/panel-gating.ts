/**
 * Premium access, panel gate reasons, and CTA routing.
 *
 * Per-gate logic does NOT live here (#5813). Each gate owns a pure resolver
 * leaf plus a reader beside it under `gates/` — `gates/export.ts` (data export
 * + dashboard tab cap) and `gates/playback.ts` (historical playback). A fourth
 * gate gets its own pair there, not another `readX`/`evaluateX` in this file.
 *
 * What stays here is what every gate shares: the access predicate
 * (`hasPremiumAccess`), the reason enum and its billing-aware refinement, and
 * the CTA action resolver. Gate modules import from this file; it imports from
 * none of them, so the dependency runs one way.
 */

import type { AuthSession } from './auth-state';
import { getSubscription, openBillingPortal, prereserveBillingPortalTab } from './billing';
import { deriveBillingUxState, getBillingGateOverride, getReactivationHref } from './billing-state';
import { getEntitlementState } from './entitlements';
import type { ClientEntitlementBelief } from './premium-denial';
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
 * Snapshot what the CLIENT believes about this account's plan, for
 * `classifyPremiumDenial` (#5608). Deliberately narrower than
 * hasPremiumAccess: the desktop API key and the browser tester keys unlock
 * panels locally but assert nothing about the signed-in Clerk account, so
 * they must not suppress a legitimate upgrade CTA.
 */
export function readClientEntitlementBelief(authState: AuthSession): ClientEntitlementBelief {
  return {
    entitlementTier: getEntitlementState()?.features.tier ?? null,
    authRole: authState.user?.role ?? null,
  };
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

/**
 * Every locked surface routes its CTA through here. Extracted from
 * `PanelLayoutManager.getGateAction` (which was private and closed over
 * `ctx.authModal`) so the export gate, the panel gate and future gates cannot
 * drift — the auth-modal opener is injected instead.
 */
export interface GateActionDeps {
  /** Opens the sign-in modal for the ANONYMOUS reason. */
  openAuthModal: () => void;
  /**
   * Plan key used to preselect the pricing page's billing period on the LAPSED
   * reason. Defaults to the live subscription row.
   */
  planKey?: string | null;
}

// Absolute origin: the desktop runtime's webview has no worldmonitor.app
// origin, so a relative href would resolve against tauri://localhost.
const PRO_PAGE_ORIGIN = 'https://worldmonitor.app';

function openProPage(path: string): void {
  window.open(`${PRO_PAGE_ORIGIN}${path}`, '_blank', 'noopener,noreferrer');
}

/** Return the action callback for a given gate reason. */
export function resolveGateAction(reason: PanelGateReason, deps: GateActionDeps): () => void {
  switch (reason) {
    case PanelGateReason.ANONYMOUS:
      return () => deps.openAuthModal();
    case PanelGateReason.FREE_TIER:
      return () => openProPage('/pro');
    case PanelGateReason.PAYMENT_ON_HOLD:
    case PanelGateReason.RENEWAL_FAILED:
      // Pre-reserve the portal tab synchronously inside the click gesture
      // so the async portal-session fetch survives the popup blocker
      // (same pattern as payment-failure-banner.ts).
      return () => {
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin);
      };
    case PanelGateReason.RENEWAL_PENDING:
      // Verification resolves server-side; a reload re-pulls entitlements
      // for users who don't want to wait for the reactive update.
      return () => window.location.reload();
    case PanelGateReason.LAPSED:
      // A returning subscriber lands on the pricing anchor with their previous
      // billing period preselected — the bare /pro redirect this replaced
      // dropped both signals.
      return () => openProPage(getReactivationHref(deps.planKey ?? getSubscription()?.planKey));
    default:
      return () => {};
  }
}
