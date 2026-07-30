import { trackGateHit } from '@/services/analytics';
import { onEntitlementChange, getEntitlementState, isEntitlementActive } from '@/services/entitlements';
import { getSubscription, onSubscriptionChange } from '@/services/billing';
import { deriveBillingUxState, getReactivationHref } from '@/services/billing-state';
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
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


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

function isDismissed(): boolean {
  if (dismissedThisSession) return true;

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

  const decision = decideProBannerMount({
    inIframe: window.self !== window.top,
    dismissed: isDismissed(),
    hasPremiumAccess: premium,
    premiumHint: readPremiumHint(),
    authPending: auth.isPending,
    clerkConfigured: isClerkAuthEnabled(),
    signedIn: getCurrentClerkUser() !== null || auth.user !== null,
    entitlementLoaded: acceptedEntitlementLoaded,
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

  trackGateHit('pro-banner');
  setReservation(true);

  const subscription = getSubscription();
  const billingState = deriveBillingUxState(subscription, getEntitlementState(), Date.now());
  const returning = billingState === 'lapsed';
  const ctaHref = returning ? getReactivationHref(subscription?.planKey) : '/pro#pricing';
  const banner = document.createElement('div');
  banner.className = 'pro-banner';
  banner.dataset.billingState = returning ? 'lapsed' : 'upgrade';
  setTrustedHtml(banner, trustedHtml(`
    <span class="pro-banner-badge">${returning ? t('components.billingState.resubscribe') : t('components.proBanner.badge')}</span>
    <span class="pro-banner-text">
      <strong>${returning ? t('components.billingState.lapsedDesc') : t('components.proBanner.headline')}</strong>${returning ? '' : ` — ${t('components.proBanner.tagline')}`}
    </span>
    <a class="pro-banner-cta" href="${ctaHref}">${returning ? t('components.billingState.resubscribe') : t('components.proBanner.cta')}</a>
    <button class="pro-banner-close" aria-label="${t('components.proBanner.dismiss')}">×</button>
  `, "legacy direct innerHTML migration"));

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
  requestAnimationFrame(() => banner.classList.add('pro-banner-in'));
}

export function hideProBanner(): void {
  if (!bannerEl) {
    setReservation(false);
    return;
  }
  bannerEl.classList.add('pro-banner-out');
  scheduleBannerRemoval();
}

export function isProBannerVisible(): boolean {
  return bannerEl !== null;
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
    const nextState = deriveBillingUxState(getSubscription(), getEntitlementState(), Date.now()) === 'lapsed'
      ? 'lapsed'
      : 'upgrade';
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
onSubscriptionChange(syncProBanner);
// Clerk hydrates after first paint via requestIdleCallback. The init-time
// showProBanner() call often runs while auth is still pending; without this
// subscription the deferred mount would never retry once the session settles.
subscribeAuthState(syncProBanner);
