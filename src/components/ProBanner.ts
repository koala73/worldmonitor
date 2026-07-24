import { trackGateHit } from '@/services/analytics';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange, getEntitlementState } from '@/services/entitlements';
import { getSubscription, onSubscriptionChange } from '@/services/billing';
import { deriveBillingUxState, getReactivationHref } from '@/services/billing-state';
import { getCurrentClerkUser } from '@/services/clerk';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


let bannerEl: HTMLElement | null = null;
let pendingBannerRemoval: ReturnType<typeof setTimeout> | null = null;
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
  if (window.self !== window.top) {
    setReservation(false);
    return;
  }
  if (isDismissed()) {
    setReservation(false);
    return;
  }
  // Don't pitch Pro to users who already have it. hasPremiumAccess() is the
  // authoritative signal — unions API key, tester key, Clerk pro role, AND
  // Convex Dodo entitlement (panel-gating.ts:11-27). A paying user shouldn't
  // see "Upgrade to Pro" at the top of every dashboard refresh.
  if (hasPremiumAccess()) {
    setReservation(false);
    return;
  }
  // Defer the initial mount when entitlement state hasn't loaded yet for a
  // signed-in user. App.ts:923 calls showProBanner() synchronously during
  // init Phase 1, but App.ts:868's `void initEntitlementSubscription()` is
  // non-awaited — the Convex snapshot can take up to ~10s on a cold start.
  // hasPremiumAccess() reads isEntitled() against currentState===null in
  // that window and returns false, which would mount an "Upgrade to Pro"
  // banner for a paying Convex-only user that the onEntitlementChange
  // listener then has to dismiss seconds later. The flash is jarring and
  // misleading; better to render nothing until we know the user's tier.
  //
  // The skip is gated on "signed in", because anonymous users will never
  // have a Convex entitlement and would otherwise wait forever. The
  // listener handles re-mounting once the first snapshot confirms the
  // user is actually free.
  if (getCurrentClerkUser() && getEntitlementState() === null) return;

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

// Reactive sync with entitlement state. App.ts calls showProBanner() ONCE at
// init, so any later free↔pro flip (Dodo webhook lands mid-session, plan
// cancelled, billing grace expires) needs an explicit re-render here —
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
  const premium = hasPremiumAccess();
  if (premium) {
    if (!bannerEl) {
      setReservation(false);
      return;
    }
    bannerEl.classList.add('pro-banner-out');
    scheduleBannerRemoval();
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
