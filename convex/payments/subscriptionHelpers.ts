/**
 * Subscription lifecycle handlers and entitlement upsert.
 *
 * These functions are called from processWebhookEvent (Plan 03) with
 * MutationCtx. They transform Dodo webhook payloads into subscription
 * records and entitlements.
 */

import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import { PLAN_PRECEDENCE, LEGACY_PRODUCT_ALIASES } from "../config/productCatalog";
import { ANON_ID_V4_REGEX, verifyUserId } from "../lib/identitySigning";
import { DEV_USER_ID, isDev } from "../lib/auth";

// ---------------------------------------------------------------------------
// Types for webhook payload data (narrowed from `any`)
// ---------------------------------------------------------------------------

interface DodoCustomer {
  customer_id?: string;
  email?: string;
}

interface DodoSubscriptionData {
  subscription_id: string;
  product_id: string;
  status?: string;
  customer?: DodoCustomer;
  previous_billing_date?: string | number | Date;
  next_billing_date?: string | number | Date;
  cancelled_at?: string | number | Date;
  metadata?: Record<string, string>;
  recurring_pre_tax_amount?: number;
  currency?: string;
  tax_inclusive?: boolean;
  discount_id?: string | null;
}

interface DodoPaymentData {
  payment_id: string;
  customer?: DodoCustomer;
  total_amount?: number;
  amount?: number;
  currency?: string;
  subscription_id?: string;
  metadata?: Record<string, string>;
  // Dodo's payment IntentStatus (succeeded | failed | cancelled | processing |
  // requires_customer_action | …). On `payment.processing` this is where the
  // 3DS/SCA-pending state is surfaced. See derivePaymentEventStatus.
  status?: string;
}

// The payment/refund webhook event types we route to handlePaymentOrRefundEvent
// — kept in sync with the case group in webhookMutations.ts. Two drift guards,
// with DIFFERENT enforcement (the call site casts `eventType as
// RoutedPaymentEvent`, so cross-file drift is not type-checked):
//   • Intra-file: omit a `case` for a union member below and the `never`
//     default fails to COMPILE — this file's exhaustiveness guarantee.
//   • Cross-file: a NEW webhookMutations.ts case not added to this union is NOT
//     a compile error (the cast launders it); it is caught at RUNTIME by the
//     `never`-default throw — loud, never a silent succeeded/failed mislabel.
//
// IMPORTANT: `payment.requires_customer_action` is NOT a Dodo webhook event
// type. Dodo's payment event types are succeeded | failed | processing |
// cancelled (SDK `WebhookEventType`); the 3DS/SCA-pending state is delivered as
// a `payment.processing` event whose payload `data.status` (IntentStatus) is
// `requires_customer_action`.
type RoutedPaymentEvent =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.processing"
  | "payment.cancelled"
  | "refund.succeeded"
  | "refund.failed";

type PaymentEventStatusValue =
  | "succeeded"
  | "failed"
  | "processing"
  | "requires_customer_action"
  | "cancelled";

