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
import { PLAN_PRECEDENCE } from "../config/productCatalog";
import { verifyUserId } from "../lib/identitySigning";
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

type SubscriptionRow = {
  _id: import("../_generated/dataModel").Id<"subscriptions">;
  userId: string;
  dodoSubscriptionId: string;
  planKey: string;
  status: "active" | "on_hold" | "cancelled" | "expired";
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
 * Resolves a Dodo product ID to a plan key via the productPlans table.
 * Falls back to LEGACY_PRODUCT_ALIASES for old test-mode product IDs
 * that may still appear on existing subscriber webhooks.
 * Throws if the product ID is not mapped anywhere.
 */
async function resolvePlanKey(
  ctx: MutationCtx,
  dodoProductId: string,
): Promise<string> {
  const mapping = await ctx.db
    .query("productPlans")
    .withIndex("by_dodoProductId", (q) => q.eq("dodoProductId", dodoProductId))
    .unique();
  if (mapping) return mapping.planKey;

  // Fallback: check legacy aliases for old/rotated product IDs
  const { LEGACY_PRODUCT_ALIASES } = await import("../config/productCatalog");
  const aliasedPlan = LEGACY_PRODUCT_ALIASES[dodoProductId];
  if (aliasedPlan) {
    console.warn(
      `[subscriptionHelpers] Resolved "${dodoProductId}" via legacy alias → "${aliasedPlan}". ` +
        `Consider updating the subscription to the current product ID.`,
    );
    return aliasedPlan;
  }

  throw new Error(
    `[subscriptionHelpers] No productPlans mapping for dodoProductId="${dodoProductId}". ` +
      `Add this product to the catalog and run seedProductPlans.`,
  );
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
  const userId = await resolveUserId(
    ctx,
    data.customer?.customer_id ?? "",
    data.metadata,
  );

  const currentPeriodStart = toEpochMs(data.previous_billing_date, "previous_billing_date", eventTimestamp);
  const currentPeriodEnd = toEpochMs(data.next_billing_date, "next_billing_date", eventTimestamp);

  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (existing) {
    if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;
    await ctx.db.patch(existing._id, {
      userId,
      status: "active",
      dodoProductId: data.product_id,
      planKey,
      currentPeriodStart,
      currentPeriodEnd,
      rawPayload: data,
      updatedAt: eventTimestamp,
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
  const dodoCustomerId = data.customer?.customer_id;
  const email = data.customer?.email ?? "";
  const normalizedEmail = email.trim().toLowerCase();

  if (dodoCustomerId) {
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) =>
        q.eq("dodoCustomerId", dodoCustomerId),
      )
      .first();

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
        dodoCustomerId,
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
    rawPayload: data,
    updatedAt: eventTimestamp,
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

  await ctx.db.patch(existing._id, {
    status: "on_hold",
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  console.warn(
    `[subscriptionHelpers] Subscription ${data.subscription_id} on hold -- payment failure`,
  );
  // Do NOT revoke entitlements -- they remain valid until currentPeriodEnd
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

  const cancelledAt = data.cancelled_at
    ? toEpochMs(data.cancelled_at, "cancelled_at", eventTimestamp)
    : eventTimestamp;

  await ctx.db.patch(existing._id, {
    status: "cancelled",
    cancelledAt,
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
  const status = eventType.endsWith(".succeeded") ? "succeeded" : "failed";

  await ctx.db.insert("paymentEvents", {
    userId,
    dodoPaymentId: data.payment_id,
    type,
    amount: data.total_amount ?? data.amount ?? 0,
    currency: data.currency ?? "USD",
    status,
    dodoSubscriptionId: data.subscription_id ?? undefined,
    rawPayload: data,
    occurredAt: eventTimestamp,
  });
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
  const userId = await resolveUserId(
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
      `[subscriptionHelpers] Dispute LOST for user ${userId}, payment ${data.payment_id} — revoking entitlement`,
    );
    // Chargeback = no longer entitled. Downgrade to free immediately.
    // Use eventTimestamp (not Date.now()) to preserve isNewerEvent out-of-order protection.
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      const freeFeatures = getFeaturesForPlan("free");
      await ctx.db.patch(existing._id, {
        planKey: "free",
        features: freeFeatures,
        validUntil: eventTimestamp,
        updatedAt: eventTimestamp,
      });
      if (process.env.UPSTASH_REDIS_REST_URL) {
        await ctx.scheduler.runAfter(
          0,
          internal.payments.cacheActions.syncEntitlementCache,
          {
            userId,
            planKey: "free",
            features: freeFeatures,
            validUntil: eventTimestamp,
          },
        );
      }
    }
  }
}
