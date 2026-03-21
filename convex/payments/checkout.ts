/**
 * Public Convex action to create Dodo Payments checkout sessions.
 *
 * Wraps the DodoPayments component to securely create checkout URLs
 * server-side, keeping the API key on the backend. Supports discount
 * codes (PROMO-01) and affiliate referral tracking (PROMO-02).
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { DodoPayments } from "@dodopayments/convex";
import { components } from "../_generated/api";

const apiKey = process.env.DODO_PAYMENTS_API_KEY;
if (!apiKey) {
  console.warn("[checkout] DODO_PAYMENTS_API_KEY not set — checkout will fail");
}

const dodo = new DodoPayments(components.dodopayments, {
  identify: async () => null, // Stub until Phase 18 auth
  apiKey: apiKey ?? "",
  environment: (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode") as
    | "test_mode"
    | "live_mode",
});

const { checkout } = dodo.api();

/**
 * Create a Dodo Payments checkout session and return the checkout URL.
 *
 * Called from dashboard upgrade CTAs, pricing page checkout buttons,
 * and E2E tests. The returned checkout_url can be used with the
 * dodopayments-checkout overlay SDK or as a direct redirect target.
 */
export const createCheckout = action({
  args: {
    productId: v.string(),
    returnUrl: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Build metadata for affiliate tracking (PROMO-02)
    const metadata: Record<string, string> = {};
    if (args.referralCode) {
      metadata.affonso_referral = args.referralCode;
    }

    const result = await checkout(ctx, {
      payload: {
        product_cart: [{ product_id: args.productId, quantity: 1 }],
        return_url:
          args.returnUrl ??
          `${process.env.SITE_URL ?? "https://worldmonitor.app"}`,
        ...(args.discountCode ? { discount_code: args.discountCode } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        feature_flags: {
          allow_discount_code: true, // PROMO-01: Always show discount input
        },
        customization: {
          theme: "dark",
        },
      },
    });

    return result;
  },
});
