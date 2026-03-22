/**
 * Shared DodoPayments configuration.
 *
 * Centralizes the DodoPayments component instance and API exports
 * so that all Convex modules (checkout, billing, etc.) share the
 * same config and API key handling.
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

/** Shorthand for customer portal API. */
export function customerPortal(...args: Parameters<ReturnType<DodoPayments['api']>['customerPortal']>) {
  return getDodoApi().customerPortal(...args);
}
