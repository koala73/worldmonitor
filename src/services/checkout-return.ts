/**
 * Post-checkout redirect detection and URL cleanup.
 *
 * When Dodo redirects the user back to the dashboard after payment,
 * it appends query params like ?subscription_id=sub_xxx&status=active.
 * This module detects those params, cleans the URL, and returns
 * whether a successful checkout was detected.
 */

/**
 * Check the current URL for Dodo checkout return params.
 * If found, cleans them from the URL and returns true when payment succeeded.
 * Returns false if no checkout params are present.
 */
export function handleCheckoutReturn(): boolean {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  const subscriptionId = params.get('subscription_id');
  const paymentId = params.get('payment_id');
  const status = params.get('status');

  // No checkout params -- not a return from checkout
  if (!subscriptionId && !paymentId) {
    return false;
  }

  // Clean checkout-related params from URL immediately
  const paramsToRemove = ['subscription_id', 'payment_id', 'status', 'email', 'license_key'];
  for (const key of paramsToRemove) {
    params.delete(key);
  }

  const cleanUrl = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
  window.history.replaceState({}, '', cleanUrl);

  // Return true if payment was successful
  return status === 'active' || status === 'succeeded';
}
