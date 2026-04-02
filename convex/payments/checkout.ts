/**
 * Public Convex action to create Dodo Payments checkout sessions.
 *
 * Wraps the DodoPayments component to securely create checkout URLs
 * server-side, keeping the API key on the backend. Supports discount
 * codes (PROMO-01) and affiliate referral tracking (PROMO-02).
 *
 * Checkout is authenticated-only. The webhook identity bridge must be
 * derived from the authenticated Convex/Clerk identity so the server
 * never signs caller-controlled user IDs.
 */

import { v, ConvexError } from "convex/values";
import { action } from "../_generated/server";
import { checkout } from "../lib/dodo";
import { requireUserId } from "../lib/auth";
import { signUserId } from "../lib/identitySigning";

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
    const userId = await requireUserId(ctx);

    // Validate returnUrl to prevent open-redirect attacks.
    // Compare parsed origins exactly instead of using startsWith().
    const siteUrl = process.env.SITE_URL ?? "https://worldmonitor.app";
    let returnUrl = siteUrl;
    if (args.returnUrl) {
      let parsedReturnUrl: URL;
      try {
        parsedReturnUrl = new URL(args.returnUrl);
      } catch {
        throw new ConvexError("Invalid returnUrl: must be a valid absolute URL");
      }

      const allowedOrigins = new Set([
        "https://worldmonitor.app",
        "https://app.worldmonitor.app",
        new URL(siteUrl).origin,
      ]);
      if (!allowedOrigins.has(parsedReturnUrl.origin)) {
        throw new ConvexError("Invalid returnUrl: must use a trusted worldmonitor.app origin");
      }
      returnUrl = parsedReturnUrl.toString();
    }

    // Build metadata: HMAC-signed authenticated userId for the webhook identity bridge.
    const metadata: Record<string, string> = {};
    metadata.wm_user_id = userId;
    metadata.wm_user_id_sig = await signUserId(userId);
    if (args.referralCode) {
      metadata.affonso_referral = args.referralCode;
    }

    const result = await checkout(ctx, {
      payload: {
        product_cart: [{ product_id: args.productId, quantity: 1 }],
        return_url: returnUrl,
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
