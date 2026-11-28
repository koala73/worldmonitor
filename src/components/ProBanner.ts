import { trackGateHit, trackProBannerClick } from '@/services/analytics';
import {
  onEntitlementChange,
  onEntitlementVerificationChange,
  getEntitlementState,
  getEntitlementVerificationStatus,
  isEntitlementActive,
} from '@/services/entitlements';
import { getSubscription, onSubscriptionChange } from '@/services/billing';
import { deriveBillingUxState, getProBannerVariant, getReactivationHref } from '@/services/billing-state';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { getCurrentClerkUser, isClerkAuthEnabled } from '@/services/clerk';
import { getSecretState } from '@/services/runtime-config';
import { isProWidgetEnabled, isWidgetFeatureEnabled } from '@/services/widget-store';
import {
  applyProBannerEntitlementHint,
  decideProBannerMount,
  isPremiumEntitlementHint,
  resolveBannerPremium,
  stabilizeProBannerPremium,
  PRO_BANNER_ENTITLEMENT_HINT_KEY,
  type ProBannerPremiumStabilityState,
} from '@/services/pro-banner-policy';
import { t, getLocale } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import {
  activePromo,
  formatPromoEnd,
  formatUsdCentsExact,
  promoDisplayPrices,
  type PromoCampaign,
  type PromoDisplayPrices,
} from '../../shared/promo-campaign';


let bannerEl: HTMLElement | null = null;
let pendingBannerRemoval: ReturnType<typeof setTimeout> | null = null;
let premiumStabilityState: ProBannerPremiumStabilityState | null = null;
let premiumStabilityRecheck: ReturnType<typeof setTimeout> | null = null;
let premiumStabilityRecheckAt: number | null = null;
// A direct Clerk A -> B notification can run before App resets A's preserved
// Convex snapshot. Keep that user-unscoped evidence blocked across nested
// sync/show evaluations until resetEntitlementState() publishes null.
let blockedEntitlementUserId: string | null = null;
let dismissedThisSession = false;
// Cached at first showProBanner() call (App.ts always calls it once at init,
// regardless of premium state — the early-returns inside decide whether to
// actually mount). Holding the container reference here lets the entitlement
// listener re-mount the banner on a downgrade without needing App.ts to
// re-call showProBanner. Guarded by the same dismiss / iframe / premium
// checks that the original mount path uses, so the listener can never
// surface a banner the user has already explicitly dismissed.
let bannerContainer: HTMLElement | null = null;

// Versioned dismiss key. The banner copy changed from "Pro is coming / Reserve
// your spot" to "Pro is launched / Upgrade to Pro"; a fresh key guarantees
// anyone who dismissed the pre-launch variant still sees the launch CTA. Also
// clear the legacy key on first read so stale localStorage doesn't linger.
const DISMISS_KEY = 'wm-pro-banner-launched-dismissed';
const LEGACY_DISMISS_KEY = 'wm-pro-banner-dismissed';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_CLASS = 'wm-pro-banner-reserved';

// The promotion banner has its own dismissal, so a user who closed the regular
// banner this week still sees the offer once, and closing the offer does not
// hide the regular banner after it ends. Both values are expiry instants, so
// index.html's pre-paint script can mirror the rule without knowing the dates:
// PROMO_LIVE_UNTIL_KEY says a promotion runs until then, and
// PROMO_DISMISSED_UNTIL_KEY says its banner stays closed until then.
const PROMO_LIVE_UNTIL_KEY = 'wm-pro-banner-promo-until';
const PROMO_DISMISSED_UNTIL_KEY = 'wm-pro-banner-promo-dismissed-until';
// A lapsed subscriber gets the resubscribe strip even while a promotion runs,
// so the regular dismissal decides for them. Pre-paint cannot see billing
// state, so the last mount records it here.
const LAPSED_HINT_KEY = 'wm-pro-banner-lapsed';

/** The promotion the free banner advertises now, or null. */
function bannerPromo(): PromoCampaign | null {
  return activePromo(Date.now());
}

function readStoredInstant(key: string): number {
  const value = Number(safeStorageGet(key) || 0);
  return Number.isFinite(value) ? value : 0;
}

// Storage is optional; without it the offer shows on each load.
function writeStoredInstant(key: string, value: number): void {
  safeStorageSet(key, String(value));
}

// Catalog prices for the promotion copy. Loaded on demand so the product facts
// stay out of the dashboard's main chunk; undefined until settled, null when
// unavailable (the copy then names the yearly discount without figures).
let promoPrices: PromoDisplayPrices | null | undefined;
let promoPricesLoad: Promise<void> | null = null;

