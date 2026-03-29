/**
 * Public Convex action to create Dodo Payments checkout sessions.
 *
 * Wraps the DodoPayments component to securely create checkout URLs
 * server-side, keeping the API key on the backend. Supports discount
 * codes (PROMO-01) and affiliate referral tracking (PROMO-02).
 *
 * Authentication is required — the userId is always resolved from the
 * server-side session. Client-supplied userId is not accepted.
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { checkout } from "../lib/dodo";
import { resolveUserId } from "../lib/auth";

/**
 * Create a Dodo Payments checkout session and return the checkout URL.
 *
 * Called from dashboard upgrade CTAs, pricing page checkout buttons,
 * and E2E tests. The returned checkout_url can be used with the
 * dodopayments-checkout overlay SDK or as a direct redirect target.
 *
 * Requires authentication — throws if no authenticated user is available.
 */
export const createCheckout = action({
  args: {
    productId: v.string(),
    returnUrl: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: require authenticated session — no client-provided userId fallback
    const authedUserId = await resolveUserId(ctx);
    if (!authedUserId) {
      throw new Error("Authentication required to create a checkout session");
    }
    const userId = authedUserId;

    // Build metadata: userId for webhook identity bridge + affiliate tracking (PROMO-02)
    const metadata: Record<string, string> = {};
    metadata.wm_user_id = userId;
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
