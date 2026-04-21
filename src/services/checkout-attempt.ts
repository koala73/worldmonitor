/**
 * Primitive A — checkout attempt lifecycle (retry context store).
 *
 * Separate from `PENDING_CHECKOUT_KEY` in checkout.ts because the two
 * keys have different terminal-clear rules:
 *
 *   PENDING_CHECKOUT_KEY      — "should we auto-open the overlay on
 *                                next mount?" Cleared on overlay close
 *                                to avoid silent auto-retries.
 *
 *   LAST_CHECKOUT_ATTEMPT_KEY — "what product should the failure-retry
 *                                banner re-open?" MUST survive Dodo
 *                                emitting `checkout.closed` before the
 *                                browser navigates to ?status=failed,
 *                                so the retry button has context.
 *
 * Living in its own file so unit tests can exercise the helpers
 * without pulling in `dodopayments-checkout` (which is browser-only
 * and breaks Node test runners on import).
 */

export const LAST_CHECKOUT_ATTEMPT_KEY = 'wm-last-checkout-attempt';

export interface CheckoutAttempt {
  productId: string;
  referralCode?: string;
  discountCode?: string;
  startedAt: number;
  origin: 'dashboard' | 'pro';
}

export type CheckoutAttemptClearReason =
  | 'success'
  | 'duplicate'
  | 'signout'
  | 'dismissed'
  | 'abandoned';

/**
 * Maximum age of a saved attempt before we treat it as stale and
 * ignore on read. Generous (24h) so a user declined this morning can
 * return this afternoon and retry the exact product they picked.
 */
export const CHECKOUT_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Silent-abandon cutoff for the mount-time sweep. Older than this AND
 * no Dodo return params on the current URL → treat as abandoned and
 * clear so a much-later visit doesn't resurface a stale retry banner.
 */
export const CHECKOUT_ATTEMPT_ABANDONED_MS = 30 * 60 * 1000;

export function saveCheckoutAttempt(attempt: CheckoutAttempt): void {
  try {
    sessionStorage.setItem(LAST_CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // Storage disabled (private browsing); retry banner will degrade
    // gracefully to omitting the "Try again" button.
  }
}

export function loadCheckoutAttempt(): CheckoutAttempt | null {
  try {
    const raw = sessionStorage.getItem(LAST_CHECKOUT_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CheckoutAttempt;
    if (!parsed || typeof parsed.productId !== 'string' || typeof parsed.startedAt !== 'number') {
      return null;
    }
    if (Date.now() - parsed.startedAt > CHECKOUT_ATTEMPT_MAX_AGE_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearCheckoutAttempt(_reason: CheckoutAttemptClearReason): void {
  try {
    sessionStorage.removeItem(LAST_CHECKOUT_ATTEMPT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Mount-time defensive cleanup. Caller passes `hasReturnParams` so we
 * never clear an attempt that a freshly-loaded ?status=failed URL is
 * about to consume (the failed-redirect race).
 */
export function sweepAbandonedCheckoutAttempt(hasReturnParams: boolean): void {
  if (hasReturnParams) return;
  try {
    const raw = sessionStorage.getItem(LAST_CHECKOUT_ATTEMPT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as CheckoutAttempt;
    const age = Date.now() - (parsed?.startedAt ?? 0);
    if (age > CHECKOUT_ATTEMPT_ABANDONED_MS) {
      sessionStorage.removeItem(LAST_CHECKOUT_ATTEMPT_KEY);
    }
  } catch {
    // Malformed record — clear defensively.
    try { sessionStorage.removeItem(LAST_CHECKOUT_ATTEMPT_KEY); } catch { /* noop */ }
  }
}
