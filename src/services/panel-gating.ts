import type { AuthSession } from './auth-state';
import { getSecretState } from './runtime-config';
import { isProUser } from './widget-store';

export enum PanelGateReason {
  NONE = 'none',           // show content (pro user, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
  FREE_TIER = 'free_tier', // "Upgrade to Pro"
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