function loadPromoPrices(promo: PromoCampaign): Promise<void> {
  promoPricesLoad ??= import('../../shared/product-facts.generated.json')
    .then((module) => {
      const plans = (module.default ?? module).plans as Array<{ planKey: string; price: number | null }>;
      const priceOf = (planKey: string) => plans.find((plan) => plan.planKey === planKey)?.price ?? null;
      promoPrices = promoDisplayPrices(promo, priceOf(promo.planKey), priceOf(promo.monthlyPlanKey));
    })
    .catch(() => {
      promoPrices = null;
    });
  return promoPricesLoad;
}

function promoBannerCopy(promo: PromoCampaign): { headline: string; tagline: string } {
  const date = formatPromoEnd(promo.endsAtMs, getLocale());
  if (promoPrices && promoPrices.savingsVsMonthlyPct !== null && promoPrices.monthlyTotalCents !== null) {
    return {
      headline: t('components.proBanner.promoHeadline', { savings: promoPrices.savingsVsMonthlyPct }),
      // The saving is measured against paying monthly, so the tagline names
      // that monthly price beside the discounted one.
      tagline: t('components.proBanner.promoTagline', {
        perMonth: formatUsdCentsExact(promoPrices.perMonthCents),
        monthly: formatUsdCentsExact(Math.round(promoPrices.monthlyTotalCents / 12)),
        date,
      }),
    };
  }
  return {
    headline: t('components.proBanner.promoHeadlineYearlyOnly', { percent: promo.percentOff }),
    tagline: t('components.proBanner.promoTaglineYearlyOnly', { date }),
  };
}

// Checkout stops applying the code at the end instant, so an open promotion
// banner is swapped for the regular strip then instead of selling an offer
// that no longer exists.
let promoExpiryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_TIMER_MS = 2_147_483_647;

function schedulePromoExpiry(promo: PromoCampaign, banner: HTMLElement): void {
  if (promoExpiryTimer !== null) clearTimeout(promoExpiryTimer);
  const delay = Math.min(Math.max(0, promo.endsAtMs - Date.now()), MAX_TIMER_MS);
  promoExpiryTimer = setTimeout(() => {
    promoExpiryTimer = null;
    if (bannerEl !== banner) return;
    if (Date.now() < promo.endsAtMs) {
      schedulePromoExpiry(promo, banner);
      return;
    }
    cancelPendingBannerRemoval();
    banner.remove();
    bannerEl = null;
    if (bannerContainer && !dismissedThisSession) showProBanner(bannerContainer);
    else setReservation(false);
  }, delay);
}

function setReservation(active: boolean): void {
  document.documentElement.classList.toggle(RESERVATION_CLASS, active);
}

function cancelPendingBannerRemoval(): void {
  if (pendingBannerRemoval === null) return;
  clearTimeout(pendingBannerRemoval);
  pendingBannerRemoval = null;
}

function scheduleBannerRemoval(): void {
  cancelPendingBannerRemoval();
  pendingBannerRemoval = setTimeout(() => {
    bannerEl?.remove();
    bannerEl = null;
    pendingBannerRemoval = null;
    setReservation(false);
  }, 300);
}

/** `lapsed`: the resubscribe strip renders, never the promotion. */
function isDismissed(lapsed: boolean): boolean {
  if (dismissedThisSession) return true;

  const promo = lapsed ? null : bannerPromo();
  if (promo) {
    writeStoredInstant(PROMO_LIVE_UNTIL_KEY, promo.endsAtMs);
    return Date.now() < readStoredInstant(PROMO_DISMISSED_UNTIL_KEY);
  }

  try {
    localStorage.removeItem(LEGACY_DISMISS_KEY);
  } catch {
    // Legacy cleanup must not hide a valid current dismissal record.
  }

  try {
    const ts = localStorage.getItem(DISMISS_KEY);
    if (!ts) return false;
    if (Date.now() - Number(ts) > DISMISS_MS) {
      localStorage.removeItem(DISMISS_KEY);
      return false;
    }
    return true;
  } catch {
    // Storage is optional; without persistence, show the banner this session.
    return false;
  }
}

function dismiss(): void {
  if (!bannerEl) return;
  dismissedThisSession = true;
  bannerEl.classList.add('pro-banner-out');
  scheduleBannerRemoval();
  const promo = bannerPromo();
  if (promo) {
    // While a promotion runs, its key decides dismissal for every variant
    // (isDismissed), so record it: closed for the usual week, never past the
    // offer's end. Closing the offer itself leaves the regular key alone.
    writeStoredInstant(PROMO_DISMISSED_UNTIL_KEY, Math.min(Date.now() + DISMISS_MS, promo.endsAtMs));
    if (bannerEl.dataset.promo) return;
  }
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // The in-memory dismissal still applies for the current page.
  }
}

