import { trackGateHit } from '@/services/analytics';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';

let bannerEl: HTMLElement | null = null;
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

function isDismissed(): boolean {
  localStorage.removeItem(LEGACY_DISMISS_KEY);
  const ts = localStorage.getItem(DISMISS_KEY);
  if (!ts) return false;
  if (Date.now() - Number(ts) > DISMISS_MS) {
    localStorage.removeItem(DISMISS_KEY);
    return false;
  }
  return true;
}

function dismiss(): void {
  if (!bannerEl) return;
  bannerEl.classList.add('pro-banner-out');
  setTimeout(() => {
    bannerEl?.remove();
    bannerEl = null;
  }, 300);
  localStorage.setItem(DISMISS_KEY, String(Date.now()));
}

export function showProBanner(container: HTMLElement): void {
  // Cache container even on early-return paths so the entitlement-change
  // listener can re-mount on a downgrade. App.ts calls this once at init
  // regardless of premium state, so caching here covers both "initially
  // free" and "initially premium then downgrade" trajectories.
  bannerContainer = container;

  if (bannerEl) return;
  if (window.self !== window.top) return;
  if (isDismissed()) return;
  // Don't pitch Pro to users who already have it. hasPremiumAccess() is the
  // authoritative signal — unions API key, tester key, Clerk pro role, AND
  // Convex Dodo entitlement (panel-gating.ts:11-27). A paying user shouldn't
  // see "Upgrade to Pro" at the top of every dashboard refresh.
  if (hasPremiumAccess()) return;

  trackGateHit('pro-banner');

  const banner = document.createElement('div');
  banner.className = 'pro-banner';
  banner.innerHTML = `
    <span class="pro-banner-badge">PRO</span>
    <span class="pro-banner-text">
      <strong>Pro is launched</strong> — More Signal, Less Noise. More AI Briefings. A Geopolitical &amp; Equity Researcher just for you.
    </span>
    <a class="pro-banner-cta" href="/pro#pricing">Upgrade to Pro →</a>
    <button class="pro-banner-close" aria-label="Dismiss">×</button>
  `;

  banner.querySelector('.pro-banner-close')!.addEventListener('click', (e) => {
    e.preventDefault();
    dismiss();
  });

  const header = container.querySelector('.header');
  if (header) {
    header.before(banner);
  } else {
    container.prepend(banner);
  }

  bannerEl = banner;
  requestAnimationFrame(() => banner.classList.add('pro-banner-in'));
}

export function hideProBanner(): void {
  if (!bannerEl) return;
  bannerEl.classList.add('pro-banner-out');
  setTimeout(() => {
    bannerEl?.remove();
    bannerEl = null;
  }, 300);
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
onEntitlementChange(() => {
  const premium = hasPremiumAccess();
  if (premium && bannerEl) {
    bannerEl.classList.add('pro-banner-out');
    setTimeout(() => {
      bannerEl?.remove();
      bannerEl = null;
    }, 300);
    return;
  }
  if (!premium && !bannerEl && bannerContainer) {
    showProBanner(bannerContainer);
  }
});
