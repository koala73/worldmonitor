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
import {
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
  createDodoCheckoutSession,
} from "../lib/dodo";
import { requireUserId, resolveUserIdentity } from "../lib/auth";
import { extractDomain } from "../lib/emailShape";
import {
  ANON_ID_V4_REGEX,
  signAnonClaimToken,
  signCheckoutLoginEmail,
  signUserId,
} from "../lib/identitySigning";
import { resolveProductToPlan } from "../config/productCatalog";
import { isTrustedReturnUrlOrigin } from "./returnUrlOrigin";
import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  isCheckoutRateLimitedOutcome,
  runCheckoutWithRateLimitRetry,
} from "./checkoutRateLimit";
import { recordTerminalCheckoutRateLimit } from "./checkoutRateLimitAlarm";

// MCP paid-funnel campaign marker (#6716). Imported, never re-declared: a
// second copy of this normalisation is exactly the drift that produced the
// display-vs-enforcement divergence documented in
// docs/solutions/security-issues/mcp-quota-credential-class-vs-plan-family-scoping-bypass.md.
// The Convex runtime imports from `shared/` elsewhere (convex/apiKeys.ts,
// convex/companyMonitoring/*), so there is no module-boundary reason to fork it.
import { normalizeCheckoutAttributionSource as normalizeAttributionSource } from "../../shared/mcp-attribution";

const ACTIVE_SUBSCRIPTION_EXISTS = "ACTIVE_SUBSCRIPTION_EXISTS";
const PAYMENT_IN_PROGRESS = "PAYMENT_IN_PROGRESS";

// RFC 5321 maximum forward-path length. A value beyond it is not an address we
// could deliver to anyway, and it keeps the stamped metadata value small.
const MAX_LOGIN_EMAIL_LENGTH = 254;

/**
 * Normalizes the authenticated login email for stamping into checkout metadata
 * (#6335).
 *
 * This is a shape guard, not a trust boundary — it keeps an unusable value out
 * of a field the webhook later hands to Resend as a recipient. What makes that
 * the right level: `createCheckout` reads the email from the Clerk JWT `email`
 * claim via `resolveUserIdentity`, and `internalCreateCheckout` receives it from
 * `/relay/create-checkout`, whose only caller (`api/create-checkout.ts`) derives
 * it from a JWKS-verified bearer token. Note the relay itself authenticates by
 * shared secret and does NOT re-derive the claim, so "the value is a verified
 * credential" is a property of that caller rather than one enforced here.
 * Downstream this stays safe regardless: the webhook trusts the value only
 * through the HMAC, and the email templates escape it.
 *
 * Case is PRESERVED (the local part is case-sensitive per RFC 5321, and
 * `users.email` is stored the same way).
 *
 * Returns null when there is nothing usable to stamp, in which case the
 * webhook's existing `users.email` → checkout-email ladder is unchanged.
 */
function normalizeCheckoutLoginEmail(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGIN_EMAIL_LENGTH) return null;
  // `extractDomain` owns the @-shape rules (no @, empty local part, a second @,
  // empty domain). Imported from `emailShape` rather than `emailDomain` so the
  // checkout path does not pull in that module's `mailchecker` dependency.
  if (extractDomain(trimmed) === null) return null;
  // Stricter than extractDomain, which only rejects whitespace in the domain
  // half: an address bound for an email `to:` header must have none anywhere.
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Shared checkout session creation logic
// ---------------------------------------------------------------------------

interface CheckoutArgs {
  productId: string;
  returnUrl?: string;
  discountCode?: string;
  referralCode?: string;
  /** MCP paid-funnel attribution (#6716). Parallel to referralCode. */
  attributionSource?: string;
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

