import type { CheckoutAttribution } from './analytics';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { showCheckoutErrorToast } from '@/services/checkout-error-toast';
import { buildAttributedProUrl } from '../../shared/checkout-attribution';

// Reported here, never thrown: the CTAs' catch fallbacks window.open a raw
// /pro, which drops attribution and inside the desktop WebView opens a second
// window. A toast that cannot render must not turn into that either.
function reportPlanOpenFailure(): void {
  try {
    showCheckoutErrorToast('The plans page did not open. Please try again.');
  } catch {
    // Nothing to render into; the CTA stays clickable for a retry.
  }
}

/**
 * The one upgrade path every "Upgrade to Pro" CTA routes through: the /pro
 * pricing section, where the user picks monthly or annual Pro, Pro Business or
 * an API plan, and where the Terms sit above every plan button. It used to
 * start a Pro Monthly checkout directly; started that way from the dashboard,
 * 4% of checkouts were paid, against 21% of those started on /pro
 * (Umami, 30 days to 2026-11-05). The panel gate overlays already went to /pro.
 *
 * Mission attribution and the visitor's captured affiliate referral (`?ref=`)
 * ride on the URL, and /pro carries both into its own checkout. Desktop
 * WebViews hand the URL to the OS browser (#5911), never to a WebView popup,
 * where a checkout started from /pro could not run 3DS.
 */
export async function openUpgradePlans(attribution?: CheckoutAttribution): Promise<void> {
  try {
    const [{ isDesktopRuntime }, { openExternalUrl }, { loadActiveReferral }] = await Promise.all([
      import('@/services/runtime'),
      import('@/services/external-navigation'),
      import('@/services/referral-capture'),
    ]);
    const url = new URL(buildAttributedProUrl(
      `${WEB_APP_ORIGIN}/pro#pricing`,
      attribution,
      isDesktopRuntime() ? { desktopHandoff: true } : undefined,
    ));
    const referral = loadActiveReferral();
    if (referral) url.searchParams.set('ref', referral);
    const outcome = await openExternalUrl(url.toString(), null, { desktopPopupFallback: false });
    // `openExternalUrl` already reported a 'failed' outcome, and after a
    // native timeout the OS browser may still open the page.
    if (outcome === 'failed') reportPlanOpenFailure();
  } catch {
    // A rejected lazy import or a throwing opener: same user-facing result.
    reportPlanOpenFailure();
  }
}
