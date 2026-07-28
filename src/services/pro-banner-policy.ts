/**
 * Pure Pro-banner mount policy (issue #5728).
 *
 * Extracted so the init-race / entitlement-hint rules can be unit-tested
 * without DOM, Clerk, or Convex. Runtime callers: ProBanner.ts (mount) and
 * checkout success paths (hint write before post-checkout reload).
 *
 * The pre-paint bootstrap in index.html mirrors PRO_BANNER_ENTITLEMENT_HINT_KEY
 * / PRO_BANNER_ENTITLEMENT_HINT_VALUE — keep those string literals in lockstep
 * when renaming (tests/pro-banner-entitlement-race.test.mts asserts parity).
 */

/**
 * localStorage key for the optimistic pre-paint premium signal.
 * UX-only — never an authz source of truth. Spoofing it only hides the upsell.
 */
export const PRO_BANNER_ENTITLEMENT_HINT_KEY = 'wm-entitlement-hint';

/** Value stored under PRO_BANNER_ENTITLEMENT_HINT_KEY for a paying user. */
export const PRO_BANNER_ENTITLEMENT_HINT_VALUE = 'pro';

export type ProBannerDecision = 'mount' | 'suppress' | 'defer';

export interface ProBannerDecisionInput {
  /** `window.self !== window.top` — never pitch inside embeds. */
  inIframe: boolean;
  /** User dismissed the banner this week (or this session). */
  dismissed: boolean;
  /**
   * Effective premium for the banner (callers must already ignore stale
   * entitlement when settled signed-out without local unlock keys).
   */
  hasPremiumAccess: boolean;
  /**
   * Prior-session / post-checkout premium signal from localStorage. Used to
   * skip both the pre-paint reservation and the JS upsell while auth
   * rehydrates. Account-backed only when written by JS (not desktop keys).
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
 * Inputs for "should we treat this session as free for the upsell?" after
 * sign-out, when entitlement state may still describe the previous account.
 */
export interface BannerPremiumResolutionInput {
  authPending: boolean;
  signedIn: boolean;
  /** Desktop API key / browser tester keys — local unlock, not an account. */
  localUnlockPremium: boolean;
  /** hasPremiumAccess() (may include stale Convex entitlement). */
  rawPremium: boolean;
  /** Convex isEntitled() or Clerk plan/role pro. */
  accountBackedPremium: boolean;
}

export interface BannerPremiumResolution {
  /** Premium for mount/suppress decisions. */
  premium: boolean;
  /** Safe to persist wm-entitlement-hint (account-backed only). */
  accountBacked: boolean;
}

/**
 * Resolve effective premium for the Pro banner.
 *
 * Settled signed-out without local unlock keys → free, even if the entitlement
 * module still holds a previous-account snapshot (sign-out races App's
 * resetEntitlementState against ProBanner's auth listener).
 */
export function resolveBannerPremium(
  input: BannerPremiumResolutionInput,
): BannerPremiumResolution {
  if (!input.authPending && !input.signedIn && !input.localUnlockPremium) {
    return { premium: false, accountBacked: false };
  }
  return {
    premium: input.rawPremium,
    accountBacked: input.accountBackedPremium,
  };
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

/**
 * Persist or clear the pre-paint entitlement hint via injectable storage
 * (production: localStorage; tests: Map). Account-backed callers only write
 * `true`; checkout success may write optimistically before the first reload.
 */
export function applyProBannerEntitlementHint(
  storage: { setItem(key: string, value: string): void; removeItem(key: string): void },
  entitled: boolean,
): void {
  if (entitled) {
    storage.setItem(PRO_BANNER_ENTITLEMENT_HINT_KEY, PRO_BANNER_ENTITLEMENT_HINT_VALUE);
  } else {
    storage.removeItem(PRO_BANNER_ENTITLEMENT_HINT_KEY);
  }
}
