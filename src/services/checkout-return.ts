/**
 * Post-checkout redirect detection and URL cleanup.
 *
 * When Dodo redirects the user back to the dashboard after payment,
 * it appends query params like ?subscription_id=sub_xxx&status=active
 * or ?subscription_id=...&status=failed for declined cards.
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

  if (!subscriptionId && !paymentId) {
    return { kind: 'none' };
  }

  // Clean checkout-related params from URL immediately. Do this before
  // returning the discriminant so history replacement is not conditional
  // on the caller — a URL with these params should never survive to a
  // second call of handleCheckoutReturn().
  const paramsToRemove = ['subscription_id', 'payment_id', 'status', 'email', 'license_key'];
  for (const key of paramsToRemove) {
    params.delete(key);
  }
  const cleanUrl = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
  window.history.replaceState({}, '', cleanUrl);

  if (SUCCESS_STATUSES.has(status)) return { kind: 'success' };
  if (FAILED_STATUSES.has(status)) return { kind: 'failed', rawStatus: status };
  // Unknown status (e.g. Dodo introduces a new value) — prefer the
  // failure branch so the user sees an actionable banner rather than
  // silent degradation. Log the unexpected status for investigation.
  if (status) return { kind: 'failed', rawStatus: status };
  return { kind: 'none' };
}
