/**
 * Checkout session creation for Dodo Payments.
 *
 * Two entry points:
 *   - createCheckout (public action): authenticated via Convex/Clerk auth
 *   - internalCreateCheckout (internal action): called by /relay/create-checkout
 *     with trusted userId from the edge gateway
 *
 * Both share the same core logic via _createCheckoutSession().
 */

import { v, ConvexError } from "convex/values";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { checkout } from "../lib/dodo";
import { requireUserId, resolveUserIdentity } from "../lib/auth";
import { signUserId } from "../lib/identitySigning";

// ---------------------------------------------------------------------------
// Shared checkout session creation logic
// ---------------------------------------------------------------------------

interface CheckoutArgs {
  productId: string;
  returnUrl?: string;
  discountCode?: string;
  referralCode?: string;
}

interface UserInfo {
  userId: string;
  email?: string;
  name?: string;
}

async function _createCheckoutSession(
  ctx: ActionCtx,
  args: CheckoutArgs,
  user: UserInfo,
) {
  // Validate returnUrl to prevent open-redirect attacks.
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
      "https://www.worldmonitor.app",
      "https://app.worldmonitor.app",
      "https://tech.worldmonitor.app",
      "https://finance.worldmonitor.app",
      "https://commodity.worldmonitor.app",
      "https://happy.worldmonitor.app",
      new URL(siteUrl).origin,
    ]);
    if (!allowedOrigins.has(parsedReturnUrl.origin)) {
      throw new ConvexError(
        "Invalid returnUrl: must use a trusted worldmonitor.app origin",
      );
    }
    returnUrl = parsedReturnUrl.toString();
  }

  // Build metadata: HMAC-signed userId for the webhook identity bridge.
  const metadata: Record<string, string> = {};
  metadata.wm_user_id = user.userId;
  metadata.wm_user_id_sig = await signUserId(user.userId);
  if (args.referralCode) {
    metadata.affonso_referral = args.referralCode;
  }

  try {
    const result = await checkout(ctx, {
      payload: {
        product_cart: [{ product_id: args.productId, quantity: 1 }],
        return_url: returnUrl,
        // Note: deliberately not passing `customer` block — Dodo locks
        // those fields as read-only. User identity is tracked via
        // metadata.wm_user_id + HMAC signature instead.
        ...(args.discountCode ? { discount_code: args.discountCode } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        feature_flags: {
          allow_discount_code: true,
        },
        customization: {
          theme: "dark",
        },
      },
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[checkout] createCheckout failed for user=${user.userId} product=${args.productId}: ${msg}`,
    );
    throw new ConvexError(`Checkout failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public action: authenticated via Convex/Clerk auth
// ---------------------------------------------------------------------------

export const createCheckout = action({
  args: {
    productId: v.string(),
    returnUrl: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const identity = await resolveUserIdentity(ctx);

    const customerName = identity
      ? [identity.givenName, identity.familyName].filter(Boolean).join(" ") ||
        identity.name
      : undefined;

    return _createCheckoutSession(ctx, args, {
      userId,
      email: identity?.email,
      name: customerName,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal action: called by /relay/create-checkout with trusted userId
// ---------------------------------------------------------------------------

export const internalCreateCheckout = internalAction({
  args: {
    userId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    productId: v.string(),
    returnUrl: v.optional(v.string()),
    discountCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.userId) {
      throw new ConvexError("userId is required");
    }
    return _createCheckoutSession(
      ctx,
      {
        productId: args.productId,
        returnUrl: args.returnUrl,
        discountCode: args.discountCode,
        referralCode: args.referralCode,
      },
      {
        userId: args.userId,
        email: args.email,
        name: args.name,
      },
    );
  },
});
