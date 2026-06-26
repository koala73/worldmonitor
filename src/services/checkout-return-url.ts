const DASHBOARD_PATH = '/dashboard';

/**
 * Single source of truth for the dashboard checkout-return marker.
 * The parser in `checkout-return.ts` imports these so the producer and
 * consumer can never drift on the param/value (a rename here is a
 * compile-time break there, not a silently-broken 3DS return).
 */
export const CHECKOUT_RETURN_PARAM = 'wm_checkout';
export const CHECKOUT_RETURN_MARKER = 'return';

export function buildDashboardCheckoutReturnUrl(origin: string): string {
  const url = new URL(DASHBOARD_PATH, origin);
  url.searchParams.set(CHECKOUT_RETURN_PARAM, CHECKOUT_RETURN_MARKER);
  return url.toString();
}
