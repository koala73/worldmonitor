/**
 * Post-checkout redirect detection and URL cleanup.
 *
 * Four checkout signals land on the dashboard after a purchase:
 *
 *   1. Dodo full-page redirect: `?subscription_id=...&status=active`
 *      (historical path; Dodo-owned URL shape)
 *   2. Dodo full-page redirect with failure: `?status=failed|declined|
 *      cancelled` (same URL shape, different status)
 *   3. Overlay-success bridge: `?wm_checkout=success` — historically set
 *      by /pro when its embedded Dodo overlay resolved, because the
 *      overlay's manualRedirect meant Dodo itself wrote no URL params.
 *      The marker is a WorldMonitor-namespaced param (not `?success=`) to
 *      avoid collision with unrelated query strings and to make the origin
 *      intent-explicit. NO PRODUCER REMAINS: #7222 deleted /pro's
 *      `initOverlay` and `DASHBOARD_CHECKOUT_SUCCESS_URL`, and the
 *      dashboard's own `openCheckout` is dormant with zero callers. The
 *      acceptor below is retained only for the dormant dashboard overlay —
 *      retire it together with that machinery, or an attacker-supplied link
 *      stays the only way to reach it. It grants no entitlement (Convex
 *      stays authoritative); the effect is UX/analytics only.
 *   4. Dashboard full-page return bridge: `?wm_checkout=return` — set
 *      as the merchant return URL for Dodo sessions so 3DS returns land
 *      on the dashboard route instead of `/`, which is now the public
 *      welcome page. Web returns require a local checkout attempt; desktop
 *      returns add `wm_src=desktop` because the attempt was written in the
 *      app WebView's separate sessionStorage.
 *
 * This module inspects those params, cleans them from the URL, and
 * returns a discriminated union so callers can branch on success vs
 * failure vs "not a checkout return at all" without sentinel-boolean
 * ambiguity. The prior boolean return silently swallowed declined
 * payments — a Dodo return with status=failed looked identical to "no
 * checkout here, render normal dashboard." A desktop-source success is
 * deliberately account-agnostic: it acknowledges the return but must not
 * seed browser-local entitlement state.
 */

import { loadCheckoutAttempt } from './checkout-attempt';
import {
  CHECKOUT_RETURN_PARAM,
  CHECKOUT_RETURN_MARKER,
  CHECKOUT_SOURCE_PARAM,
  DESKTOP_CHECKOUT_SOURCE,
  type CheckoutReturnSource,
} from './checkout-return-url';
import { applyProBannerEntitlementHint } from './pro-banner-policy';

export type CheckoutReturnResult =
  | { kind: 'none' }
  | { kind: 'success'; source?: CheckoutReturnSource }
  | { kind: 'failed'; rawStatus: string };

/**
 * The routing outcome after page-level checkout signals are resolved — a closed
 * set of the real cases, so impossible combinations (e.g. a desktop success
 * that is also an overlay return) are unrepresentable rather than sitting as a
 * 16-combination boolean product. Consumers derive their booleans from `kind`:
 *   - 'none'    → not a checkout return (or a failed return that must not seed)
 *   - 'overlay' → /pro overlay-success bridge (no URL outcome, stale flag only)
 *   - 'desktop' → desktop-source success; acknowledge but stay account-agnostic
 *   - 'account' → browser account-checkout success; seed activation + reload
 */
export type CheckoutReturnRouting =
  | { kind: 'none' }
  | { kind: 'overlay' }
  | { kind: 'desktop' }
  | { kind: 'account' };

/**
 * Resolve page-level checkout signals after URL parsing and overlay-flag
 * consumption. A URL result wins over a stale overlay flag: a failed Dodo
 * result resolves to 'none' and is never promoted to an overlay return.
 */
export function resolveCheckoutReturnRouting(
  result: CheckoutReturnResult,
  overlayFlag: boolean,
): CheckoutReturnRouting {
  if (result.kind === 'success') {
    return result.source === DESKTOP_CHECKOUT_SOURCE ? { kind: 'desktop' } : { kind: 'account' };
  }
  if (result.kind === 'none' && overlayFlag) {
    return { kind: 'overlay' };
  }
  return { kind: 'none' };
}

const SUCCESS_STATUSES = new Set(['active', 'succeeded']);
const FAILED_STATUSES = new Set(['failed', 'declined', 'cancelled', 'canceled']);

/**
 * Marker param/values share `checkout-return-url.ts` as the single
 * source of truth (`CHECKOUT_RETURN_PARAM` / `CHECKOUT_RETURN_MARKER`).
 * `WM_MARKER_SUCCESS` is the only value owned solely by this consumer —
 * the /pro overlay-success bridge that no producer module writes.
 */
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
  const wmMarker = params.get(CHECKOUT_RETURN_PARAM);
  const wmSource = params.get(CHECKOUT_SOURCE_PARAM);

  const hasDodoParams = Boolean(subscriptionId || paymentId);
  const hasAnyWmMarker = wmMarker !== null;
  const hasWmSuccess = wmMarker === WM_MARKER_SUCCESS;
  const hasWmReturn = wmMarker === CHECKOUT_RETURN_MARKER;
  const isDesktopReturn = hasWmReturn && wmSource === DESKTOP_CHECKOUT_SOURCE;

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
    CHECKOUT_RETURN_PARAM,
    CHECKOUT_SOURCE_PARAM,
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
  //   3. Desktop return marker with its exact source → acknowledgement
  //      success without requiring browser-local attempt state.
  //   4. Unknown Dodo status WITH ID params → failed so the user sees
  //      an actionable banner instead of silent drop.
  //   5. Fallback → none.
  if (hasDodoParams) {
    if (SUCCESS_STATUSES.has(status)) {
      if (!isDesktopReturn) markJustPaidProBannerHint();
      return isDesktopReturn
        ? { kind: 'success', source: DESKTOP_CHECKOUT_SOURCE }
        : { kind: 'success' };
    }
    if (FAILED_STATUSES.has(status)) return { kind: 'failed', rawStatus: status };
  }
  if (hasWmSuccess) {
    markJustPaidProBannerHint();
    return { kind: 'success' };
  }
  if (!hasDodoParams && hasWmReturn && !status) {
    if (isDesktopReturn) {
      return { kind: 'success', source: DESKTOP_CHECKOUT_SOURCE };
    }
    if (loadCheckoutAttempt()) {
      markJustPaidProBannerHint();
      return { kind: 'success' };
    }
  }
  if (hasDodoParams && status) return { kind: 'failed', rawStatus: status };
  return { kind: 'none' };
}

/** Optimistic pre-paint hint for the just-paid session (#5728 empty strip). */
function markJustPaidProBannerHint(): void {
  try {
    applyProBannerEntitlementHint(localStorage, true);
  } catch {
    // Storage optional.
  }
}