/**
 * Optimistic pre-paint premium signal shared with index.html.
 * UX-only — never an authz source of truth. Written only for account-backed
 * premium (Convex/Clerk), not desktop API keys or browser tester keys, so a
 * local pro tooling session cannot suppress the free upsell strip for the
 * next web visitor on the same machine.
 */
function readPremiumHint(): boolean {
  try {
    return isPremiumEntitlementHint(localStorage.getItem(PRO_BANNER_ENTITLEMENT_HINT_KEY));
  } catch {
    return false;
  }
}

function writePremiumHint(premium: boolean): void {
  try {
    applyProBannerEntitlementHint(localStorage, premium);
  } catch {
    // Storage is optional; live signals still gate the banner this session.
  }
}

function hasLocalUnlockPremium(): boolean {
  return (
    getSecretState('WORLDMONITOR_API_KEY').present ||
    isProWidgetEnabled() ||
    isWidgetFeatureEnabled()
  );
}

function schedulePremiumStabilityRecheck(recheckAt: number | null): void {
  if (premiumStabilityRecheck !== null && premiumStabilityRecheckAt === recheckAt) {
    return;
  }
  if (premiumStabilityRecheck !== null) {
    clearTimeout(premiumStabilityRecheck);
    premiumStabilityRecheck = null;
  }
  premiumStabilityRecheckAt = recheckAt;
  if (recheckAt === null) return;

  premiumStabilityRecheck = setTimeout(() => {
    premiumStabilityRecheck = null;
    premiumStabilityRecheckAt = null;
    syncProBanner();
  }, Math.max(0, recheckAt - Date.now()));
}

type EffectiveBannerPremium = ReturnType<typeof stabilizeProBannerPremium> & {
  acceptedEntitlementLoaded: boolean;
};

function resolveEffectiveBannerPremium(): EffectiveBannerPremium {
  const auth = getAuthState();
  const clerkUser = getCurrentClerkUser();
  const userId = clerkUser?.id ?? auth.user?.id ?? null;
  const entitlement = getEntitlementState();
  const now = Date.now();
  const identityBoundPremium = (
    (clerkUser?.id === userId && clerkUser.plan === 'pro') ||
    (auth.user?.id === userId && auth.user.role === 'pro')
  );
  const previousUserId = premiumStabilityState?.userId ?? null;
  const directAccountSwitch = (
    previousUserId !== null &&
    userId !== null &&
    previousUserId !== userId
  );
  if (userId === null) {
    blockedEntitlementUserId = null;
  } else if (directAccountSwitch) {
    // If App's listener ran first, the null snapshot already proves the old
    // account was cleared and there is no stale evidence left to quarantine.
    blockedEntitlementUserId = entitlement === null ? null : userId;
  } else if (
    blockedEntitlementUserId === userId &&
    entitlement === null
  ) {
    blockedEntitlementUserId = null;
  }
  const acceptedEntitlementLoaded = (
    entitlement !== null &&
    blockedEntitlementUserId !== userId
  );
  const live = resolveBannerPremium({
    authPending: auth.isPending,
    signedIn: userId !== null,
    localUnlockPremium: hasLocalUnlockPremium(),
    identityBoundPremium,
    unscopedAccountPremium: isEntitlementActive(entitlement, now),
    acceptUnscopedAccountPremium: acceptedEntitlementLoaded,
  });
  const stable = stabilizeProBannerPremium({
    now,
    userId,
    premiumHint: readPremiumHint(),
    live,
    previous: premiumStabilityState,
  });
  premiumStabilityState = stable.state;
  schedulePremiumStabilityRecheck(stable.recheckAt);
  return { ...stable, acceptedEntitlementLoaded };
}