// Derives the persisted `paymentEvents.status` from the event type and, for the
// non-terminal `payment.processing` event, the payload IntentStatus — that is
// where Dodo surfaces the 3DS/SCA-pending `requires_customer_action` state
// (#4436). Throws on an unrouted event rather than silently mislabeling it.
function derivePaymentEventStatus(
  eventType: RoutedPaymentEvent,
  data: DodoPaymentData,
): PaymentEventStatusValue {
  switch (eventType) {
    case "payment.succeeded":
    case "refund.succeeded":
      return "succeeded";
    case "payment.failed":
    case "refund.failed":
      return "failed";
    case "payment.cancelled":
      return "cancelled";
    case "payment.processing":
      // Plain in-flight vs. 3DS/SCA-pending. Other non-terminal IntentStatus
      // values (requires_payment_method, etc.) collapse to `processing` — never
      // to a terminal succeeded/failed.
      return data.status === "requires_customer_action"
        ? "requires_customer_action"
        : "processing";
    default: {
      const _exhaustive: never = eventType;
      throw new Error(
        `[webhook] derivePaymentEventStatus: unrouted event ${String(_exhaustive)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `incomingTimestamp` is newer than `existingUpdatedAt`.
 * Used to reject out-of-order webhook events (Pitfall 7 from research).
 */
export function isNewerEvent(
  existingUpdatedAt: number,
  incomingTimestamp: number,
): boolean {
  return incomingTimestamp > existingUpdatedAt;
}

/**
 * Creates or updates the entitlements record for a given user.
 * Only one entitlement row exists per userId (upsert semantics).
 */
export async function upsertEntitlements(
  ctx: MutationCtx,
  userId: string,
  planKey: string,
  validUntil: number,
  updatedAt: number,
): Promise<void> {
  const existing = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();

  const features = getFeaturesForPlan(planKey);

  if (existing) {
    await ctx.db.patch(existing._id, {
      planKey,
      features,
      validUntil,
      updatedAt,
    });
  } else {
    // Re-check immediately before insert: Convex OCC serializes mutations, but two
    // concurrent webhooks for the same userId (e.g. subscription.active + payment.succeeded)
    // can both read null above and both reach this branch. Convex's OCC will retry the
    // second mutation — on retry it will find the row and fall into the patch branch above.
    // This explicit re-check makes the upsert semantics clear even without OCC retry context.
    const existingNow = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existingNow) {
      await ctx.db.patch(existingNow._id, { planKey, features, validUntil, updatedAt });
    } else {
      await ctx.db.insert("entitlements", {
        userId,
        planKey,
        features,
        validUntil,
        updatedAt,
      });
    }
  }

  // ACCEPTED BOUND: cache sync runs after mutation commits. If scheduler
  // fails to enqueue, stale cache survives up to ENTITLEMENT_CACHE_TTL_SECONDS
  // (900s). Gateway falls back to Convex DB on cache miss — latency only.
  // Schedule Redis cache sync only when Redis is configured.
  // Skipped in test environments (no UPSTASH_REDIS_REST_URL) to avoid
  // convex-test "Write outside of transaction" errors from scheduled functions.
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await ctx.scheduler.runAfter(
      0,
      internal.payments.cacheActions.syncEntitlementCache,
      { userId, planKey, features, validUntil },
    );
  }
}

// ---------------------------------------------------------------------------
// Coverage helpers
// ---------------------------------------------------------------------------

/** The local `subscriptions.status` union (mirrors `subscriptionStatus` in schema.ts). */
export type SubscriptionStatus = "active" | "on_hold" | "cancelled" | "expired";

type SubscriptionRow = {
  _id: import("../_generated/dataModel").Id<"subscriptions">;
  userId: string;
  dodoSubscriptionId: string;
  planKey: string;
  status: SubscriptionStatus;
  currentPeriodEnd: number;
};

/**
 * A subscription is "still covering" the user when it is active, on-hold
 * (payment retry window — entitlement preserved per business policy), or
 * cancelled-but-paid-through (currentPeriodEnd in the future).
 */
function isCoveringAt<T extends Pick<SubscriptionRow, "status" | "currentPeriodEnd">>(
  s: T,
  at: number,
): boolean {
  return (
    s.status === "active" ||
    s.status === "on_hold" ||
    (s.status === "cancelled" && s.currentPeriodEnd > at)
  );
}

/**
 * Deterministic comparator over covering subscriptions. Returns positive when
 * `a` outranks `b`, negative when `b` outranks `a`, zero only when fully
 * indistinguishable. Tie-break order:
 *
 *   1. higher `features.tier` wins (primary)
 *   2. higher `PLAN_PRECEDENCE[planKey]` wins (capability tie-break — e.g.
 *      api_business beats api_starter at tier 2; pro_annual beats pro_monthly
 *      at tier 1)
 *   3. later `currentPeriodEnd` wins (duration tie-break — keep the longest-
 *      lived covering sub)
 *
 * Exported for testing; use `pickBestCoveringSub` for the picker.
 */
export function compareSubscriptionsByCoverage<
  T extends Pick<SubscriptionRow, "planKey" | "currentPeriodEnd">,
>(a: T, b: T): number {
  const tierDelta = getFeaturesForPlan(a.planKey).tier - getFeaturesForPlan(b.planKey).tier;
  if (tierDelta !== 0) return tierDelta;
  const rankDelta = (PLAN_PRECEDENCE[a.planKey] ?? 0) - (PLAN_PRECEDENCE[b.planKey] ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.currentPeriodEnd - b.currentPeriodEnd;
}

/**
 * Picks the strongest covering subscription for a user, or null if none
 * cover. Reads ALL of the user's subscriptions via `by_userId`; pass the
 * post-write timestamp so a sub that was just patched (e.g. expired) is
 * correctly excluded.
 */
async function pickBestCoveringSub(
  ctx: MutationCtx,
  userId: string,
  at: number,
): Promise<SubscriptionRow | null> {
  const candidates = await ctx.db
    .query("subscriptions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();

  let best: SubscriptionRow | null = null;
  for (const s of candidates) {
    if (!isCoveringAt(s, at)) continue;
    if (best === null || compareSubscriptionsByCoverage(s, best) > 0) {
      best = s as SubscriptionRow;
    }
  }
  return best;
}

/**
 * Recomputes the user's entitlement from ALL of their subscriptions.
 *
 * This is the ONE entitlement-write path for subscription event handlers.
 * It exists because the `entitlements` table is one-row-per-user but a single
 * user can hold multiple concurrent Dodo subscriptions on the same userId
 * (e.g. upgraded by buying a higher-tier plan instead of plan-change in the
 * customer portal). A naive per-event `upsertEntitlements(userId, planKey, ...)`
 * silently clobbers the entitlement row with the *event's* sub even when
 * another paid sub still covers the user — see review feedback on PR #3470.
 *
 * Algorithm:
 *   1. Honor a standing comp floor: if compUntil is in the future, leave
 *      the entitlement untouched (goodwill credit outlives Dodo state).
 *   2. Pick the strongest covering sub via the deterministic comparator
 *      (tier > PLAN_PRECEDENCE > currentPeriodEnd).
 *   3. If a covering sub exists, write its (planKey, currentPeriodEnd).
 *   4. Otherwise downgrade to free.
 *
 * Note: callers MUST persist their own subscription row patch BEFORE calling
 * this helper so the recompute sees the post-event state.
 */
export async function recomputeEntitlementFromAllSubs(
  ctx: MutationCtx,
  userId: string,
  eventTimestamp: number,
): Promise<void> {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  if (entitlement?.compUntil && entitlement.compUntil > eventTimestamp) {
    console.log(
      `[subscriptionHelpers] recompute for ${userId} — comp floor active until ${new Date(entitlement.compUntil).toISOString()}, preserving entitlement`,
    );
    return;
  }

  const best = await pickBestCoveringSub(ctx, userId, eventTimestamp);
  if (best) {
    await upsertEntitlements(ctx, userId, best.planKey, best.currentPeriodEnd, eventTimestamp);
    return;
  }

  // No covering sub — downgrade to free. validUntil = eventTimestamp marks the
  // immediate-revoke point; entitlement queries fall back to free-tier defaults
  // when validUntil is in the past.
  await upsertEntitlements(ctx, userId, "free", eventTimestamp, eventTimestamp);
}

// ---------------------------------------------------------------------------
// Internal resolution helpers
// ---------------------------------------------------------------------------

/**
 * Fallback plan key when a webhook references a Dodo product ID we don't
 * recognize (operator edited a product in the Dodo dashboard, didn't update
 * our catalog).
 *
 * Picked as the HIGHEST-tier paid plan to maximise over-grant. Rationale:
 * we don't know what the customer paid for, but they ARE paying (the
 * webhook is from Dodo for an active subscription). The downside of
 * over-grant — a Pro customer briefly gets Enterprise features until
 * ops fixes the catalog — is bounded and cheap. The downside of under-
 * grant — an Enterprise customer silently loses apiAccess + priority
 * support mid-billing-cycle because we mapped them to pro_monthly
 * (tier 1, apiAccess: false) — is a real-money regression on the exact
 * customers this fallback is supposed to protect.
 *
 * The "fail open" branch in `resolvePlanKey` ALSO fires a loud
 * console.error which Convex auto-Sentry forwards, so ops gets paged
 * before the customer notices their entitlement is wrong. Combined with
 * scripts/audit-dodo-catalog.cjs running on a schedule, the fallback
 * window is short — usually hours, not days.
 *
 * Greptile P1 review on PR #3642 caught the original `pro_monthly`
 * choice silently revoking API access from `api_*` / `enterprise` customers.
 */
const FALLBACK_PLAN_KEY = "enterprise";

/**
 * Resolves a Dodo product ID to a plan key via the productPlans table.
 * Falls back to LEGACY_PRODUCT_ALIASES for old test-mode product IDs.
 *
 * Fail-open behaviour (added 2026-05-10 after sub_0NeQV8vJI0fEwUEDjp3cA
 * incident): if the product ID is unknown to BOTH the table AND the
 * legacy aliases, log a structured error and return FALLBACK_PLAN_KEY
 * instead of throwing. The previous behaviour (throw → webhook 500 →
 * Dodo retries forever) blocked entitlement updates for any customer
 * whose subscription was migrated to a new Dodo product ID.
 *
 * The fallback is paired with `scripts/audit-dodo-catalog.cjs` which
 * runs on a schedule and detects "Dodo has products our catalog doesn't"
 * BEFORE a webhook arrives, so most cases are caught proactively.
 */
export async function resolvePlanKey(
  ctx: MutationCtx,
  dodoProductId: string,
): Promise<string> {
  const mapping = await ctx.db
    .query("productPlans")
    .withIndex("by_dodoProductId", (q) => q.eq("dodoProductId", dodoProductId))
    .unique();
  if (mapping) return mapping.planKey;

  // Fallback: check legacy aliases for old/rotated product IDs.
  // NOTE: must use the static import — Convex's V8 isolate throws
  // `TypeError: dynamic module import unsupported` on `await import(...)`,
  // which would silently break the legacy-alias path on every webhook
  // for users on rotated product IDs (WORLDMONITOR-QM, 13 events / 1 user).
  const aliasedPlan = LEGACY_PRODUCT_ALIASES[dodoProductId];
  if (aliasedPlan) {
    console.warn(
      `[subscriptionHelpers] Resolved "${dodoProductId}" via legacy alias → "${aliasedPlan}". ` +
        `Consider updating the subscription to the current product ID.`,
    );
    return aliasedPlan;
  }

  // sentry-coverage-ok: structured console.error is forwarded by Convex
  // auto-Sentry so on-call sees the unmapped product immediately. We do
  // NOT throw — that would 500 the webhook and trigger Dodo's retry storm,
  // which leaves the customer's entitlement wedged. The over-grant
  // fallback (FALLBACK_PLAN_KEY = enterprise) is intentional — see the
  // const's JSDoc for the rationale.
  console.error(
    `[subscriptionHelpers] Unknown Dodo product ID "${dodoProductId}" — ` +
      `not in productPlans table and not in LEGACY_PRODUCT_ALIASES. ` +
      `Falling back to "${FALLBACK_PLAN_KEY}" (over-grant) so the customer ` +
      `keeps full paid entitlement until catalog is fixed. ` +
      `ACTION REQUIRED: add this product to ` +
      `convex/config/productCatalog.ts (LEGACY_PRODUCT_ALIASES or PRODUCT_CATALOG) ` +
      `and re-run seedProductPlans. See scripts/audit-dodo-catalog.cjs.`,
  );
  return FALLBACK_PLAN_KEY;
}

/**
 * Resolves a user identity from webhook data using multiple sources:
 *   1. HMAC-verified checkout metadata (wm_user_id + wm_user_id_sig)
 *   2. Customer table lookup by dodoCustomerId
 *   3. Dev-only fallback to test-user-001
 *
 * Only trusts metadata.wm_user_id when accompanied by a valid HMAC signature
 * created server-side by the authenticated checkout action.
 */
async function resolveUserId(
  ctx: MutationCtx,
  dodoCustomerId: string,
  metadata?: Record<string, string>,
): Promise<string> {
  // 1. HMAC-verified checkout metadata — only trust signed identity
  if (metadata?.wm_user_id && metadata?.wm_user_id_sig) {
    const isValid = await verifyUserId(metadata.wm_user_id, metadata.wm_user_id_sig);
    if (isValid) {
      return metadata.wm_user_id;
    }
    console.warn(
      `[subscriptionHelpers] Invalid HMAC signature for wm_user_id="${metadata.wm_user_id}" — ignoring metadata`,
    );
  } else if (metadata?.wm_user_id && !metadata?.wm_user_id_sig) {
    console.warn(
      `[subscriptionHelpers] Unsigned wm_user_id="${metadata.wm_user_id}" — ignoring (requires HMAC signature)`,
    );
  }

  // 2. Customer table lookup
  if (dodoCustomerId) {
    const customer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) =>
        q.eq("dodoCustomerId", dodoCustomerId),
      )
      .first();
    if (customer?.userId) {
      return customer.userId;
    }
  }

  // 3. Dev-only fallback
  if (isDev) {
    console.warn(
      `[subscriptionHelpers] No user identity found for customer="${dodoCustomerId}" — using dev fallback "${DEV_USER_ID}"`,
    );
    return DEV_USER_ID;
  }

  throw new Error(
    `[subscriptionHelpers] Cannot resolve userId: no verified metadata, no customer record, no dodoCustomerId.`,
  );
}

/**
 * Safely converts a Dodo date value to epoch milliseconds.
 * Dodo may send strings or Date-like objects (Pitfall 5 from research).
 *
 * Warns on missing/invalid values to surface data issues instead of
 * silently defaulting. Falls back to the provided fallback (typically
 * eventTimestamp) or Date.now() if no fallback is given.
 */
function toEpochMs(value: unknown, fieldName?: string, fallback?: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || value instanceof Date) {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  const fb = fallback ?? Date.now();
  console.warn(
    `[subscriptionHelpers] toEpochMs: missing or invalid ${fieldName ?? "date"} value (${String(value)}) — falling back to ${fallback !== undefined ? "eventTimestamp" : "Date.now()"}`,
  );
  return fb;
}

// ---------------------------------------------------------------------------
// Subscription event handlers
// ---------------------------------------------------------------------------

/**
 * Coalesce the Dodo customer id across a webhook event and the existing
 * subscriptions row.
 *
 * `DodoSubscriptionData.customer` is optional and lifecycle events
 * (`subscription.renewed`, `.on_hold`, `.cancelled`, `.plan_changed`,
 * `.expired`, `.updated`) sometimes arrive without it. A blind
 * `rawPayload: data` patch would silently wipe the previously-known
 * `customer.customer_id` and leave callers (esp. the Manage Billing
 * portal lookup) unable to resolve which Dodo customer to bill against.
 *
 * Rule: prefer the incoming event's customer_id if present and a
 * non-empty string; otherwise preserve whatever the existing row had
 * (which may itself be undefined if every prior event was customer-less
 * — that's the genuine "no customer" state).
 */
function mergeDodoCustomerId(
  data: DodoSubscriptionData,
  existing: { dodoCustomerId?: string },
): string | undefined {
  const incoming = data.customer?.customer_id;
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing.dodoCustomerId;
}

function preferExistingCustomerOwner(
  existingCustomerUserId: string | undefined,
  resolvedUserId: string,
): string {
  if (
    existingCustomerUserId !== undefined &&
    ANON_ID_V4_REGEX.test(resolvedUserId) &&
    !ANON_ID_V4_REGEX.test(existingCustomerUserId)
  ) {
    return existingCustomerUserId;
  }
  return resolvedUserId;
}

/**
 * Handles `subscription.active` -- a new subscription has been activated.
 *
 * Creates or updates the subscription record and upserts entitlements.
 */
export async function handleSubscriptionActive(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const planKey = await resolvePlanKey(ctx, data.product_id);

  const currentPeriodStart = toEpochMs(data.previous_billing_date, "previous_billing_date", eventTimestamp);
  const currentPeriodEnd = toEpochMs(data.next_billing_date, "next_billing_date", eventTimestamp);

  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  // Stable first-class projection of the Dodo customer id, used by the
  // Manage Billing portal lookup. `data.customer?.customer_id` is
  // sometimes absent on lifecycle events (renewed / on_hold / cancelled
  // / plan_changed / expired), so we always coalesce with the existing
  // column to preserve a known value across patches that overwrite
  // `rawPayload` blindly.
  const incomingDodoCustomerId =
    typeof data.customer?.customer_id === "string" && data.customer.customer_id.length > 0
      ? data.customer.customer_id
      : undefined;

  if (existing && !isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  const existingCustomer = incomingDodoCustomerId
    ? await ctx.db
        .query("customers")
        .withIndex("by_dodoCustomerId", (q) =>
          q.eq("dodoCustomerId", incomingDodoCustomerId),
        )
        .first()
    : null;
  const resolvedUserId = existing
    ? existing.userId
    : await resolveUserId(ctx, incomingDodoCustomerId ?? "", data.metadata);
  const userId = existing
    ? existing.userId
    : preferExistingCustomerOwner(existingCustomer?.userId, resolvedUserId);

  if (existing) {
    await ctx.db.patch(existing._id, {
      userId,
      status: "active",
      dodoProductId: data.product_id,
      planKey,
      currentPeriodStart,
      currentPeriodEnd,
      dodoCustomerId: incomingDodoCustomerId ?? existing.dodoCustomerId,
      rawPayload: data,
      updatedAt: eventTimestamp,
      // A live webhook proves the sub exists and (re)activates it — clear the
      // renewal-reconciliation bookkeeping so a future stale episode starts
      // from a clean slate (esp. the consecutive-404 streak). See
      // payments/billing:reconcileMissedDodoRenewals.
      lastReconcileAttemptAt: undefined,
      reconcileFailureCount: undefined,
      reconcileNotFoundCount: undefined,
    });
  } else {
    await ctx.db.insert("subscriptions", {
      userId,
      dodoSubscriptionId: data.subscription_id,
      dodoProductId: data.product_id,
      planKey,
      status: "active",
      currentPeriodStart,
      currentPeriodEnd,
      dodoCustomerId: incomingDodoCustomerId,
      rawPayload: data,
      updatedAt: eventTimestamp,
    });

    // Referral attribution on conversion (Phase 9 / Todo #223).
    // When a /pro?ref=<code> visitor checks out, Dodo carries the
    // code through as metadata.affonso_referral (see
    // convex/payments/checkout.ts). On the FIRST activation of their
    // subscription we look up the code in userReferralCodes and
    // insert a userReferralCredits row crediting the sharer. The
    // `else` branch guards against double-crediting on webhook
    // replays — existing subscription rows skip this path.
    //
    // `affonso_referral` is the Dodo ↔ Affonso vendor contract key —
    // DO NOT RENAME here or on the write side in checkout.ts. A
    // rename desyncs writer/reader and silently breaks every
    // conversion-path credit.
    const referralCode = data.metadata?.affonso_referral;
    if (typeof referralCode === "string" && referralCode.length > 0) {
      const referrer = await ctx.db
        .query("userReferralCodes")
        .withIndex("by_code", (q) => q.eq("code", referralCode))
        .first();
      if (referrer) {
        const refereeEmail = (data.customer?.email ?? "").trim().toLowerCase();
        if (refereeEmail) {
          const existingCredit = await ctx.db
            .query("userReferralCredits")
            .withIndex("by_referrer_email", (q) =>
              q.eq("referrerUserId", referrer.userId).eq("refereeEmail", refereeEmail),
            )
            .first();
          if (!existingCredit) {
            await ctx.db.insert("userReferralCredits", {
              referrerUserId: referrer.userId,
              refereeEmail,
              createdAt: eventTimestamp,
            });
          }
        }
      }
    }
  }

  // Recompute from ALL subs on this userId — the event's sub may be a
  // duplicate or lower-tier than another active sub (multi-active-sub guard).
  await recomputeEntitlementFromAllSubs(ctx, userId, eventTimestamp);

  // Upsert customer record so portal session creation can find dodoCustomerId
  const email = data.customer?.email ?? "";
  const normalizedEmail = email.trim().toLowerCase();

  if (incomingDodoCustomerId) {
    if (existingCustomer) {
      await ctx.db.patch(existingCustomer._id, {
        userId,
        email,
        normalizedEmail,
        updatedAt: eventTimestamp,
      });
    } else {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId: incomingDodoCustomerId,
        email,
        normalizedEmail,
        createdAt: eventTimestamp,
        updatedAt: eventTimestamp,
      });
    }
  }

  // Schedule welcome + admin notification emails (non-blocking, new subscriptions only)
  if (!email) {
    console.warn(
      `[subscriptionHelpers] subscription.active: no customer email — skipping welcome email (subscriptionId=${data.subscription_id})`,
    );
  } else if (existing) {
    console.log(`[subscriptionHelpers] subscription.active: reactivation — skipping welcome email (subscriptionId=${data.subscription_id})`);
  } else if (process.env.RESEND_API_KEY) {
    await ctx.scheduler.runAfter(
      0,
      internal.payments.subscriptionEmails.sendSubscriptionEmails,
      {
        userEmail: email,
        planKey,
        userId,
        recurringPreTaxAmount: data.recurring_pre_tax_amount,
        currency: data.currency,
        taxInclusive: data.tax_inclusive,
        discountId: data.discount_id ?? undefined,
      },
    );
  }
}

/**
 * Handles `subscription.renewed` -- a recurring payment succeeded and the
 * subscription period has been extended.
 */
export async function handleSubscriptionRenewed(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (!existing) {
    console.warn(
      `[subscriptionHelpers] Renewal for unknown subscription ${data.subscription_id} -- skipping`,
    );
    return;
  }

  if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  const currentPeriodStart = toEpochMs(data.previous_billing_date, "previous_billing_date", eventTimestamp);
  const currentPeriodEnd = toEpochMs(data.next_billing_date, "next_billing_date", eventTimestamp);

  await ctx.db.patch(existing._id, {
    status: "active",
    currentPeriodStart,
    currentPeriodEnd,
    dodoCustomerId: mergeDodoCustomerId(data, existing),
    rawPayload: data,
    updatedAt: eventTimestamp,
    // Renewal proves the sub exists — clear renewal-reconciliation bookkeeping
    // so a future stale episode starts from a clean slate (esp. the
    // consecutive-404 streak). See payments/billing:reconcileMissedDodoRenewals.
    lastReconcileAttemptAt: undefined,
    reconcileFailureCount: undefined,
    reconcileNotFoundCount: undefined,
  });

  // Recompute from ALL subs — a renewal on a lower-tier sub must NOT
  // clobber a higher-tier active sub on the same userId.
  await recomputeEntitlementFromAllSubs(ctx, existing.userId, eventTimestamp);
}

/**
 * Handles `subscription.on_hold` -- payment failed, subscription paused.
 *
 * Entitlements remain valid until `currentPeriodEnd` (no immediate revocation).
 */
export async function handleSubscriptionOnHold(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (!existing) {
    console.warn(
      `[subscriptionHelpers] on_hold for unknown subscription ${data.subscription_id} -- skipping`,
    );
    return;
  }

  if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  // Episode anchor (#4932): only the transition INTO on_hold opens a new
  // dunning episode. Repeated on_hold webhooks (Dodo payment-retry failures,
  // replays) keep the original anchor so the day-3/day-7 clock doesn't reset
  // and the day-0 email isn't re-sent. For pre-#4932 rows already on_hold
  // with no onHoldAt, the fallback MUST be the pre-patch updatedAt — that is
  // exactly what runDunningScan uses as their episode key, so the ledger
  // dedup stays consistent. Falling back to eventTimestamp would move the
  // anchor on every repeat webhook and re-open the finished sequence
  // (duplicate day-3/day-7 sends — PR #4935 review finding 1).
  const enteringHold = existing.status !== "on_hold";
  const onHoldAt = enteringHold ? eventTimestamp : (existing.onHoldAt ?? existing.updatedAt);

  await ctx.db.patch(existing._id, {
    status: "on_hold",
    onHoldAt,
    dodoCustomerId: mergeDodoCustomerId(data, existing),
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  console.warn(
    `[subscriptionHelpers] Subscription ${data.subscription_id} on hold -- payment failure`,
  );
  // Do NOT revoke entitlements -- they remain valid until currentPeriodEnd

  // Day-0 dunning email (#4932), same non-blocking scheduler pattern as the
  // welcome email. The action re-validates state (still on_hold, same
  // episode, not suppressed, not already sent) before sending, so scheduling
  // here is safe even if a recovery webhook lands in between.
  if (enteringHold && process.env.RESEND_API_KEY) {
    await ctx.scheduler.runAfter(
      0,
      internal.payments.subscriptionEmails.sendDunningEmail,
      {
        dodoSubscriptionId: data.subscription_id,
        step: "dunning_day0",
        episodeAt: onHoldAt,
      },
    );
  }
}

/**
 * Handles `subscription.cancelled` -- user cancelled or admin cancelled.
 *
 * Entitlements remain valid until `currentPeriodEnd` (no immediate revocation).
 */
export async function handleSubscriptionCancelled(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (!existing) {
    console.warn(
      `[subscriptionHelpers] Cancellation for unknown subscription ${data.subscription_id} -- skipping`,
    );
    return;
  }

  if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  // Episode anchor (#4932, PR #4935 review round 4): only the transition
  // INTO cancelled opens a new cancellation episode. Repeat cancellation-
  // flavored events (`subscription.updated` with status="cancelled" routes
  // here too, often WITHOUT a stable cancelled_at) must not move the
  // anchor — the winback ledger is keyed on it, so a moved anchor reopens
  // the one-shot winback and emails the same cancellation twice. A real
  // new episode (cancelled → active → cancelled) passes through a
  // non-cancelled status first, so enteringCancelled correctly re-anchors.
  const enteringCancelled = existing.status !== "cancelled";
  const eventCancelledAt = data.cancelled_at
    ? toEpochMs(data.cancelled_at, "cancelled_at", eventTimestamp)
    : eventTimestamp;
  const cancelledAt = enteringCancelled
    ? eventCancelledAt
    : (existing.cancelledAt ?? eventCancelledAt);

  await ctx.db.patch(existing._id, {
    status: "cancelled",
    cancelledAt,
    dodoCustomerId: mergeDodoCustomerId(data, existing),
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  // Do NOT revoke entitlements immediately -- valid until currentPeriodEnd
}

/**
 * Handles `subscription.plan_changed` -- upgrade or downgrade.
 *
 * Updates subscription plan and recomputes entitlements with new features.
 */
export async function handleSubscriptionPlanChanged(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (!existing) {
    console.warn(
      `[subscriptionHelpers] Plan change for unknown subscription ${data.subscription_id} -- skipping`,
    );
    return;
  }

  if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  const newPlanKey = await resolvePlanKey(ctx, data.product_id);

  await ctx.db.patch(existing._id, {
    dodoProductId: data.product_id,
    planKey: newPlanKey,
    dodoCustomerId: mergeDodoCustomerId(data, existing),
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  // Recompute from ALL subs — the new plan may be lower-tier than another
  // active sub on the same userId, in which case we must NOT clobber the
  // entitlement with the downgrade.
  await recomputeEntitlementFromAllSubs(ctx, existing.userId, eventTimestamp);
}

/**
 * Handles `subscription.expired` -- subscription has permanently expired
 * (e.g., max payment retries exceeded).
 *
 * Revokes entitlements by setting validUntil to now, and marks subscription expired.
 */
export async function handleSubscriptionExpired(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (!existing) {
    console.warn(
      `[subscriptionHelpers] Expiration for unknown subscription ${data.subscription_id} -- skipping`,
    );
    return;
  }

  if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;

  await ctx.db.patch(existing._id, {
    status: "expired",
    dodoCustomerId: mergeDodoCustomerId(data, existing),
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  // Recompute from ALL subs (post-patch). The expired sub is now status:
  // "expired" so it's automatically excluded by isCoveringAt; if any other
  // sub still covers the user we keep them on its tier, else free-downgrade.
  // The recompute helper also honours the comp-floor for goodwill credits.
  await recomputeEntitlementFromAllSubs(ctx, existing.userId, eventTimestamp);
}

/**
 * Handles `subscription.updated` -- Dodo's catch-all "any field changed"
 * event (per their webhook docs, this fires for real-time sync without
 * polling). We dispatch by the payload's `status` field to reuse the
 * dedicated lifecycle handlers AND inherit their policy invariants:
 *
 *   - paid-through cancellation: `handleSubscriptionCancelled` preserves
 *     entitlement until `currentPeriodEnd`, NOT immediate revocation. A
 *     `subscription.updated` carrying `status='cancelled'` mid-period
 *     therefore does NOT downgrade until the period ends — same behavior
 *     as a dedicated `subscription.cancelled` event.
 *   - out-of-order protection: each lifecycle handler enforces
 *     `isNewerEvent(existing.updatedAt, eventTimestamp)`, so a delayed
 *     `subscription.updated` for an old state is rejected.
 *
 * Unknown statuses fall to a defensive recompute path: patch the row's
 * rawPayload + updatedAt so we don't lose the event, recompute the
 * entitlement, and console.error so ops can decide if a new dedicated
 * handler is needed.
 */
export async function handleSubscriptionUpdated(
  ctx: MutationCtx,
  data: DodoSubscriptionData,
  eventTimestamp: number,
): Promise<void> {
  const status = (data.status ?? "").toString();
  switch (status) {
    case "active":
      return handleSubscriptionActive(ctx, data, eventTimestamp);
    case "on_hold":
      return handleSubscriptionOnHold(ctx, data, eventTimestamp);
    case "cancelled":
      return handleSubscriptionCancelled(ctx, data, eventTimestamp);
    case "expired":
      return handleSubscriptionExpired(ctx, data, eventTimestamp);
    default: {
      console.error(
        `[handleSubscriptionUpdated] unhandled status="${status}" sub=${data.subscription_id}; ` +
        `recomputing entitlement defensively. Add a dedicated dispatch case if this status starts ` +
        `appearing regularly.`,
      );
      const existing = await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) =>
          q.eq("dodoSubscriptionId", data.subscription_id),
        )
        .unique();
      if (existing && isNewerEvent(existing.updatedAt, eventTimestamp)) {
        await ctx.db.patch(existing._id, {
          dodoCustomerId: mergeDodoCustomerId(data, existing),
          rawPayload: data,
          updatedAt: eventTimestamp,
        });
        await recomputeEntitlementFromAllSubs(ctx, existing.userId, eventTimestamp);
      }
    }
  }
}

/**
 * Handles `payment.succeeded`, `payment.failed`, `refund.succeeded`, and `refund.failed`.
 *
 * Records a payment event row for audit trail. Does not alter subscription state —
 * that is handled by the subscription event handlers.
 *
 * Record type is inferred from event prefix: "payment.*" → "charge", "refund.*" → "refund".
 */
export async function handlePaymentOrRefundEvent(
  ctx: MutationCtx,
  data: DodoPaymentData,
  eventType: string,
  eventTimestamp: number,
): Promise<void> {
  const userId = await resolveUserId(
    ctx,
    data.customer?.customer_id ?? "",
    data.metadata,
  );

  const type = eventType.startsWith("refund.") ? "refund" : "charge";
  // Non-terminal payment states (processing, requires_customer_action / 3DS-SCA)
  // are persisted so the app has a pending-payment signal for duplicate-
  // prevention (#4438) and reconciliation (#4439); `cancelled` is terminal-but-
  // uncharged. The prior binary `endsWith(".succeeded") ? … : "failed"`
  // mislabeled every one of these as a failed charge. The cast is safe: every
  // caller is gated by the webhook switch's routed-event cases, and an
  // unexpected value throws (loudly) in derivePaymentEventStatus.
  const status = derivePaymentEventStatus(eventType as RoutedPaymentEvent, data);

  await ctx.db.insert("paymentEvents", {
    userId,
    dodoPaymentId: data.payment_id,
    type,
    amount: data.total_amount ?? data.amount ?? 0,
    currency: data.currency ?? "USD",
    status,
    dodoSubscriptionId: data.subscription_id ?? undefined,
    // Carried from the checkout-session metadata bridge (set in
    // convex/payments/checkout.ts). Lets the duplicate-payment guard resolve a
    // pending row to its tierGroup (#4438). Undefined for sessions created
    // before the bridge shipped or events that drop session metadata.
    planKey: data.metadata?.wm_plan_key,
    rawPayload: data,
    occurredAt: eventTimestamp,
  });

  // Refund-without-prior-cancellation alert. Dodo Payments treats refund
  // and subscription cancellation as separate operations — refunding a
  // subscription payment does NOT cancel the subscription. Their own docs
  // (and the SaaS Refund Management blog) recommend "cancel first, then
  // refund." When operators forget the cancel step, the user keeps Pro
  // access until manual cleanup (we hit this 2026-04-29 with
  // nokzbtl@gmail.com — the entitlement only downgraded after the operator
  // manually cancelled on Dodo).
  //
  // Alert-only (per ops decision) — do NOT auto-revoke. Auto-revoke would
  // hide the operator-process gap. Surface it loudly via Sentry instead so
  // it gets noticed within minutes, not days.
  if (eventType === "refund.succeeded" && data.subscription_id) {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) =>
        q.eq("dodoSubscriptionId", data.subscription_id ?? ""),
      )
      .unique();
    const decision = classifyRefundAlert({
      subStatus: sub?.status,
      subCancelledAt: sub?.cancelledAt,
      subRawPayload: sub?.rawPayload,
      subUserId: sub?.userId,
      refundAmount: data.total_amount ?? data.amount ?? 0,
    });
    if (decision.kind === "alert") {
      console.error(
        `[refund-alert] full refund without prior cancellation: ` +
        `subId=${data.subscription_id} userId=${decision.userId} ` +
        `refund=${decision.refundAmount} subAmount=${decision.subAmount} ` +
        `paymentId=${data.payment_id}. Operator likely forgot to cancel ` +
        `before refund — entitlement remains active until manual cleanup.`,
      );
      // Convex auto-Sentry captures console.error.
    } else if (decision.kind === "warn-amount-unknown") {
      // rawPayload missing recurring_pre_tax_amount — can't classify
      // amount comparison. Don't false-positive; log warn so we know the
      // case exists.
      console.warn(
        `[refund-alert] refund on active sub but cannot classify amount: ` +
        `subId=${data.subscription_id} userId=${decision.userId} ` +
        `refund=${decision.refundAmount} (rawPayload.recurring_pre_tax_amount missing)`,
      );
    }
  }
}

/**
 * Pure helper exported for unit tests. Decides whether a `refund.succeeded`
 * event on a subscription warrants a Sentry alert.
 *
 * The decision is intentionally tri-state:
 *   - 'alert'              → full refund on an active uncancelled sub; ops paged
 *   - 'warn-amount-unknown' → active sub but rawPayload lacks the price field;
 *                              don't false-positive, but don't silently drop
 *   - 'no-op'              → partial refund, already-cancelled sub, no sub, etc.
 *
 * `recurring_pre_tax_amount` is NOT a top-level column on the `subscriptions`
 * schema (verified against schema.ts:286-297) — it only appears in `rawPayload`,
 * preserved as the Dodo subscription webhook's snake_case payload.
 */
export type RefundAlertDecision =
  | { kind: "alert"; userId: string; refundAmount: number; subAmount: number }
  | { kind: "warn-amount-unknown"; userId: string; refundAmount: number }
  | { kind: "no-op"; reason: string };

export function classifyRefundAlert(input: {
  subStatus: string | undefined;
  subCancelledAt: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subRawPayload: any;
  subUserId: string | undefined;
  refundAmount: number;
}): RefundAlertDecision {
  if (!input.subStatus || !input.subUserId) {
    return { kind: "no-op", reason: "no-subscription" };
  }
  if (input.subStatus !== "active") {
    return { kind: "no-op", reason: `sub-status-${input.subStatus}` };
  }
  if (input.subCancelledAt) {
    return { kind: "no-op", reason: "already-cancelled" };
  }
  const subAmount = typeof input.subRawPayload?.recurring_pre_tax_amount === "number"
    ? input.subRawPayload.recurring_pre_tax_amount
    : 0;
  if (subAmount <= 0) {
    return {
      kind: "warn-amount-unknown",
      userId: input.subUserId,
      refundAmount: input.refundAmount,
    };
  }
  // 1% tolerance for tax/rounding (e.g. integer-minor-unit currencies where
  // a 99.7%-of-amount refund is the closest representable full refund).
  const isFullRefund = input.refundAmount >= subAmount * 0.99;
  if (!isFullRefund) {
    return { kind: "no-op", reason: "partial-refund" };
  }
  return {
    kind: "alert",
    userId: input.subUserId,
    refundAmount: input.refundAmount,
    subAmount,
  };
}

/**
 * Handles dispute events (opened, won, lost, closed).
 *
 * Records a payment event for audit trail. On dispute.lost,
 * logs a warning since entitlement revocation may be needed.
 */
export async function handleDisputeEvent(
  ctx: MutationCtx,
  data: DodoPaymentData,
  eventType: string,
  eventTimestamp: number,
): Promise<void> {
  const existingSubscription = data.subscription_id
    ? await ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) =>
          q.eq("dodoSubscriptionId", data.subscription_id ?? ""),
        )
        .unique()
    : null;
  const userId = existingSubscription?.userId
    ?? await resolveUserId(
      ctx,
      data.customer?.customer_id ?? "",
      data.metadata,
    );

  const disputeStatusMap: Record<string, "dispute_opened" | "dispute_won" | "dispute_lost" | "dispute_closed"> = {
    "dispute.opened": "dispute_opened",
    "dispute.won": "dispute_won",
    "dispute.lost": "dispute_lost",
    "dispute.closed": "dispute_closed",
  };
  const disputeStatus = disputeStatusMap[eventType];
  if (!disputeStatus) {
    console.error(`[handleDisputeEvent] Unknown dispute event type: ${eventType}`);
    return;
  }

  await ctx.db.insert("paymentEvents", {
    userId,
    dodoPaymentId: data.payment_id,
    type: "charge", // disputes are related to charges
    amount: data.total_amount ?? data.amount ?? 0,
    currency: data.currency ?? "USD",
    status: disputeStatus,
    dodoSubscriptionId: data.subscription_id ?? undefined,
    rawPayload: data,
    occurredAt: eventTimestamp,
  });

  if (eventType === "dispute.lost") {
    console.warn(
      `[subscriptionHelpers] Dispute LOST for user ${userId}, payment ${data.payment_id} — recomputing entitlement`,
    );

    if (existingSubscription && isNewerEvent(existingSubscription.updatedAt, eventTimestamp)) {
      await ctx.db.patch(existingSubscription._id, {
        status: "expired",
        rawPayload: data,
        updatedAt: eventTimestamp,
      });
    }

    await recomputeEntitlementFromAllSubs(ctx, userId, eventTimestamp);
  }
}
