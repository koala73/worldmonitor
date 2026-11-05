import type { CheckoutAttribution } from './analytics';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { buildAttributedProUrl } from '../../shared/checkout-attribution';

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
  // `openExternalUrl` already reported the failure. Tell the user instead of
  // throwing: callers' catch fallbacks use window.open, which inside the
  // desktop WebView opens a second window, and after a native timeout the OS
  // browser may still open the page.
  if (outcome === 'failed') {
    const { showCheckoutErrorToast } = await import('@/services/checkout-error-toast');
    showCheckoutErrorToast('The plans page did not open. Please try again.');
  }
}
