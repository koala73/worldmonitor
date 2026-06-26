const DASHBOARD_PATH = '/dashboard';
const CHECKOUT_RETURN_PARAM = 'wm_checkout';
const CHECKOUT_RETURN_MARKER = 'return';

export function buildDashboardCheckoutReturnUrl(origin: string): string {
  const url = new URL(DASHBOARD_PATH, origin);
  url.searchParams.set(CHECKOUT_RETURN_PARAM, CHECKOUT_RETURN_MARKER);
  return url.toString();
}
