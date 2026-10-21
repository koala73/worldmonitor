/**
 * Dodo checkout-session creation via the direct REST SDK ("dodopayments").
 *
 * HISTORY (#6027): session creation previously went through the
 * @dodopayments/convex component (still mounted in convex.config.ts). That
 * path was retired for checkout because the component constructs its REST
 * client with the SDK's DEFAULT retry policy — maxRetries=2, 429s retried,
 * Retry-After honored VERBATIM with no cap (dodopayments client.js) — which:
 *   (a) composed with our action-level retry ladder in
 *       payments/checkoutRateLimit.ts into up to 9 raw provider requests per
 *       checkout during a shared-key rate limit,
 *   (b) made an in-flight attempt unboundable (an internal Retry-After sleep
 *       can be minutes — the same hazard billing.ts pins maxRetries: 0 for),
 *   (c) reported every provider 429 as an uncaught component-action error in
 *       Sentry (WORLDMONITOR-WP) even when the caller handled it gracefully.
 * The direct client pins maxRetries: 0 and a per-attempt timeout so the
 * bounded ladder in payments/checkoutRateLimit.ts owns ALL retry policy.
 *
 * DUAL SDK NOTE: billing.ts builds its own direct REST client for customer
 * portal / subscription calls; webhook signature verification lives in
 * payments/webhookHandlers.ts against @dodopayments/core. This module is only
 * the checkout-session seam (checkout.ts mocks it in tests via vi.mock).
 *
 * Config is read lazily (on first use) so missing env vars fail at the action
 * boundary with a clear error instead of at import time.
 * Canonical env var: DODO_API_KEY (set in Convex dashboard).
 */

import { DodoPayments } from "dodopayments";

/**
 * Per-attempt cap on one provider round-trip. The retry ladder makes up to
 * CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS attempts inside an 8s wall-clock budget
 * (see payments/checkoutRateLimit.ts), so each attempt must be individually
 * bounded or a hung/slow provider call would blow through the budget the
 * deadline check can only enforce BETWEEN attempts.
 */
export const CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS = 3_500;

export type CheckoutSessionPayload = Parameters<
  DodoPayments["checkoutSessions"]["create"]
>[0];

export interface CheckoutSessionResult {
  checkout_url: string;
}

/**
 * Client options for the checkout-session client, exported as a pure function
 * so tests can assert the retry contract without network access. maxRetries: 0
 * is load-bearing — see the module header; deleting it reintroduces nested
 * provider retries under the action ladder.
 */
export function buildCheckoutClientOptions(env: {
  DODO_API_KEY?: string;
  DODO_PAYMENTS_ENVIRONMENT?: string;
}): ConstructorParameters<typeof DodoPayments>[0] {
  if (!env.DODO_API_KEY) {
    throw new Error(
      "[dodo] DODO_API_KEY is not set. " +
        "Set it in the Convex dashboard environment variables.",
    );
  }
  const isLive = env.DODO_PAYMENTS_ENVIRONMENT === "live_mode";
  return {
    bearerToken: env.DODO_API_KEY,
    ...(isLive ? {} : { environment: "test_mode" as const }),
    maxRetries: 0,
    timeout: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
  };
}

/**
 * Create one checkout session — exactly one HTTP request (no SDK-internal
 * retries). Throws the SDK's typed APIError on failure (status 429 for rate
 * limits, classified by payments/checkoutRateLimit.ts).
 */
export async function createDodoCheckoutSession(
  payload: CheckoutSessionPayload,
): Promise<CheckoutSessionResult> {
  const client = new DodoPayments(buildCheckoutClientOptions(process.env));
  const session = await client.checkoutSessions.create(payload);
  if (!session.checkout_url) {
    // Session created but no redirect URL — surface as a hard (non-429)
    // failure on the existing error channel rather than returning a dead link.
    throw new Error(
      `Dodo checkout session ${session.session_id} has no checkout_url`,
    );
  }
  return { checkout_url: session.checkout_url };
}
