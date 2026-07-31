export const CHECKOUT_RATE_LIMITED = "CHECKOUT_RATE_LIMITED";
export const CHECKOUT_RETRY_AFTER_SECONDS = 10;

export interface CheckoutRateLimitedOutcome {
  checkoutFailed: true;
  code: typeof CHECKOUT_RATE_LIMITED;
  retryAfterSeconds: number;
}

/**
 * Dodo's Convex component throws a plain Error for upstream HTTP failures.
 * Preserve only the observed, unambiguous 429 shape as a typed outcome so the
 * relay can return 429 instead of collapsing it into a retry-amplifying 502.
 */
export function checkoutRateLimitedOutcomeFromError(
  error: unknown,
): CheckoutRateLimitedOutcome | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b429\b.*(?:status code|too many requests|rate limit)/i.test(message)) {
    return null;
  }
  return {
    checkoutFailed: true,
    code: CHECKOUT_RATE_LIMITED,
    retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
  };
}

export function isCheckoutRateLimitedOutcome(
  value: unknown,
): value is CheckoutRateLimitedOutcome {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CheckoutRateLimitedOutcome>;
  return (
    candidate.checkoutFailed === true &&
    candidate.code === CHECKOUT_RATE_LIMITED &&
    candidate.retryAfterSeconds === CHECKOUT_RETRY_AFTER_SECONDS
  );
}
