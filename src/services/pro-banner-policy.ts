/**
 * Pure Pro-banner mount policy (issue #5728).
 *
 * Extracted so the init-race / entitlement-hint rules can be unit-tested
 * without DOM, Clerk, or Convex. ProBanner.ts is the only runtime caller.
 *
 * The pre-paint bootstrap in index.html mirrors ENTITLEMENT_HINT_KEY —
 * keep the string literals in lockstep when renaming.
 */

/** localStorage key written when the user last resolved as entitled. */
export const PRO_BANNER_ENTITLEMENT_HINT_KEY = 'wm-entitlement-hint';

/** Value stored under PRO_BANNER_ENTITLEMENT_HINT_KEY for a paying user. */
export const PRO_BANNER_ENTITLEMENT_HINT_VALUE = 'pro';

export type ProBannerDecision = 'mount' | 'suppress' | 'defer';

export interface ProBannerDecisionInput {
  /** `window.self !== window.top` — never pitch inside embeds. */
  inIframe: boolean;
  /** User dismissed the banner this week (or this session). */
  dismissed: boolean;
  /** Live premium signal (API key / tester key / Clerk pro / Convex). */
  hasPremiumAccess: boolean;
  /**
   * Prior-session premium signal from localStorage. Used to skip both the
   * pre-paint reservation and the JS upsell while auth/entitlement rehydrate.
   */
  premiumHint: boolean;
  /** Auth still hydrating (`getAuthState().isPending`). */
  authPending: boolean;
  /**
   * Clerk is configured and will eventually settle `authPending`. When false
   * (no publishable key), pending is sticky and must not block the free banner.
   */
  clerkConfigured: boolean;
  /** True when a Clerk user object is available (`getCurrentClerkUser()`). */
  signedIn: boolean;
  /** True when the first Convex entitlement snapshot has arrived. */
  entitlementLoaded: boolean;
}

/**
 * Decide whether the "Upgrade to Pro" banner may mount.
 *
 * - `suppress` — never show; clear the pre-paint reservation.
 * - `defer` — wait for auth/entitlement; keep reservation only when no premium hint.
 * - `mount` — show the free-tier upsell.
 *
 * Critical race (#5728): during Clerk hydration `getCurrentClerkUser()` is
 * null even for cookie-backed Pro sessions, so a signed-in-only guard is not
 * enough. While auth is pending (and Clerk is configured) OR a signed-in user
 * still has no entitlement snapshot, do not mount the upsell.
 */
export function decideProBannerMount(input: ProBannerDecisionInput): ProBannerDecision {
  if (input.inIframe || input.dismissed) return 'suppress';
  if (input.hasPremiumAccess) return 'suppress';

  const hydrationPending = input.authPending && input.clerkConfigured;
  const entitlementUnknown = input.signedIn && !input.entitlementLoaded;

  if (hydrationPending || entitlementUnknown) {
    // Prefer suppress when a prior session marked this browser as entitled so
    // we neither reserve an empty strip nor flash the upsell.
    return input.premiumHint ? 'suppress' : 'defer';
  }

  // Auth settled, and either signed-out or entitlement loaded as free.
  // Stale premium hints (sign-out, lapse) fall through to mount.
  return 'mount';
}

/** Parse the localStorage entitlement hint used by pre-paint + ProBanner. */
export function isPremiumEntitlementHint(raw: string | null | undefined): boolean {
  return raw === PRO_BANNER_ENTITLEMENT_HINT_VALUE;
}
