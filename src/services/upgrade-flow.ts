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
 * Mission attribution rides on the URL, and /pro carries it into its own
 * checkout. Desktop WebViews hand the URL to the OS browser (#5911).
 */
export async function openUpgradePlans(attribution?: CheckoutAttribution): Promise<void> {
  const [{ isDesktopRuntime }, { openExternalUrl }] = await Promise.all([
    import('@/services/runtime'),
    import('@/services/external-navigation'),
  ]);
  const outcome = await openExternalUrl(buildAttributedProUrl(
    `${WEB_APP_ORIGIN}/pro#pricing`,
    attribution,
    isDesktopRuntime() ? { desktopHandoff: true } : undefined,
  ));
  // `openExternalUrl` already reported the failure. Tell the user instead of
  // throwing: callers' catch fallbacks use window.open, which inside the
  // desktop WebView opens a second window, and after a native timeout the OS
  // browser may still open the page.
  if (outcome === 'failed') {
    const { showCheckoutErrorToast } = await import('@/services/checkout-error-toast');
    showCheckoutErrorToast('The plans page did not open. Please try again.');
  }
}
