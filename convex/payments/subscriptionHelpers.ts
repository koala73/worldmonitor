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
async function resolvePlanKey(
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
