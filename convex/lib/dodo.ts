/**
 * Shared DodoPayments Convex component SDK configuration.
 *
 * This file initializes the @dodopayments/convex component SDK, which handles
 * the checkout overlay lifecycle and webhook signature verification via the
 * Convex component system. It is the SDK used by checkout.ts and the HTTP
 * webhook action.
 *
 * DUAL SDK NOTE: billing.ts uses the direct dodopayments REST SDK
 * (npm: "dodopayments") for customer portal and plan-change API calls.
 * These are two separate packages with different responsibilities:
 *   - @dodopayments/convex (this file): checkout + webhook component
 *   - dodopayments (billing.ts): REST API for subscriptions/customers
 *
 * Config is read lazily (on first use) rather than at module scope,
 * so missing env vars fail at the action boundary with a clear error
 * instead of silently capturing empty values at import time.
 *
 * Canonical env var: DODO_API_KEY (set in Convex dashboard).
 */

import { DodoPayments } from "@dodopayments/convex";
import { components } from "../_generated/api";

let _instance: DodoPayments | null = null;

function getDodoInstance(): DodoPayments {
  if (_instance) return _instance;

  const apiKey = process.env.DODO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[dodo] DODO_API_KEY is not set. " +
        "Set it in the Convex dashboard environment variables.",
    );
  }

  _instance = new DodoPayments(components.dodopayments, {
    identify: async () => null, // Stub until real auth integration
    apiKey,
    environment: (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode") as
      | "test_mode"
      | "live_mode",
  });

  return _instance;
}

/**
 * Lazily-initialized Dodo API accessors.
 * Throws immediately if DODO_API_KEY is missing, so callers get a clear
 * error at the action boundary rather than a cryptic SDK failure later.
 */
export function getDodoApi() {
  return getDodoInstance().api();
}

/** Shorthand for checkout API. */
export function checkout(...args: Parameters<ReturnType<DodoPayments['api']>['checkout']>) {
  return getDodoApi().checkout(...args);
}
