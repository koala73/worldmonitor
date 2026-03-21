/**
 * Shared DodoPayments configuration.
 *
 * Centralizes the DodoPayments component instance and API exports
 * so that all Convex modules (checkout, billing, etc.) share the
 * same config and API key handling.
 */

import { DodoPayments } from "@dodopayments/convex";
import { components } from "../_generated/api";

const apiKey = process.env.DODO_API_KEY ?? process.env.DODO_PAYMENTS_API_KEY;
if (!apiKey) {
  console.warn("[dodo] DODO_API_KEY not set — Dodo operations will fail");
}

export const dodo = new DodoPayments(components.dodopayments, {
  identify: async () => null, // Stub until real auth integration
  apiKey: apiKey ?? "",
  environment: (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode") as
    | "test_mode"
    | "live_mode",
});

export const { checkout, customerPortal } = dodo.api();
