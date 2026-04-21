import { trackGateHit } from '@/services/analytics';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';

let bannerEl: HTMLElement | null = null;

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
  if (bannerEl) return;
  if (window.self !== window.top) return;
  if (isDismissed()) return;
  // Don't pitch Pro to users who already have it. hasPremiumAccess() is the
  // authoritative signal — unions API key, tester key, Clerk pro role, AND
  // Convex Dodo entitlement (panel-gating.ts:11-27). A paying user shouldn't
  // see "Upgrade to Pro" at the top of every dashboard refresh.
  //
  // Subscribe to entitlement changes so a user who upgrades mid-session has
  // the banner auto-dismissed on the next snapshot, instead of staring at
  // their old "go pro" prompt while their just-paid plan is already active.
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

// Reactive auto-hide: if a Convex entitlement snapshot arrives that flips
// the user to premium (e.g. Dodo webhook lands while they're sitting on the
// dashboard with the banner visible), drop the banner immediately. The
// dismiss timestamp is intentionally NOT written so the banner reappears
// correctly if they later downgrade or the entitlement lapses.
onEntitlementChange(() => {
  if (bannerEl && hasPremiumAccess()) {
    bannerEl.classList.add('pro-banner-out');
    setTimeout(() => {
      bannerEl?.remove();
      bannerEl = null;
    }, 300);
  }
});
