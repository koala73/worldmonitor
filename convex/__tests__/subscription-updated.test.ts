/**
 * Tests for the `subscription.updated` webhook handler (PR 3).
 *
 * Dispatches by payload `status` to the existing lifecycle handlers, so
 * the policy invariants those handlers enforce (paid-through cancellation,
 * out-of-order rejection, comp-floor preservation) apply automatically.
 * Unknown statuses fall through to a defensive recompute path.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ID = "user_3CSubUpdated";
const PRODUCT_ID = "pdt_0Nbtt71uObulf7fGXhQup";
const SUB_ID = "sub_test_updated";

const CUSTOMER_ID = "cus_test";

// Per-test seed: an active sub + matching entitlement + customer (for userId resolution).
async function seedActiveSub(
  t: ReturnType<typeof convexTest>,
  opts: { currentPeriodEnd: number; planKey?: string } = { currentPeriodEnd: Date.now() + 7 * DAY_MS },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId: PRODUCT_ID,
      planKey: opts.planKey ?? "pro_monthly",
      displayName: "Pro Monthly",
      isActive: true,
    });
    // Customer mapping so resolveUserId() finds the userId via dodoCustomerId
    // (unsigned wm_user_id metadata is ignored by the handler).
    await ctx.db.insert("customers", {
      userId: USER_ID,
      dodoCustomerId: CUSTOMER_ID,
      email: "test@example.com",
      createdAt: Date.now() - 365 * DAY_MS,
      updatedAt: Date.now() - 365 * DAY_MS,
    });
    await ctx.db.insert("subscriptions", {
      userId: USER_ID,
      dodoSubscriptionId: SUB_ID,
      dodoProductId: PRODUCT_ID,
      planKey: opts.planKey ?? "pro_monthly",
      status: "active",
      currentPeriodStart: Date.now() - 23 * DAY_MS,
      currentPeriodEnd: opts.currentPeriodEnd,
      rawPayload: {},
      updatedAt: Date.now() - 1000,
    });
    await ctx.db.insert("entitlements", {
      userId: USER_ID,
      planKey: opts.planKey ?? "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: false,
        apiRateLimit: 0,
        prioritySupport: false,
        exportFormats: ["csv", "pdf"],
      },
      validUntil: opts.currentPeriodEnd,
      updatedAt: Date.now() - 1000,
    });
  });
}

async function fireSubscriptionUpdated(
  t: ReturnType<typeof convexTest>,
  status: string,
  opts: { eventTimestamp?: number; planKey?: string; cancelledAt?: number } = {},
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `msg_test_${SUB_ID}_updated_${status}_${Math.random().toString(36).slice(2, 6)}`,
    eventType: "subscription.updated",
    rawPayload: {
      type: "subscription.updated",
      data: {
        subscription_id: SUB_ID,
        product_id: PRODUCT_ID,
        status,
        customer: { customer_id: CUSTOMER_ID },
        metadata: { wm_user_id: USER_ID },
        previous_billing_date: new Date(Date.now() - 23 * DAY_MS).toISOString(),
        next_billing_date: new Date(Date.now() + 7 * DAY_MS).toISOString(),
        ...(opts.cancelledAt
          ? { cancelled_at: new Date(opts.cancelledAt).toISOString() }
          : {}),
      },
    },
    timestamp: opts.eventTimestamp ?? Date.now(),
  });
}

async function readEntitlement(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", USER_ID))
      .first(),
  );
}

async function readSub(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db
      .query("subscriptions")
      .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", SUB_ID))
      .unique(),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Paid-through cancellation: the most important invariant
// ───────────────────────────────────────────────────────────────────────────

describe("subscription.updated → status='cancelled' (paid-through invariant)", () => {
  test("preserves entitlement until currentPeriodEnd (mid-period cancellation)", async () => {
    const t = convexTest(schema, modules);
    const periodEnd = Date.now() + 7 * DAY_MS;
    await seedActiveSub(t, { currentPeriodEnd: periodEnd });

    await fireSubscriptionUpdated(t, "cancelled", { cancelledAt: Date.now() });

    const sub = await readSub(t);
    expect(sub?.status).toBe("cancelled");
    const ent = await readEntitlement(t);
    // Paid-through: validUntil should remain at the period end, NOT
    // collapsed to "now".
    expect(ent?.planKey).toBe("pro_monthly");
    expect(ent?.validUntil).toBe(periodEnd);
  });

  test("does NOT touch entitlement on cancellation — only subscription.expired downgrades to free", async () => {
    const t = convexTest(schema, modules);
    const expiredPeriodEnd = Date.now() - 1 * DAY_MS;
    await seedActiveSub(t, { currentPeriodEnd: expiredPeriodEnd });

    // Cancellation alone NEVER downgrades, even when the period is already
    // in the past. The entitlement's `validUntil` already reflects period
    // end; `subscription.expired` is the only path that flips planKey→free.
    await fireSubscriptionUpdated(t, "cancelled", { cancelledAt: Date.now() });

    const ent = await readEntitlement(t);
    expect(ent?.planKey).toBe("pro_monthly");
    expect(ent?.validUntil).toBe(expiredPeriodEnd);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Other status dispatches reuse existing lifecycle handlers
// ───────────────────────────────────────────────────────────────────────────

describe("subscription.updated → other statuses dispatch correctly", () => {
  test("status='active' triggers handleSubscriptionActive (sub patched, entitlement re-derived)", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    // Mutate the rawPayload to confirm the patch happened.
    await fireSubscriptionUpdated(t, "active");
    const sub = await readSub(t);
    expect(sub?.status).toBe("active");
    expect((sub?.rawPayload as { status?: string })?.status).toBe("active");
  });

  test("status='on_hold' triggers handleSubscriptionOnHold", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    await fireSubscriptionUpdated(t, "on_hold");
    const sub = await readSub(t);
    expect(sub?.status).toBe("on_hold");
  });

  test("status='expired' triggers handleSubscriptionExpired (free downgrade)", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    await fireSubscriptionUpdated(t, "expired");
    const sub = await readSub(t);
    expect(sub?.status).toBe("expired");
    const ent = await readEntitlement(t);
    expect(ent?.planKey).toBe("free");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Defensive paths
// ───────────────────────────────────────────────────────────────────────────

describe("subscription.updated → defensive paths", () => {
  test("unknown status: logs error + recomputes entitlement defensively (no crash)", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    // Send a status the handler doesn't dispatch for. Should NOT throw —
    // defensive recompute path runs and the row is patched with the new
    // rawPayload + updatedAt.
    await fireSubscriptionUpdated(t, "paused");
    const sub = await readSub(t);
    expect(sub).not.toBeNull();
    // Status field is unchanged (not in our enum) — defensive path only
    // patches rawPayload + updatedAt.
    expect((sub?.rawPayload as { status?: string })?.status).toBe("paused");
  });

  test("missing status: defensive recompute (no crash)", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    // Empty status falls into the default branch.
    await fireSubscriptionUpdated(t, "");
    const sub = await readSub(t);
    expect(sub).not.toBeNull();
  });

  test("stale eventTimestamp: rejected via isNewerEvent guard inherited from delegated handler", async () => {
    const t = convexTest(schema, modules);
    await seedActiveSub(t);
    // First update at "now" — wins.
    const now = Date.now();
    await fireSubscriptionUpdated(t, "active", { eventTimestamp: now });
    const subAfterFirst = await readSub(t);
    const updatedAtAfterFirst = subAfterFirst?.updatedAt;
    // Second update with an OLDER timestamp — should be no-op.
    await fireSubscriptionUpdated(t, "active", { eventTimestamp: now - 60_000 });
    const subAfterSecond = await readSub(t);
    expect(subAfterSecond?.updatedAt).toBe(updatedAtAfterFirst);
  });
});