export function showProBanner(container: HTMLElement): void {
  // Cache container even on early-return paths so the entitlement-change
  // listener can re-mount on a downgrade. App.ts calls this once at init
  // regardless of premium state, so caching here covers both "initially
  // free" and "initially premium then downgrade" trajectories.
  bannerContainer = container;
  // Start the promotion's price load while auth settles.
  const runningPromo = bannerPromo();
  if (runningPromo) void loadPromoPrices(runningPromo);

  if (bannerEl && !bannerEl.isConnected) {
    bannerEl = null;
  }
  if (bannerEl) return;

  const auth = getAuthState();
  const {
    premium,
    accountBacked,
    acceptedEntitlementLoaded,
  } = resolveEffectiveBannerPremium();
  // Persist only account-backed premium. Local unlock keys suppress the
  // banner this session via `premium` without poisoning pre-paint for free web.
  if (accountBacked) {
    writePremiumHint(true);
  } else if (!auth.isPending && !premium) {
    // Settled free (incl. sign-out): drop a stale pro hint immediately so
    // the next cold load re-reserves the free strip.
    writePremiumHint(false);
  }

  // Decide which strip would render before reading its dismissal.
  const lapsedNow =
    deriveBillingUxState(getSubscription(), getEntitlementState(), Date.now()) === 'lapsed';
  const decision = decideProBannerMount({
    inIframe: window.self !== window.top,
    dismissed: isDismissed(lapsedNow),
    hasPremiumAccess: premium,
    premiumHint: readPremiumHint(),
    authPending: auth.isPending,
    clerkConfigured: isClerkAuthEnabled(),
    signedIn: getCurrentClerkUser() !== null || auth.user !== null,
    entitlementLoaded: acceptedEntitlementLoaded,
    entitlementUnavailable: getEntitlementVerificationStatus() === 'unavailable',
  });

  if (decision === 'suppress') {
    setReservation(false);
    return;
  }
  if (decision === 'defer') {
    // Keep the pre-paint reservation for free users (CLS). Entitled users
    // without a hint still defer the *copy* but may briefly hold the strip
    // until the first entitlement snapshot — better than flashing "Upgrade".
    // Post-checkout reloads write the hint before navigation (checkout.ts)
    // so the first paid load usually skips reservation entirely.
    return;
  }

  // Definitive free (or settled signed-out): drop any leftover stale hint.
  writePremiumHint(false);

  const subscription = getSubscription();
  const billingState = deriveBillingUxState(subscription, getEntitlementState(), Date.now());
  // A paused subscriber (failed renewal past its access grace) already sees
  // the payment-failed banner, and checkout is blocked while Dodo retries the
  // card, so an Upgrade strip would only lead to a duplicate-subscription 409.
  if (getProBannerVariant(billingState) === null) {
    setReservation(false);
    return;
  }

  const returning = billingState === 'lapsed';
  if (returning) safeStorageSet(LAPSED_HINT_KEY, '1');
  else safeStorageRemove(LAPSED_HINT_KEY);
  // Free users see the running promotion instead of the regular upsell. Its
  // figures come from the lazily loaded catalog; the pre-paint reservation
  // holds the strip while that settles, then this mount path runs again.
  const promo = returning ? null : bannerPromo();
  if (promo && promoPrices === undefined) {
    void loadPromoPrices(promo).then(() => {
      if (!bannerEl && bannerContainer && !dismissedThisSession) showProBanner(bannerContainer);
    });
    return;
  }

  trackGateHit('pro-banner');
  setReservation(true);

  const ctaHref = returning ? getReactivationHref(subscription?.planKey) : '/pro#pricing';
  const banner = document.createElement('div');
  banner.className = 'pro-banner';
  banner.dataset.billingState = returning ? 'lapsed' : 'upgrade';
  if (promo) {
    banner.dataset.promo = promo.id;
    const copy = promoBannerCopy(promo);
    setTrustedHtml(banner, trustedHtml(`
    <span class="pro-banner-badge">${t('components.proBanner.promoBadge')}</span>
    <span class="pro-banner-text">
      <strong>${copy.headline}</strong><span class="pro-banner-tagline"> — ${copy.tagline}</span>
    </span>
    <a class="pro-banner-cta" href="${ctaHref}">${t('components.proBanner.promoCta')}</a>
    <button class="pro-banner-close" aria-label="${t('components.proBanner.dismiss')}">×</button>
  `, "promotion banner from fixed catalog figures and locale strings"));
  } else {
    setTrustedHtml(banner, trustedHtml(`
    <span class="pro-banner-badge">${returning ? t('components.billingState.resubscribe') : t('components.proBanner.badge')}</span>
    <span class="pro-banner-text">
      <strong>${returning ? t('components.billingState.lapsedDesc') : t('components.proBanner.headline')}</strong>${returning ? '' : `<span class="pro-banner-tagline"> — ${t('components.proBanner.tagline')}</span>`}
    </span>
    <a class="pro-banner-cta" href="${ctaHref}">${returning ? t('components.billingState.resubscribe') : t('components.proBanner.cta')}</a>
    <button class="pro-banner-close" aria-label="${t('components.proBanner.dismiss')}">×</button>
  `, "legacy direct innerHTML migration"));
  }

  // Tracked in-app rather than via data-umami-event: the Umami tracker holds a
  // tagged link's navigation until its send settles, and misses clicks made
  // before it loads.
  banner.querySelector('.pro-banner-cta')!.addEventListener('click', () => {
    trackProBannerClick(returning ? 'lapsed' : promo ? 'promo' : 'upgrade');
  });

  banner.querySelector('.pro-banner-close')!.addEventListener('click', (e) => {
    e.preventDefault();
    dismiss();
  });

  const slot = container.querySelector<HTMLElement>('#proBannerSlot');
  const header = container.querySelector('.header');
  if (slot) {
    slot.replaceChildren(banner);
  } else if (header) {
    header.before(banner);
  } else {
    container.prepend(banner);
  }

  bannerEl = banner;
  if (promo) schedulePromoExpiry(promo, banner);
  requestAnimationFrame(() => banner.classList.add('pro-banner-in'));
}

