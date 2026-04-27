/**
 * Post-checkout redirect detection and URL cleanup.
 *
 * Three success signals land on the dashboard after a purchase:
 *
 *   1. Dodo full-page redirect: `?subscription_id=...&status=active`
 *      (historical path; Dodo-owned URL shape)
 *   2. Dodo full-page redirect with failure: `?status=failed|declined|
 *      cancelled` (same URL shape, different status)
 *   3. `/pro` overlay-success bridge: `?wm_checkout=success` — set by
 *      the /pro marketing page when its embedded Dodo overlay
 *      resolves; used when the buyer is redirected from /pro to the
 *      main dashboard and the overlay's manualRedirect means Dodo
 *      itself doesn't write any URL params. The marker is a WorldMonitor-
 *      namespaced param (not `?success=`) to avoid collision with
 *      unrelated query strings and to make the origin intent-explicit.
 *
 * This module inspects those params, cleans them from the URL, and
 * returns a discriminated union so callers can branch on success vs
 * failure vs "not a checkout return at all" without sentinel-boolean
 * ambiguity. The prior boolean return silently swallowed declined
 * payments — a Dodo return with status=failed looked identical to "no
 * checkout here, render normal dashboard."
 */

export type CheckoutReturnResult =
  | { kind: 'none' }
  | { kind: 'success' }
  | { kind: 'failed'; rawStatus: string };

const SUCCESS_STATUSES = new Set(['active', 'succeeded']);
const FAILED_STATUSES = new Set(['failed', 'declined', 'cancelled', 'canceled']);

/** WorldMonitor-namespaced marker written by /pro overlay-success. */
const WM_MARKER_PARAM = 'wm_checkout';
const WM_MARKER_SUCCESS = 'success';

/**
 * Inspect current URL for Dodo return params. If found, cleans them
 * and returns the outcome discriminant. Callers:
 *  - `kind: 'success'` → show success banner, trigger entitlement unlock
 *  - `kind: 'failed'`  → show failure banner with retry CTA
 *  - `kind: 'none'`    → no-op, this is a normal page load
 */
export function handleCheckoutReturn(): CheckoutReturnResult {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  const subscriptionId = params.get('subscription_id');
  const paymentId = params.get('payment_id');
  const status = params.get('status') ?? '';
  const wmMarker = params.get(WM_MARKER_PARAM);

  const hasDodoParams = Boolean(subscriptionId || paymentId);
  const hasAnyWmMarker = wmMarker !== null;
  const hasWmSuccess = wmMarker === WM_MARKER_SUCCESS;

  // Early return when nothing checkout-related is present. Note we
  // enter cleanup below when ANY wm_checkout value is present (even
  // unknown ones) so a garbage marker doesn't linger visible in the
  // URL across refreshes — the value just doesn't trigger success.
  if (!hasDodoParams && !hasAnyWmMarker) {
    return { kind: 'none' };
  }

  // Clean checkout-related params from URL immediately. Do this before
  // returning the discriminant so history replacement is not conditional
  // on the caller — a URL with these params should never survive to a
  // second call of handleCheckoutReturn(). Includes the WM marker so it
  // doesn't re-trigger on refresh.
  const paramsToRemove = [
    'subscription_id',
    'payment_id',
    'status',
    'email',
    'license_key',
    WM_MARKER_PARAM,
  ];
  for (const key of paramsToRemove) {
    params.delete(key);
  }
  const cleanUrl = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
  window.history.replaceState({}, '', cleanUrl);

  // Priority ordering:
  //   1. Dodo status check only runs when Dodo ID params are present.
  //      This prevents ?status=active&wm_checkout=garbage (no
  //      subscription_id) from spoofing a success; the Dodo status
  //      field is only authoritative when paired with Dodo's own IDs.
  //   2. WM marker as success bridge — only the exact `success` value
  //      is honored; any other wm_checkout value is dropped
  //      (defensively stripped above) without triggering success.
  //   3. Unknown Dodo status WITH ID params → failed so the user sees
  //      an actionable banner instead of silent drop.
  //   4. Fallback → none.
  if (hasDodoParams) {
    if (SUCCESS_STATUSES.has(status)) return { kind: 'success' };
    if (FAILED_STATUSES.has(status)) return { kind: 'failed', rawStatus: status };
  }
  if (hasWmSuccess) return { kind: 'success' };
  if (hasDodoParams && status) return { kind: 'failed', rawStatus: status };
  return { kind: 'none' };
}
