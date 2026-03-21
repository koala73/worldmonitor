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
    .unique();

  const features = getFeaturesForPlan(planKey);

  if (existing) {
    await ctx.db.patch(existing._id, {
      planKey,
      features,
      validUntil,
      updatedAt,
    });
  } else {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features,
      validUntil,
      updatedAt,
    });
  }

  // Schedule Redis cache sync (fire-and-forget, 0ms delay)
  await ctx.scheduler.runAfter(
    0,
    internal.payments.cacheActions.syncEntitlementCache,
    { userId, planKey, features, validUntil },
  );
}

// ---------------------------------------------------------------------------
// Internal resolution helpers
// ---------------------------------------------------------------------------

const FALLBACK_USER_ID = "test-user-001";

/**
 * Resolves a Dodo product ID to a plan key via the productPlans table.
 * Returns "unknown" if the product ID is not mapped.
 */
async function resolvePlanKey(
  ctx: MutationCtx,
  dodoProductId: string,
): Promise<string> {
  const mapping = await ctx.db
    .query("productPlans")
    .withIndex("by_dodoProductId", (q) => q.eq("dodoProductId", dodoProductId))
    .unique();
  return mapping?.planKey ?? "unknown";
}

/**
 * Resolves a Dodo customer ID to an internal userId via the customers table.
 * Falls back to test user ID (auth stub -- Pitfall 6 from research).
 */
async function resolveUserId(
  ctx: MutationCtx,
  dodoCustomerId: string,
): Promise<string> {
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_dodoCustomerId", (q) =>
      q.eq("dodoCustomerId", dodoCustomerId),
    )
    .unique();
  return customer?.userId ?? FALLBACK_USER_ID;
}

/**
 * Safely converts a Dodo date value to epoch milliseconds.
 * Dodo may send strings or Date-like objects (Pitfall 5 from research).
 */
function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || value instanceof Date) {
    const ms = new Date(value as string).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Subscription event handlers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Handles `subscription.active` -- a new subscription has been activated.
 *
 * Creates or updates the subscription record and upserts entitlements.
 */
export async function handleSubscriptionActive(
  ctx: MutationCtx,
  data: any,
  eventTimestamp: number,
): Promise<void> {
  const planKey = await resolvePlanKey(ctx, data.product_id);
  const userId = await resolveUserId(ctx, data.customer?.customer_id ?? "");

  const currentPeriodStart = toEpochMs(data.previous_billing_date);
  const currentPeriodEnd = toEpochMs(data.next_billing_date);

  const existing = await ctx.db
    .query("subscriptions")
    .withIndex("by_dodoSubscriptionId", (q) =>
      q.eq("dodoSubscriptionId", data.subscription_id),
    )
    .unique();

  if (existing) {
    if (!isNewerEvent(existing.updatedAt, eventTimestamp)) return;
    await ctx.db.patch(existing._id, {
      status: "active",
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
  }

  await upsertEntitlements(ctx, userId, planKey, currentPeriodEnd, eventTimestamp);

  // Upsert customer record so portal session creation can find dodoCustomerId
  const dodoCustomerId = data.customer?.customer_id;
  const email = data.customer?.email ?? "";

  if (dodoCustomerId) {
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) =>
        q.eq("dodoCustomerId", dodoCustomerId),
      )
      .unique();

    if (existingCustomer) {
      await ctx.db.patch(existingCustomer._id, {
        userId,
        email,
        updatedAt: eventTimestamp,
      });
    } else {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId,
        email,
        createdAt: eventTimestamp,
        updatedAt: eventTimestamp,
      });
    }
  }
}

/**
 * Handles `subscription.renewed` -- a recurring payment succeeded and the
 * subscription period has been extended.
 */
export async function handleSubscriptionRenewed(
  ctx: MutationCtx,
  data: any,
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

  const currentPeriodStart = toEpochMs(data.previous_billing_date);
  const currentPeriodEnd = toEpochMs(data.next_billing_date);

  await ctx.db.patch(existing._id, {
    status: "active",
    currentPeriodStart,
    currentPeriodEnd,
    rawPayload: data,
    updatedAt: eventTimestamp,
  });

  // Resolve userId from subscription record
  await upsertEntitlements(
    ctx,
    existing.userId,
    existing.planKey,
    currentPeriodEnd,
    eventTimestamp,
  );
}

/**
 * Handles `subscription.on_hold` -- payment failed, subscription paused.
 *
 * Entitlements remain valid until `currentPeriodEnd` (no immediate revocation).
 */
export async function handleSubscriptionOnHold(
  ctx: MutationCtx,
  data: any,
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

  console.log(
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
  data: any,
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
    ? toEpochMs(data.cancelled_at)
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
  data: any,
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

  await upsertEntitlements(
    ctx,
    existing.userId,
    newPlanKey,
    existing.currentPeriodEnd,
    eventTimestamp,
  );
}

/**
 * Handles `payment.succeeded` and `payment.failed` events.
 *
 * Records a payment event row. Does not alter subscription state --
 * that is handled by the subscription event handlers.
 */
export async function handlePaymentEvent(
  ctx: MutationCtx,
  data: any,
  eventType: string,
  eventTimestamp: number,
): Promise<void> {
  const userId = await resolveUserId(ctx, data.customer?.customer_id ?? "");

  await ctx.db.insert("paymentEvents", {
    userId,
    dodoPaymentId: data.payment_id,
    type: "charge",
    amount: data.total_amount ?? data.amount ?? 0,
    currency: data.currency ?? "USD",
    status: eventType === "payment.succeeded" ? "succeeded" : "failed",
    dodoSubscriptionId: data.subscription_id ?? undefined,
    rawPayload: data,
    occurredAt: eventTimestamp,
  });
}