    if (!isTrustedReturnUrlOrigin(parsedReturnUrl.origin, new URL(siteUrl).origin)) {
      throw new ConvexError(
        "Invalid returnUrl: must use a trusted worldmonitor.app origin",
      );
    }
    returnUrl = parsedReturnUrl.toString();
  }

  // Record Terms assent (#6976). Both checkout paths — the /pro pricing page
  // and every dashboard CTA — funnel through here, so one call covers them all
  // and no client can skip it: the buyer clicked a button that sits directly
  // under "By subscribing you agree to the Terms of Service and Privacy Policy".
  //
  // Deliberately BEFORE the Dodo call. Assent is a fact about what the user was
  // shown and clicked, not about whether the payment provider then answered.
  //
  // Skipped for an anonymous buyer: `users` is keyed by Clerk userId, and
  // writing an anon UUID into it would create a row nothing can ever join. Their
  // assent lands on the first authenticated session after they claim the
  // subscription, via `users:ensureRecord`'s insert branch.
  //
  // Never allowed to fail the checkout: losing a paid conversion to an audit
  // write is strictly worse than the missing row, which stays visible in logs.
  if (!ANON_ID_V4_REGEX.test(user.userId)) {
    try {
      await ctx.runMutation(internal.users.recordTermsAcceptance, {
        userId: user.userId,
        email: user.email,
      });
    } catch (err) {
      // sentry-coverage-ok: structured console.error is forwarded by Convex
      // auto-Sentry, so on-call still sees a customer who bought without an
      // assent record. Re-throwing is the wrong trade here — same reasoning as
      // the pending-payment guard above: losing a paid conversion to an audit
      // write is strictly worse than the missing row.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[checkout] terms acceptance not recorded user=${user.userId}: ${msg}`,
      );
    }
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
  // #6335: carry the login email that was authenticated FOR THIS CHECKOUT, so
  // the activation webhook can address lifecycle mail without depending on the
  // `users` row — that row is refreshed once per page load per userId
  // (src/services/convex-client.ts short-circuits on a module-level
  // lastEnsuredUserId), so a portal email change made in a long-lived tab
  // leaves it stale and the welcome lands at the abandoned address.
  //
  // Signed as a SEPARATE field rather than folded into `wm_user_id_sig`: that
  // signature's payload must stay `userId` alone, or every checkout session
  // created before this deploy stops verifying at the webhook and its buyer
  // becomes unattributable.
  const loginEmail = normalizeCheckoutLoginEmail(user.email);
  if (loginEmail) {
    metadata.wm_login_email = loginEmail;
    metadata.wm_login_email_sig = await signCheckoutLoginEmail(
      user.userId,
      loginEmail,
      Date.now(),
    );
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
  const attributionSource = normalizeAttributionSource(args.attributionSource);
  if (attributionSource) {
    // Internal source tag for MCP paid-funnel conversions (#6716). Distinct
    // from affonso_referral — never an affiliate code. Mirror read in
    // subscriptionHelpers on first subscription.active.
    metadata.wm_attribution = attributionSource;
  }

  try {
    // A 429 here is Dodo rate-limiting our shared API key (account-level, not
    // per-user/IP — see #6027), so absorb transient limits with the bounded
    // server-side ladder before falling back to the typed rate_limited outcome.
    // The seam pins the SDK to maxRetries: 0 (lib/dodo.ts), so the ladder is
    // the only retry layer — one attempt is exactly one provider request.
    const result = await runCheckoutWithRateLimitRetry(
      () =>
        createDodoCheckoutSession({
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
        }),
      {
        attemptTimeoutMs: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
        onRetry: (delayMs) =>
          console.warn(
            `[checkout] Dodo 429 for user=${user.userId} product=${args.productId}; retrying in ${delayMs}ms`,
          ),
      },
    );
    if (isCheckoutRateLimitedOutcome(result)) {
      console.warn(
        `[checkout] Dodo rate limited checkout creation for user=${user.userId} product=${args.productId} after bounded retry (<=${CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS} attempts); retry after ${result.retryAfterSeconds}s`,
      );
      // The ladder's tail (#6698). This warn is per-occurrence and pages
      // nobody by design; the recorder below owns the RATE and escalates to
      // Convex auto-Sentry once a documented per-day/per-week threshold is
      // crossed. Awaited (not scheduled) so the count is durable before the
      // buyer's 429 is returned, and fail-open so a degraded alarm cannot
      // convert a retryable rate limit into a hard checkout failure.
      await recordTerminalCheckoutRateLimit(ctx, {
        userId: user.userId,
        productId: args.productId,
      });
      return result;
    }
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
    attributionSource: v.optional(v.string()),
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

    const result = await _createCheckoutSession(ctx, args, {
      userId,
      email: identity?.email,
      name: customerName,
    });
    // The public Convex action historically rejects provider failures. Keep
    // that error-channel contract: only the trusted internal relay consumes
    // the typed outcome and translates it into HTTP 429 + Retry-After.
    if (isCheckoutRateLimitedOutcome(result)) {
      throw new ConvexError({
        code: CHECKOUT_RATE_LIMITED,
        message: "Checkout is temporarily rate limited. Retry shortly.",
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return result;
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
    attributionSource: v.optional(v.string()),
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
        attributionSource: args.attributionSource,
      },
      {
        userId: args.userId,
        email: args.email,
        name: args.name,
      },
    );
  },
});
