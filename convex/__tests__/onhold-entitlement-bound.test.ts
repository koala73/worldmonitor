import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import schema from "../schema";
import { internal } from "../_generated/api";
import { isCoveringAt } from "../payments/subscriptionHelpers";

const modules = import.meta.glob("../**/*.ts");

// Timeline: activation on 2026-03-21, paid through 2026-04-21, hold events
// before and after the paid-through boundary.
const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();
const PERIOD_END = new Date("2026-04-21T00:00:00Z").getTime();
const AFTER_PERIOD_END = new Date("2026-05-01T00:00:00Z").getTime();
const NEW_PERIOD_END = new Date("2026-06-01T00:00:00Z").getTime();

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

async function seedProductPlan(
  t: ReturnType<typeof convexTest>,
  dodoProductId: string,
  planKey: string,
  displayName: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId,
      planKey,
      displayName,
      isActive: true,
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
  await t.run(async (ctx) => {
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", "cust_test_001"))
      .first();
    if (!existingCustomer) {
      await ctx.db.insert("customers", {
        userId: "test-user-001",
        dodoCustomerId: "cust_test_001",
        email: "test@example.com",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });

  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId,
    eventType,
    rawPayload,
    timestamp,
  });
}

async function getEntitlement(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    return ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", "test-user-001"))
      .first();
  });
}

// ---------------------------------------------------------------------------
// Unit: the coverage predicate itself (GHSA-hw94-8c4h-m9qp)
// ---------------------------------------------------------------------------

describe("isCoveringAt on_hold bound (GHSA-hw94-8c4h-m9qp)", () => {
  const at = BASE_TIMESTAMP;

  test("active covers even past currentPeriodEnd (late-renewal tolerance)", () => {
    expect(isCoveringAt({ status: "active", currentPeriodEnd: at - 1 }, at)).toBe(true);
  });

  test("on_hold covers only while paid-through", () => {
    expect(isCoveringAt({ status: "on_hold", currentPeriodEnd: at + 1 }, at)).toBe(true);
    expect(isCoveringAt({ status: "on_hold", currentPeriodEnd: at }, at)).toBe(false);
    expect(isCoveringAt({ status: "on_hold", currentPeriodEnd: at - 1 }, at)).toBe(false);
  });

  test("cancelled bound is unchanged", () => {
    expect(isCoveringAt({ status: "cancelled", currentPeriodEnd: at + 1 }, at)).toBe(true);
    expect(isCoveringAt({ status: "cancelled", currentPeriodEnd: at - 1 }, at)).toBe(false);
  });

  test("expired never covers", () => {
    expect(isCoveringAt({ status: "expired", currentPeriodEnd: at + 1 }, at)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook flows
// ---------------------------------------------------------------------------

describe("on_hold entitlement lifecycle (GHSA-hw94-8c4h-m9qp)", () => {
  test("paid-through hold keeps the paid plan clamped to currentPeriodEnd", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    await processEvent(t, "wh_hold_1", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_hold_2",
      "subscription.on_hold",
      makeSubscriptionPayload({ status: "on_hold" }),
      BASE_TIMESTAMP + 1000,
    );

    const entitlement = await getEntitlement(t);
    // Not revoked (business policy), but pinned to the paid-through boundary —
    // never extendable past what the customer actually paid for.
    expect(entitlement?.planKey).toBe("pro_monthly");
    expect(entitlement?.validUntil).toBe(PERIOD_END);
  });

  test("a hold event arriving after the paid-through boundary downgrades to free", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    await processEvent(t, "wh_hold_3", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_hold_4",
      "subscription.on_hold",
      makeSubscriptionPayload({ status: "on_hold" }),
      BASE_TIMESTAMP + 1000,
    );
    // Dodo can replay/retry hold events indefinitely; one lands after the
    // period the customer paid for has ended.
    await processEvent(
      t,
      "wh_hold_5",
      "subscription.on_hold",
      makeSubscriptionPayload({ status: "on_hold" }),
      AFTER_PERIOD_END,
    );

    const entitlement = await getEntitlement(t);
    expect(entitlement?.planKey).toBe("free");
    expect(entitlement?.validUntil).toBe(AFTER_PERIOD_END);

    // The dunning episode anchor must not move on the repeat hold event.
    const sub = await t.run(async (ctx) => {
      return ctx.db
        .query("subscriptions")
        .withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_test_001"))
        .unique();
    });
    expect(sub?.onHoldAt).toBe(BASE_TIMESTAMP + 1000);
  });

  test("a stale higher-tier hold cannot clobber a later paid subscription", async () => {
    const t = convexTest(schema, modules);
    await seedProductPlan(t, "pdt_test_enterprise", "enterprise", "Enterprise");
    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Enterprise sub (tier 3) activates, then goes on hold within its period.
    await processEvent(
      t,
      "wh_clobber_1",
      "subscription.active",
      makeSubscriptionPayload({ subscription_id: "sub_ent_001", product_id: "pdt_test_enterprise" }),
      BASE_TIMESTAMP,
    );
    await processEvent(
      t,
      "wh_clobber_2",
      "subscription.on_hold",
      makeSubscriptionPayload({
        subscription_id: "sub_ent_001",
        product_id: "pdt_test_enterprise",
        status: "on_hold",
      }),
      BASE_TIMESTAMP + 1000,
    );

    // After the enterprise paid-through boundary, the user buys Pro. With the
    // pre-fix unbounded on_hold coverage, the dead enterprise hold (higher
    // tier) outranked the new sub in every recompute and wrote an
    // already-expired enterprise entitlement — denying a paying customer.
    await processEvent(
      t,
      "wh_clobber_3",
      "subscription.active",
      makeSubscriptionPayload({
        subscription_id: "sub_pro_001",
        previous_billing_date: "2026-05-01T00:00:00Z",
        next_billing_date: "2026-06-01T00:00:00Z",
      }),
      AFTER_PERIOD_END,
    );

    const entitlement = await getEntitlement(t);
    expect(entitlement?.planKey).toBe("pro_monthly");
    expect(entitlement?.validUntil).toBe(NEW_PERIOD_END);
  });
});

// ---------------------------------------------------------------------------
// Checkout re-subscribe lockout
// ---------------------------------------------------------------------------

describe("checkout blocking for on_hold subscriptions", () => {
  test("a hold past its paid-through boundary no longer blocks re-subscribing", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_stale_hold",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "on_hold",
        currentPeriodStart: now - 60 * 86400000,
        currentPeriodEnd: now - 30 * 86400000,
        rawPayload: {},
        updatedAt: now - 30 * 86400000,
      });
    });

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
    });
    expect(blocking).toBeNull();
  });

  test("a paid-through hold still blocks duplicate checkout in the same family", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_live_hold",
        dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!,
        planKey: "pro_monthly",
        status: "on_hold",
        currentPeriodStart: now - 86400000,
        currentPeriodEnd: now + 7 * 86400000,
        rawPayload: {},
        updatedAt: now,
      });
    });

    const blocking = await t.query(internal.payments.billing.getCheckoutBlockingSubscription, {
      userId: "test-user-001",
      productId: PRODUCT_CATALOG.pro_annual.dodoProductId!,
    });
    expect(blocking).toMatchObject({ planKey: "pro_monthly", status: "on_hold" });
  });
});
