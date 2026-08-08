import { WEB_APP_ORIGIN } from '@/config/web-origin';

const DASHBOARD_PATH = '/dashboard';

/**
 * Single source of truth for the dashboard checkout-return marker.
 * The parser in `checkout-return.ts` imports these so the producer and
 * consumer can never drift on the param/value (a rename here is a
 * compile-time break there, not a silently-broken 3DS return).
 */
export const CHECKOUT_RETURN_PARAM = 'wm_checkout';
export const CHECKOUT_RETURN_MARKER = 'return';
/** Optional provenance for returns that cross the desktop WebView boundary. */
export const CHECKOUT_SOURCE_PARAM = 'wm_src';
export const DESKTOP_CHECKOUT_SOURCE = 'desktop';

export type CheckoutReturnSource = typeof DESKTOP_CHECKOUT_SOURCE;

export function buildDashboardCheckoutReturnUrl(
  origin: string,
  source?: CheckoutReturnSource,
): string {
  const url = new URL(DASHBOARD_PATH, origin);
  url.searchParams.set(CHECKOUT_RETURN_PARAM, CHECKOUT_RETURN_MARKER);
  if (source) url.searchParams.set(CHECKOUT_SOURCE_PARAM, source);
  return url.toString();
}

/**
 * Origin the payment provider must return the buyer to after a hosted
 * checkout.
 *
 * Web returns to the ACTIVE origin so preview deploys and variant hosts land
 * back on their own dashboard. Desktop cannot: the WebView origin is
 * `tauri://localhost` (or `https://localhost:<port>` under `desktop:dev`),
 * which serves no `/dashboard` route and is not a redirect target Dodo can
 * reach — a buyer who paid would dead-end on a blank page with no evidence
 * the purchase landed.
 *
 * Desktop checkout therefore runs in the OS browser (`external-navigation.ts`)
 * and returns THERE, to the canonical web dashboard, where the existing
 * `wm_checkout=return` reconciliation runs unchanged. Nothing has to redirect
 * back into the app: the desktop client unlocks Pro through the same live
 * Convex entitlement subscription that drives the web client, so the purchase
 * propagates on its own once the webhook lands.
 */
export function resolveCheckoutReturnOrigin(
  windowOrigin: string,
  isDesktop: boolean,
): string {
  return isDesktop ? WEB_APP_ORIGIN : windowOrigin;
}
