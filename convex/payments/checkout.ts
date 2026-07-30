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
import { internal } from "../_generated/api";
import { checkout } from "../lib/dodo";
import { requireUserId, resolveUserIdentity } from "../lib/auth";
import { ANON_ID_V4_REGEX, signAnonClaimToken, signUserId } from "../lib/identitySigning";
import { resolveProductToPlan } from "../config/productCatalog";

const ACTIVE_SUBSCRIPTION_EXISTS = "ACTIVE_SUBSCRIPTION_EXISTS";
const PAYMENT_IN_PROGRESS = "PAYMENT_IN_PROGRESS";

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

interface BlockingSubscriptionInfo {
  planKey: string;
  displayName: string;
  status: "active" | "on_hold" | "cancelled";
  currentPeriodEnd: number;
  dodoSubscriptionId: string;
}

function buildBlockedCheckoutPayload(
  subscription: BlockingSubscriptionInfo,
){
  return {
    code: ACTIVE_SUBSCRIPTION_EXISTS,
    message: `A ${subscription.displayName} subscription already exists for this account. Use Manage Billing to update it instead of purchasing again.`,
    subscription: {
      planKey: subscription.planKey,
      displayName: subscription.displayName,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      dodoSubscriptionId: subscription.dodoSubscriptionId,
    },
  };
}

function buildBlockedCheckoutResponse(
  subscription: BlockingSubscriptionInfo,
){
  return {
    blocked: true,
    ...buildBlockedCheckoutPayload(subscription),
  };
}

async function getCheckoutBlockingSubscription(
  ctx: ActionCtx,
  userId: string,
  productId: string,
): Promise<BlockingSubscriptionInfo | null> {
  const result = await ctx.runQuery(
    internal.payments.billing.getCheckoutBlockingSubscription,
    { userId, productId },
  );
  if (!result || result.status === "expired") {
    return null;
  }
  return {
    planKey: result.planKey,
    displayName: result.displayName,
    status: result.status,
    currentPeriodEnd: result.currentPeriodEnd,
    dodoSubscriptionId: result.dodoSubscriptionId,
  };
}

// ---------------------------------------------------------------------------
// Pending-payment guard (#4438) — blocks a duplicate checkout when a recent
// pending 3DS payment exists in the same tier group. Distinct from the
// subscription guard above; runs AFTER it (the subscription block wins) and is
// skippable via `bypassPendingGuard` so the block stays confirmation friction,
// not a hard lock.
// ---------------------------------------------------------------------------

interface BlockingPendingPaymentInfo {
  planKey: string;
  displayName: string;
  occurredAt: number;
}

function buildPendingBlockedPayload(pending: BlockingPendingPaymentInfo) {
  return {
    code: PAYMENT_IN_PROGRESS,
    message:
      `A ${pending.displayName} payment is already in progress for this account. ` +
      `It may still be completing — finish it, or start a new checkout.`,
    pendingPayment: {
      planKey: pending.planKey,
      displayName: pending.displayName,
      occurredAt: pending.occurredAt,
    },
  };
}

function buildPendingBlockedResponse(pending: BlockingPendingPaymentInfo) {
  return {
    blocked: true,
    ...buildPendingBlockedPayload(pending),
  };
}