// Reactive sync with entitlement / subscription / auth state. App.ts calls
// showProBanner() ONCE at init, so any later free↔pro flip (Dodo webhook lands
// mid-session, plan cancelled, billing grace expires) OR Clerk hydration after
// the deferred-load window (#5728) needs an explicit re-render here —
// otherwise the banner stays at whatever state the init call computed for
// the rest of the SPA session.
//
// Both directions handled symmetrically:
//
//   - Premium snapshot arrives + banner currently visible
//     → fade out. Dismiss timestamp intentionally NOT written, so a later
//       downgrade can re-show it.
//
//   - Non-premium snapshot arrives + banner not visible + cached container +
//     not user-dismissed + not in iframe
//     → re-mount via showProBanner. Same gate set as the initial mount path,
//       so we can never surface a banner the user has already ✕'d this week.
function syncProBanner(): void {
  const {
    premium,
    accountBacked,
    acceptedEntitlementLoaded,
  } = resolveEffectiveBannerPremium();
  if (premium) {
    if (accountBacked) writePremiumHint(true);
    if (!bannerEl) {
      setReservation(false);
      return;
    }
    bannerEl.classList.add('pro-banner-out');
    scheduleBannerRemoval();
    return;
  }
  const auth = getAuthState();
  const signedIn = getCurrentClerkUser() !== null || auth.user !== null;
  // Settled free / account handoff: clear a stale Pro hint even when the
  // banner was never mounted. A direct switch must not let A's hint suppress
  // B's eventual free banner.
  if (!auth.isPending) {
    writePremiumHint(false);
  }
  if (signedIn && !acceptedEntitlementLoaded) {
    // An already-mounted free banner belongs to the previous account. During
    // a direct identity handoff, remove it until the current account's first
    // accepted Convex snapshot arrives; otherwise a Pro B briefly inherits
    // A's "Upgrade" UI even though new mounts correctly defer.
    if (bannerEl) {
      cancelPendingBannerRemoval();
      bannerEl.remove();
      bannerEl = null;
      setReservation(false);
    }
    // No snapshot will settle this account, so the reserved strip would stay empty.
    if (getEntitlementVerificationStatus() === 'unavailable') setReservation(false);
    return;
  }
  // A premium snapshot may have started the fade-out immediately before a
  // non-premium snapshot arrived. Keep the banner visible for the restored
  // state instead of letting that stale removal callback delete it.
  // An explicit dismissal owns its removal timer and must not be reversed by
  // an unrelated subscription snapshot arriving during the 300 ms fade.
  if (dismissedThisSession) return;
  cancelPendingBannerRemoval();
  bannerEl?.classList.remove('pro-banner-out');
  if (bannerEl && bannerContainer) {
    const nextState = getProBannerVariant(deriveBillingUxState(getSubscription(), getEntitlementState(), Date.now()));
    if (bannerEl.dataset.billingState !== nextState) {
      bannerEl.remove();
      bannerEl = null;
      setReservation(false);
    }
  }
  if (!bannerEl && bannerContainer) {
    showProBanner(bannerContainer);
  }
}

onEntitlementChange(syncProBanner);
onEntitlementVerificationChange(syncProBanner);
onSubscriptionChange(syncProBanner);
// Clerk hydrates after first paint via requestIdleCallback. The init-time
// showProBanner() call often runs while auth is still pending; without this
// subscription the deferred mount would never retry once the session settles.
subscribeAuthState(syncProBanner);
