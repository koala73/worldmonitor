export const DASHBOARD_PATH = '/dashboard';
export const DASHBOARD_URL = 'https://www.worldmonitor.app/dashboard';
export const DASHBOARD_CHECKOUT_SUCCESS_URL = `${DASHBOARD_URL}?wm_checkout=success`;
// Guarded checkout-return contract (mirrors the dashboard's
// buildDashboardCheckoutReturnUrl). Use this as the Dodo `return_url`: unlike
// `?wm_checkout=success`, the `return` marker only reconciles success when
// paired with authoritative Dodo evidence (subscription_id/payment_id + a
// success status) — a failed/cancelled/pending hosted return can no longer
// false-succeed via the bare success marker. See checkout-return.ts.
export const DASHBOARD_CHECKOUT_RETURN_URL = `${DASHBOARD_URL}?wm_checkout=return`;
export const DASHBOARD_EMBED_PREVIEW_URL = `${DASHBOARD_URL}?embed=pro-preview`;
