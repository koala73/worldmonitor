import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

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

function makePaymentPayload(
  eventType:
    | "payment.succeeded"
    | "payment.failed"
    | "payment.processing"
    | "payment.cancelled",
  overrides: Record<string, unknown> = {},
) {
  return {
    type: eventType,
    business_id: "biz_test",
    timestamp: "2026-03-21T10:00:00Z",
    data: {
      payload_type: "Payment",
      payment_id: "pay_test_001",
      subscription_id: "sub_test_001",
      total_amount: 1999,
      currency: "USD",
      customer: {
        customer_id: "cust_test_001",
        email: "test@example.com",
        name: "Test User",
      },
      metadata: { wm_user_id: "test-user-001" },
      ...overrides,
    },
  };
}

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();

// ---------------------------------------------------------------------------
// Helper: seed a productPlans mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: call processWebhookEvent
// ---------------------------------------------------------------------------

async function processEvent(
  t: ReturnType<typeof convexTest>,
  webhookId: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
  timestamp: number,
) {
  const payloadData = (rawPayload.data ?? {}) as {
    customer?: { customer_id?: string; email?: string };
    metadata?: { wm_user_id?: string };
  };
  const dodoCustomerId = payloadData.customer?.customer_id ?? "cust_test_001";
  const userId = payloadData.metadata?.wm_user_id ?? "test-user-001";
  const email = payloadData.customer?.email ?? "test@example.com";

  await t.run(async (ctx) => {
    const existingCustomer = await ctx.db
      .query("customers")
      .withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", dodoCustomerId))
      .first();
    if (!existingCustomer) {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId,
        email,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });

  await t.mutation(
    internal.payments.webhookMutations.processWebhookEvent,
    {
      webhookId,
      eventType,
      rawPayload,
      timestamp,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhook processWebhookEvent", () => {
  test("subscription.active creates new subscription", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    const payload = makeSubscriptionPayload();
    await processEvent(t, "wh_001", "subscription.active", payload, BASE_TIMESTAMP);

    // Assert subscription record
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
    expect(subs[0].userId).toBe("test-user-001");
    expect(subs[0].planKey).toBe("pro_monthly");
    expect(subs[0].dodoSubscriptionId).toBe("sub_test_001");
    expect(subs[0].currentPeriodStart).toBe(
      new Date("2026-03-21T00:00:00Z").getTime(),
    );
    expect(subs[0].currentPeriodEnd).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );

    // Assert entitlements record
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("pro_monthly");
    expect(entitlements[0].features).toMatchObject({
      maxDashboards: 10,
      apiAccess: false,
    });

    // Assert webhookEvents record
    const events = await t.run(async (ctx) => {
      return ctx.db.query("webhookEvents").collect();
    });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("processed");
    expect(events[0].eventType).toBe("subscription.active");
  });

  test("subscription.active reactivates existing cancelled subscription", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Seed a cancelled subscription manually
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "cancelled",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP,
        cancelledAt: BASE_TIMESTAMP - 3600000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    const payload = makeSubscriptionPayload();
    await processEvent(t, "wh_002", "subscription.active", payload, BASE_TIMESTAMP);

    // Assert only 1 subscription (updated, not duplicated)
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
  });

  test("subscription.renewed extends billing period", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription via subscription.active event
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_003",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Renew with new billing dates
    const renewPayload = makeSubscriptionPayload({
      previous_billing_date: "2026-04-21T00:00:00Z",
      next_billing_date: "2026-05-21T00:00:00Z",
    });
    await processEvent(
      t,
      "wh_004",
      "subscription.renewed",
      renewPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].currentPeriodStart).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );
    expect(subs[0].currentPeriodEnd).toBe(
      new Date("2026-05-21T00:00:00Z").getTime(),
    );

    // Assert entitlements validUntil extended
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].validUntil).toBe(
      new Date("2026-05-21T00:00:00Z").getTime(),
    );
  });

  test("subscription.on_hold marks subscription at-risk without revoking entitlements", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_005",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Put on hold
    const onHoldPayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_006",
      "subscription.on_hold",
      onHoldPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("on_hold");

    // Entitlements still exist (NOT revoked)
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("pro_monthly");
  });

  test("subscription.cancelled preserves entitlements until period end", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create active subscription
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_007",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Cancel
    const cancelPayload = makeSubscriptionPayload({
      cancelled_at: "2026-03-25T10:00:00Z",
    });
    await processEvent(
      t,
      "wh_008",
      "subscription.cancelled",
      cancelPayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("cancelled");
    expect(subs[0].cancelledAt).toBe(
      new Date("2026-03-25T10:00:00Z").getTime(),
    );

    // Entitlements still exist with original validUntil (NOT revoked early)
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].validUntil).toBe(
      new Date("2026-04-21T00:00:00Z").getTime(),
    );
  });

  test("subscription.plan_changed updates product and entitlements", async () => {
    const t = convexTest(schema, modules);

    // Seed TWO product plans
    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await seedProductPlan(t, "pdt_test_api", "api_starter", "API Starter");

    // Create active subscription with pro_monthly
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_009",
      "subscription.active",
      activatePayload,
      BASE_TIMESTAMP,
    );

    // Change plan to api_starter
    const planChangePayload = makeSubscriptionPayload({
      product_id: "pdt_test_api",
    });
    await processEvent(
      t,
      "wh_010",
      "subscription.plan_changed",
      planChangePayload,
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].dodoProductId).toBe("pdt_test_api");
    expect(subs[0].planKey).toBe("api_starter");

    // Entitlements should match api_starter features
    const entitlements = await t.run(async (ctx) => {
      return ctx.db.query("entitlements").collect();
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("api_starter");
    expect(entitlements[0].features).toMatchObject({
      apiAccess: true,
      apiRateLimit: 60,
      maxDashboards: 25,
    });
  });

  test("payment.succeeded creates audit record", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.succeeded");
    await processEvent(
      t,
      "wh_011",
      "payment.succeeded",
      payload,
      BASE_TIMESTAMP,
    );

    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("succeeded");
    expect(paymentEvents[0].amount).toBe(1999);
    expect(paymentEvents[0].currency).toBe("USD");
    expect(paymentEvents[0].type).toBe("charge");
  });

  test("payment.failed creates audit record", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.failed");
    await processEvent(
      t,
      "wh_012",
      "payment.failed",
      payload,
      BASE_TIMESTAMP,
    );

    const paymentEvents = await t.run(async (ctx) => {
      return ctx.db.query("paymentEvents").collect();
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("failed");
  });

  // #4436 — Dodo delivers the 3DS/SCA-pending state as a `payment.processing`
  // event whose payload `data.status` (IntentStatus) is `requires_customer_action`
  // (`payment.requires_customer_action` is NOT a Dodo event type). Before the
  // fix `payment.processing` hit the `default` branch and was silently dropped,
  // so the app had no pending-payment signal for duplicate-prevention (#4438) /
  // reconciliation (#4439).
  test.each([
    ["requires_customer_action", "requires_customer_action"],
    ["processing", "processing"],
  ] as const)(
    "payment.processing with data.status=%s persists status %s",
    async (payloadStatus, expectedStatus) => {
      const t = convexTest(schema, modules);

      const payload = makePaymentPayload("payment.processing", { status: payloadStatus });
      await processEvent(t, `wh_proc_${expectedStatus}`, "payment.processing", payload, BASE_TIMESTAMP);

      const paymentEvents = await t.run(async (ctx) =>
        ctx.db.query("paymentEvents").collect(),
      );
      expect(paymentEvents).toHaveLength(1);
      expect(paymentEvents[0].status).toBe(expectedStatus);
      expect(paymentEvents[0].type).toBe("charge");
      expect(paymentEvents[0].dodoPaymentId).toBe("pay_test_001");
    },
  );

  test("payment.cancelled persists a cancelled paymentEvents row", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.cancelled");
    await processEvent(t, "wh_pay_cancelled", "payment.cancelled", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("cancelled");
  });

  // #4436 correction (validated): dedup is by webhookId ONLY. A later DISTINCT
  // transition (new webhookId, same payment_id) must still process — it is not
  // blocked by the earlier 3DS-pending webhook being recorded.
  test("3DS-pending (payment.processing) then a distinct succeeded webhook both persist", async () => {
    const t = convexTest(schema, modules);

    await processEvent(
      t,
      "wh_3ds_pending",
      "payment.processing",
      makePaymentPayload("payment.processing", { status: "requires_customer_action" }),
      BASE_TIMESTAMP,
    );
    await processEvent(
      t,
      "wh_3ds_succeeded",
      "payment.succeeded",
      makePaymentPayload("payment.succeeded"),
      BASE_TIMESTAMP + 5000,
    );

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db
        .query("paymentEvents")
        .withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_test_001"))
        .collect(),
    );
    expect(paymentEvents.map((e) => e.status).sort()).toEqual([
      "requires_customer_action",
      "succeeded",
    ]);

    const webhookEvents = await t.run(async (ctx) =>
      ctx.db.query("webhookEvents").collect(),
    );
    expect(webhookEvents).toHaveLength(2);
  });

  test("duplicate webhook-id is deduplicated", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    const payload = makeSubscriptionPayload();

    // Call twice with the same webhookId
    await processEvent(t, "wh_dup", "subscription.active", payload, BASE_TIMESTAMP);
    await processEvent(
      t,
      "wh_dup",
      "subscription.active",
      payload,
      BASE_TIMESTAMP + 1000,
    );

    // Only 1 webhookEvents record
    const events = await t.run(async (ctx) => {
      return ctx.db.query("webhookEvents").collect();
    });
    expect(events).toHaveLength(1);

    // Only 1 subscription record
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
  });

  test.each([
    ["dispute.opened", "dispute_opened"],
    ["dispute.won", "dispute_won"],
    ["dispute.lost", "dispute_lost"],
    ["dispute.closed", "dispute_closed"],
  ] as const)("%s maps to %s status", async (eventType, expectedStatus) => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.succeeded");
    const webhookId = `wh_${eventType.replace(".", "_")}`;
    await processEvent(t, webhookId, eventType, payload, BASE_TIMESTAMP);

    const events = await t.run(async (ctx) => ctx.db.query("paymentEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(expectedStatus);
  });

  test("out-of-order events are rejected", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    // Create subscription with timestamp 1000
    const activatePayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_013",
      "subscription.active",
      activatePayload,
      1000,
    );

    // Try to put on_hold with timestamp 500 (older)
    const onHoldPayload = makeSubscriptionPayload();
    await processEvent(
      t,
      "wh_014",
      "subscription.on_hold",
      onHoldPayload,
      500,
    );

    // Subscription status should still be "active" (older event ignored)
    const subs = await t.run(async (ctx) => {
      return ctx.db.query("subscriptions").collect();
    });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("active");
  });
});
