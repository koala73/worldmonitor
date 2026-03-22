/**
 * Shared DodoPayments configuration.
 *
 * Centralizes the DodoPayments component instance and API exports
 * so that all Convex modules (checkout, billing, etc.) share the
 * same config and API key handling.
 *
 * Canonical env var: DODO_API_KEY (set in Convex dashboard).
 */

import { DodoPayments } from "@dodopayments/convex";
import { components } from "../_generated/api";

const apiKey = process.env.DODO_API_KEY;
if (!apiKey) {
  console.error(
    "[dodo] DODO_API_KEY is not set — all Dodo operations will fail. " +
      "Set it in the Convex dashboard environment variables.",
  );
}

export const dodo = new DodoPayments(components.dodopayments, {
  identify: async () => null, // Stub until real auth integration
  apiKey: apiKey ?? "",
  environment: (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode") as
    | "test_mode"
    | "live_mode",
});

export const { checkout, customerPortal } = dodo.api();
