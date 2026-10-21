export const DEFAULT_CHECKOUT_RETRY_AFTER_SECONDS = 10;
export const MAX_CHECKOUT_RETRY_AFTER_SECONDS = 9_999;

/**
 * Mirrors the edge gateway's closed Retry-After contract: a numeric 1-4 digit
 * delay, with the same safe fallback when an intermediary strips or mangles
 * the header.
 */
export function parseCheckoutRetryAfterSeconds(
  value: string | null | undefined,
): number {
  if (!value || !/^\d{1,4}$/.test(value)) {
    return DEFAULT_CHECKOUT_RETRY_AFTER_SECONDS;
  }
  return Math.min(Number(value), MAX_CHECKOUT_RETRY_AFTER_SECONDS);
}

export function checkoutRetryAtMs(
  nowMs: number,
  retryAfterSeconds: number,
): number {
  return nowMs + retryAfterSeconds * 1_000;
}

export function checkoutRetryRemainingSeconds(
  nowMs: number,
  retryAtMs: number,
): number {
  return Math.max(0, Math.ceil((retryAtMs - nowMs) / 1_000));
}
