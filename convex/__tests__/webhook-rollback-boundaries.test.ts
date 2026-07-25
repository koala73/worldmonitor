import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  PENDING_PAYMENT_BLOCK_WINDOW_MS,
} from "../payments/billing";
import { isNewerEvent } from "../payments/subscriptionHelpers";

const modules = import.meta.glob("../**/*.ts");

// Permanent regressions for #5380: malformed-late-webhook transactional
// rollback, exact TTL/paid-through boundaries, and equal-timestamp lifecycle
// ordering — each previously proven only by temporary tests or untested.

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();

function makeSubscriptionPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "subscription.active",
    business_id: "biz_test",
    timestamp: "2026-03-21T10:00:00Z",
    data: {
      payload_type: "Subscription",
      subscription_id: "sub_test_001",
      product_id: "pdt_test_pro",
      status: "active",
      customer: {
        customer_id: "cust_test_001",
        email: "test@example.com",
        name: "Test User",
      },
      metadata: { wm_user_id: "test-user-001" },
      previous_billing_date: "2026-03-21T00:00:00Z",
      next_billing_date: "2026-04-21T00:00:00Z",
      ...overrides,
    },
  };
}

async function seedProductPlan(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId: "pdt_test_pro",
      planKey: "pro_monthly",
      displayName: "Pro Monthly",
      isActive: true,
    });
  });
}

async function seedCustomer(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("customers", {
      userId: "test-user-001",
      dodoCustomerId: "cust_test_001",
      email: "test@example.com",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });
  });
}

async function processEvent(
  t: ReturnType<typeof convexTest>,
  webhookId: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
  timestamp: number,
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId,
    eventType,
    rawPayload,
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// #5380 High-2: malformed late webhook must roll back atomically
// ---------------------------------------------------------------------------

describe("malformed webhook transactional rollback", () => {
  test("a crash mid-handler leaves ZERO subscription/entitlement/webhook rows", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    // `customer.email` as a number crashes the post-insert customer upsert
    // (`email.trim()`), i.e. AFTER the subscription insert and entitlement
    // recompute in the same mutation — the exact partial-write hazard.
    const malformed = makeSubscriptionPayload({
      customer: { customer_id: "cust_test_001", email: 12345, name: "Bad" },
    });

    await expect(
      processEvent(t, "wh_malformed_1", "subscription.active", malformed, BASE_TIMESTAMP),
    ).rejects.toThrow();

    const { subs, ents, events } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
      events: await ctx.db.query("webhookEvents").collect(),
    }));
    expect(subs).toHaveLength(0);
    expect(ents).toHaveLength(0);
    // No dedup ledger row either — the retry must be able to re-process.
    expect(events).toHaveLength(0);
  });

  test("Dodo's retry of the rolled-back webhookId then processes cleanly", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    const malformed = makeSubscriptionPayload({
      customer: { customer_id: "cust_test_001", email: 12345, name: "Bad" },
    });
    await expect(
      processEvent(t, "wh_retry_1", "subscription.active", malformed, BASE_TIMESTAMP),
    ).rejects.toThrow();

    // Same webhookId, corrected payload — must NOT be treated as a duplicate.
    await processEvent(t, "wh_retry_1", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP + 1);

    const { subs, ents } = await t.run(async (ctx) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      ents: await ctx.db.query("entitlements").collect(),
    }));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe("active");
    expect(ents).toHaveLength(1);
    expect(ents[0]?.planKey).toBe("pro_monthly");
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-9: equal-timestamp lifecycle ordering
// ---------------------------------------------------------------------------

describe("equal-timestamp lifecycle ordering", () => {
  test("isNewerEvent rejects an equal timestamp (replay must not reorder state)", () => {
    expect(isNewerEvent(1_000, 1_000)).toBe(false);
    expect(isNewerEvent(1_000, 999)).toBe(false);
    expect(isNewerEvent(1_000, 1_001)).toBe(true);
  });

  test("a cancellation carrying the SAME timestamp as the activation is ignored", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t);
    await seedCustomer(t);

    await processEvent(t, "wh_eq_1", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_eq_2",
      "subscription.cancelled",
      makeSubscriptionPayload({ status: "cancelled" }),
      BASE_TIMESTAMP,
    );

    const sub = await t.run(async (ctx) =>
      ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_test_001"))
        .unique(),
    );
    expect(sub?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-7: pending-payment block window boundary
// ---------------------------------------------------------------------------

describe("pending-payment block window boundary", () => {
  async function seedPendingCharge(t: ReturnType<typeof convexTest>, occurredAt: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentEvents", {
        userId: "test-user-001",
        dodoPaymentId: "pay_pending_001",
        type: "charge",
        amount: 999,
        currency: "USD",
        status: "requires_customer_action",
        planKey: "pro_monthly",
        rawPayload: {},
        occurredAt,
      });
    });
  }

  test("a pending payment exactly AT the window edge no longer blocks", async () => {
    const t = convexTest(schema, modules);
    // occurredAt == Date.now() - WINDOW at seed time; by query time it is
    // strictly older than the edge, and the index read is `.gt(windowStart)`,
    // so the exact-boundary row is excluded — the block has expired.
    await seedPendingCharge(t, Date.now() - PENDING_PAYMENT_BLOCK_WINDOW_MS);

    const blocking = await t.query(internal.payments.billing.getBlockingPendingPayment, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toBeNull();
  });

  test("a pending payment well inside the window still blocks the same tier group", async () => {
    const t = convexTest(schema, modules);
    await seedPendingCharge(t, Date.now() - PENDING_PAYMENT_BLOCK_WINDOW_MS + 60_000);

    const blocking = await t.query(internal.payments.billing.getBlockingPendingPayment, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #5380 Medium-8: cancelled paid-through period-end boundary (checkout guard)
// ---------------------------------------------------------------------------

describe("cancelled paid-through boundary at checkout", () => {
  async function seedCancelledSub(t: ReturnType<typeof convexTest>, currentPeriodEnd: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_cancelled_boundary",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "cancelled",
        currentPeriodStart: currentPeriodEnd - 30 * 86_400_000,
        currentPeriodEnd,
        rawPayload: {},
        updatedAt: currentPeriodEnd - 86_400_000,
      });
    });
  }

  test("a cancellation whose period ends exactly NOW no longer blocks re-subscribing", async () => {
    const t = convexTest(schema, modules);
    // The guard requires `currentPeriodEnd > now` to block; the equal-boundary
    // row (strictly older by query time) must fall on the unblocked side.
    await seedCancelledSub(t, Date.now());

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toBeNull();
  });

  test("a cancellation still paid-through blocks checkout in the same family", async () => {
    const t = convexTest(schema, modules);
    await seedCancelledSub(t, Date.now() + 5 * 60_000);

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toMatchObject({ status: "cancelled" });
  });
});
