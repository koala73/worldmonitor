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
  /** Clerk plan/role evidence bound to the current signed-in user ID. */
  identityBoundPremium: boolean;
  /** Convex entitlement evidence whose snapshot carries no user ID. */
  unscopedAccountPremium: boolean;
  /** Whether the unscoped snapshot has been rebound to the current identity. */
  acceptUnscopedAccountPremium: boolean;
}

export interface BannerPremiumResolution {
  /** Premium for mount/suppress decisions. */
  premium: boolean;
  /** Safe to persist wm-entitlement-hint (account-backed only). */
  accountBacked: boolean;
}

/**
 * How long a previously confirmed account must report non-premium
 * continuously before the banner may treat it as a real downgrade.
 *
 * Entitlement/auth transports can briefly disagree while reconnecting. The
 * banner changes page geometry, so reacting to every contradictory snapshot
 * turns a 500 ms transport flap into a full-page flicker.
 */
export const PRO_BANNER_DOWNGRADE_SETTLE_MS = 2_000;

export interface ProBannerPremiumStabilityState {
  /** Clerk identity the remembered account-backed verdict belongs to. */
  userId: string | null;
  /** True after a live Pro signal or a bounded post-checkout/browser hint. */
  accountPremiumConfirmed: boolean;
  /** First continuous non-premium observation for that confirmed account. */
  freeSince: number | null;
}

export interface StableBannerPremiumInput {
  now: number;
  userId: string | null;
  premiumHint: boolean;
  live: BannerPremiumResolution;
  previous: ProBannerPremiumStabilityState | null;
}

export interface StableBannerPremiumResolution extends BannerPremiumResolution {
  state: ProBannerPremiumStabilityState;
  /** True only while a contradictory non-premium snapshot is settling. */
  heldPremium: boolean;
  /** Caller should re-evaluate at this time if no newer snapshot arrives. */
  recheckAt: number | null;
}

/**
 * Resolve effective premium for the Pro banner.
 *
 * Settled signed-out without local unlock keys → free, even if the entitlement
 * module still holds a previous-account snapshot (sign-out races App's
 * resetEntitlementState against ProBanner's auth listener). Direct account
 * switches may likewise quarantine that unscoped snapshot until App publishes
 * its reset; current-user Clerk plan/role and local unlock evidence remain safe.
 */
export function resolveBannerPremium(
  input: BannerPremiumResolutionInput,
): BannerPremiumResolution {
  if (!input.authPending && !input.signedIn && !input.localUnlockPremium) {
    return { premium: false, accountBacked: false };
  }
  const accountBacked = (
    input.identityBoundPremium ||
    (input.acceptUnscopedAccountPremium && input.unscopedAccountPremium)
  );
  return {
    premium: input.localUnlockPremium || accountBacked,
    accountBacked,
  };
}

/**
 * Debounce only the dangerous Pro → free direction for the banner.
 *
 * A live account-backed Pro verdict is accepted immediately. Once confirmed,
 * non-premium must remain continuous for PRO_BANNER_DOWNGRADE_SETTLE_MS before
 * the upsell may mount. Any intervening Pro snapshot cancels that downgrade.
 * The memory is scoped to a Clerk user and is cleared immediately on sign-out
 * or account change, so one account can never keep another account's upsell
 * hidden. A persisted premium hint seeds the same bounded window when a user
 * first hydrates on a cold/post-checkout load; it is not trusted across a
 * direct account switch or beyond the settle interval.
 */
export function stabilizeProBannerPremium(
  input: StableBannerPremiumInput,
): StableBannerPremiumResolution {
  const identityChanged = input.previous?.userId !== input.userId;
  const maySeedFromHint = input.previous === null || input.previous.userId === null;
  let state: ProBannerPremiumStabilityState = identityChanged
    ? {
        userId: input.userId,
        accountPremiumConfirmed:
          input.userId !== null && maySeedFromHint && input.premiumHint,
        freeSince: null,
      }
    : input.previous ?? {
        userId: input.userId,
        accountPremiumConfirmed: false,
        freeSince: null,
      };

  if (input.userId === null) {
    return {
      ...input.live,
      state: { userId: null, accountPremiumConfirmed: false, freeSince: null },
      heldPremium: false,
      recheckAt: null,
    };
  }

  if (input.live.premium && input.live.accountBacked) {
    state = {
      userId: input.userId,
      accountPremiumConfirmed: true,
      freeSince: null,
    };
    return {
      ...input.live,
      state,
      heldPremium: false,
      recheckAt: null,
    };
  }

  // A desktop/tester key already suppresses the banner. It must not become
  // account evidence, but it also must not advance an account downgrade while
  // the local unlock is active.
  if (input.live.premium) {
    state = { ...state, freeSince: null };
    return {
      ...input.live,
      state,
      heldPremium: false,
      recheckAt: null,
    };
  }

  if (!state.accountPremiumConfirmed) {
    return {
      ...input.live,
      state,
      heldPremium: false,
      recheckAt: null,
    };
  }

  const freeSince = state.freeSince ?? input.now;
  const recheckAt = freeSince + PRO_BANNER_DOWNGRADE_SETTLE_MS;
  if (input.now < recheckAt) {
    state = { ...state, freeSince };
    return {
      premium: true,
      accountBacked: false,
      state,
      heldPremium: true,
      recheckAt,
    };
  }

  state = {
    userId: input.userId,
    accountPremiumConfirmed: false,
    freeSince: null,
  };
  return {
    ...input.live,
    state,
    heldPremium: false,
    recheckAt: null,
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