async function getCheckoutBlockingPendingPayment(
  ctx: ActionCtx,
  userId: string,
  productId: string,
): Promise<BlockingPendingPaymentInfo | null> {
  // Fail OPEN on any infrastructure error (DB error, OCC, timeout). The guard's
  // documented contract (billing.ts) is that a false block — locking a paying
  // user out — is worse than a missed dedup; that intent must hold for infra
  // throws too, not just the business-logic (unresolvable planKey) path. Without
  // this, a transient query error would propagate → relay 500 → edge 502 and the
  // customer could not check out at all (#4438 review).
  try {
    return await ctx.runQuery(
      internal.payments.billing.getBlockingPendingPayment,
      { userId, productId },
    );
  } catch (err) {
    // sentry-coverage-ok: structured console.error is forwarded by Convex
    // auto-Sentry, so on-call still sees guard-query failures. We deliberately
    // do NOT re-throw — failing open (return null) is the whole point (#4438):
    // a transient DB/OCC/timeout error must not block a paying customer's checkout.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[checkout] pending-payment guard query failed (failing open): ${msg}`);
    return null;
  }
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
      "https://energy.worldmonitor.app",
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
  const anonymousClaimToken = ANON_ID_V4_REGEX.test(user.userId)
    ? await signAnonClaimToken(user.userId)
    : null;
  if (anonymousClaimToken) {
    metadata.wm_anon_claim = "v2";
  }
  // Tier-group bridge for the duplicate-payment guard (#4438): the pending
  // `payment.processing` webhook echoes `data.metadata.wm_plan_key` and persists
  // it on the `paymentEvents` row, so a later checkout can resolve a pending
  // payment to its PRODUCT_CATALOG tierGroup. `resolveProductToPlan` maps the
  // Dodo product id → planKey (null for unknown products, which we simply skip).
  const planKey = resolveProductToPlan(args.productId);
  if (planKey) {
    metadata.wm_plan_key = planKey;
  }
  if (args.referralCode) {
    // `affonso_referral` is the Dodo ↔ Affonso vendor-contracted metadata
    // key — Dodo forwards values on this exact key to Affonso's referral-
    // tracking webhook. DO NOT RENAME (to `wm_referral`, `referral`,
    // `ref`, or anything else) without coordinating with Dodo + Affonso;
    // a rename silently breaks sharer attribution because Affonso stops
    // receiving the signal and `userReferralCredits` rows are never
    // created on this conversion path. Mirror read in
    // `convex/payments/subscriptionHelpers.ts`.
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
    return anonymousClaimToken
      ? { ...result, anonymous_claim_token: anonymousClaimToken }
      : result;
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
    // "Start a new checkout anyway" — skips ONLY the pending-payment guard
    // (#4438). The subscription guard still applies.
    bypassPendingGuard: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const identity = await resolveUserIdentity(ctx);
    if (args.bypassPendingGuard) {
      // Audit trail: the user confirmed "start a new checkout anyway" past a
      // pending-payment block. Logged server-side so a future double-charge
      // investigation has the bypass record (#4438 review — the original
      // incident was undetected stacked payments).
      console.info(`[checkout] pending-payment guard bypassed user=${userId} product=${args.productId}`);
    }
    // Run both guards concurrently — they share no data, so serial awaits only
    // add a Convex round-trip to every checkout (#4438 review). Subscription
    // block still WINS (evaluated first); bypass skips the pending query.
    const [blocking, pending] = await Promise.all([
      getCheckoutBlockingSubscription(ctx, userId, args.productId),
      args.bypassPendingGuard
        ? Promise.resolve(null)
        : getCheckoutBlockingPendingPayment(ctx, userId, args.productId),
    ]);
    if (blocking) {
      throw new ConvexError(buildBlockedCheckoutPayload(blocking));
    }
    if (pending) {
      throw new ConvexError(buildPendingBlockedPayload(pending));
    }

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
    // See createCheckout — skips only the pending-payment guard (#4438).
    bypassPendingGuard: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!args.userId) {
      throw new ConvexError("userId is required");
    }
    if (args.bypassPendingGuard) {
      // See createCheckout — audit the pending-guard bypass (#4438 review).
      console.info(`[checkout] pending-payment guard bypassed user=${args.userId} product=${args.productId}`);
    }
    // Both guards concurrently (no shared data); subscription block still wins,
    // bypass skips the pending query (#4438 review).
    const [blocking, pending] = await Promise.all([
      getCheckoutBlockingSubscription(ctx, args.userId, args.productId),
      args.bypassPendingGuard
        ? Promise.resolve(null)
        : getCheckoutBlockingPendingPayment(ctx, args.userId, args.productId),
    ]);
    if (blocking) {
      return buildBlockedCheckoutResponse(blocking);
    }
    if (pending) {
      return buildPendingBlockedResponse(pending);
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
