/**
 * Checkout attempt lifecycle — retry context store.
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

import { clearReferralOnAttribution } from './referral-capture';
import {
  CHECKOUT_ATTEMPT_MAX_AGE_MS as SHARED_CHECKOUT_ATTEMPT_MAX_AGE_MS,
  CHECKOUT_ATTEMPT_STORAGE_KEY,
  parseCheckoutAttemptRecord,
  type CheckoutAttemptRecord,
} from '../../shared/checkout-attribution';

export const LAST_CHECKOUT_ATTEMPT_KEY = CHECKOUT_ATTEMPT_STORAGE_KEY;
export const CHECKOUT_ATTEMPT_MAX_AGE_MS = SHARED_CHECKOUT_ATTEMPT_MAX_AGE_MS;
export type CheckoutAttempt = CheckoutAttemptRecord;

export type CheckoutAttemptClearReason =
  | 'success'
  | 'duplicate'
  | 'signout'
  | 'dismissed';

/**
 * Maximum age of a saved attempt before we treat it as stale and
 * ignore on read. Generous (24h) so a user declined this morning can
 * return this afternoon and retry the exact product they picked.
 * This is the SOLE staleness gate — there is no separate abandonment
 * sweep; records older than this are ignored by `loadCheckoutAttempt`.
 */
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
    return parseCheckoutAttemptRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearCheckoutAttempt(reason: CheckoutAttemptClearReason): void {
  try {
    sessionStorage.removeItem(LAST_CHECKOUT_ATTEMPT_KEY);
  } catch {
    // Ignore storage failures.
  }
  // Referral attribution is retired in TWO terminal cases:
  //   - `success`: the share has been credited — clear so the same
  //     code can't credit a second purchase from this user.
  //   - `signout`: the session is ending (or being rotated to a new
  //     user). Leaving the referral intact would attribute user B's
  //     future purchase to the sharer who sent user A the link —
  //     cross-user referral leak.
  // Other reasons (duplicate, dismissed) leave the ref in place so
  // the user can retry their own purchase without losing attribution.
  if (reason === 'success' || reason === 'signout') {
    clearReferralOnAttribution();
  }
}
