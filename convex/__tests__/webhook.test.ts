import { convexTest } from "convex-test";
import { afterEach, expect, test, describe, vi } from "vitest";
import { getFeaturesForPlan } from "../lib/entitlements";
import { signUserId } from "../lib/identitySigning";
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
const SIGNING_SECRET = "test-dodo-identity-signing-secret";

afterEach(() => {
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RESEND_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  test("subscription.active reactivation sends a welcome-back email", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(t, "wh_002_reactivation", "subscription.active", makeSubscriptionPayload(), BASE_TIMESTAMP);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
        html: string;
      });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["test@example.com"]);
    expect(sends[0]?.subject).toContain("Welcome back");
    expect(sends[0]?.html).toContain("subscription is active again");
  });

  test("new-checkout reactivation uses prior lapsed history instead of a new-subscriber alert", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_old_expired",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
    });

    await processEvent(
      t,
      "wh_new_subscription_reactivation",
      "subscription.active",
      makeSubscriptionPayload({ subscription_id: "sub_new_reactivated" }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
        to: string[];
        subject: string;
      });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["test@example.com"]);
    expect(sends[0]?.subject).toContain("Welcome back");
  });

  test("a covering sibling prevents old lapsed history from forcing welcome-back mail", async () => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_old_expired_with_cover",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "expired",
        currentPeriodStart: BASE_TIMESTAMP - 31 * 86400000,
        currentPeriodEnd: BASE_TIMESTAMP - 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 86400000,
      });
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_covering_sibling",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await processEvent(
      t,
      "wh_new_subscription_with_covering_sibling",
      "subscription.active",
      makeSubscriptionPayload({ subscription_id: "sub_new_while_covered" }),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const subjects = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.resend.com"))
      .map(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { subject: string };
        return body.subject;
      });

    expect(subjects).toHaveLength(2);
    expect(subjects.some((subject) => subject.startsWith("Welcome to World Monitor"))).toBe(true);
    expect(subjects.some((subject) => subject.startsWith("[WM] New User Subscribed"))).toBe(true);
    expect(subjects.every((subject) => !subject.includes("Welcome back"))).toBe(true);
  });

  test.each([
    ["on_hold", BASE_TIMESTAMP + 7 * 86400000],
    ["cancelled", BASE_TIMESTAMP],
  ] as const)("subscription.active from non-lapsed %s remains email-silent", async (status, currentPeriodEnd) => {
    vi.useFakeTimers();
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "test-user-001",
        dodoSubscriptionId: "sub_test_001",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status,
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await processEvent(
      t,
      `wh_non_lapsed_${status}`,
      "subscription.active",
      makeSubscriptionPayload(),
      BASE_TIMESTAMP,
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).not.toHaveBeenCalled();
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

  test("subscription.plan_changed api_starter -> api_business resolves the Business entitlement (#4634)", async () => {
    const t = convexTest(schema, modules);

    await seedProductPlan(t, "pdt_test_api_starter", "api_starter", "API Starter");
    await seedProductPlan(t, "pdt_test_api_business", "api_business", "API Business");

    // Active on Starter, then the Dodo collection upgrade fires plan_changed.
    await processEvent(
      t,
      "wh_up_01",
      "subscription.active",
      makeSubscriptionPayload({ product_id: "pdt_test_api_starter" }),
      BASE_TIMESTAMP,
    );
    await processEvent(
      t,
      "wh_up_02",
      "subscription.plan_changed",
      makeSubscriptionPayload({ product_id: "pdt_test_api_business" }),
      BASE_TIMESTAMP + 1000,
    );

    const subs = await t.run((ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(1);
    expect(subs[0].planKey).toBe("api_business");

    const entitlements = await t.run((ctx) => ctx.db.query("entitlements").collect());
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].planKey).toBe("api_business");
    expect(entitlements[0].features).toMatchObject({ apiAccess: true, apiRateLimit: 300 });
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

  // #5056 — entitlement lifecycle integrity across claim, active webhook, and dispute races.
  test("subscription.active keeps claimed real owner when stale signed anon metadata arrives", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const realUserId = "user_claimed_subscription";
    const anonId = "22222222-2222-4222-8222-222222222222";
    const customerId = "cust_claimed_001";
    const subscriptionId = "sub_claimed_001";
    const anonSig = await signUserId(anonId);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: realUserId,
        dodoSubscriptionId: subscriptionId,
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP,
        dodoCustomerId: customerId,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId: realUserId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_claimed_stale_anon",
      eventType: "subscription.active",
      rawPayload: makeSubscriptionPayload({
        subscription_id: subscriptionId,
        customer: {
          customer_id: customerId,
          email: "claimed@example.com",
          name: "Claimed User",
        },
        metadata: { wm_user_id: anonId, wm_user_id_sig: anonSig },
        next_billing_date: "2026-05-21T00:00:00Z",
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, customer, realEntitlement, anonEntitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", subscriptionId)).unique(),
        ctx.db.query("customers").withIndex("by_dodoCustomerId", (q) => q.eq("dodoCustomerId", customerId)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", realUserId)).first(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", anonId)).first(),
      ]);
      return { sub, customer, realEntitlement, anonEntitlement };
    });
    expect(rows.sub?.userId).toBe(realUserId);
    expect(rows.customer?.userId).toBe(realUserId);
    expect(rows.realEntitlement?.planKey).toBe("pro_monthly");
    expect(rows.realEntitlement?.validUntil).toBe(new Date("2026-05-21T00:00:00Z").getTime());
    expect(rows.anonEntitlement).toBeNull();
  });

  test("subscription.active uses signed real metadata for a new sub even when the Dodo customer row exists", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const previousUserId = "user_existing_customer";
    const newUserId = "user_new_signed_checkout";
    const customerId = "cust_shared_real";
    const subscriptionId = "sub_new_signed_real";
    const userSig = await signUserId(newUserId);

    await seedProductPlan(t, "pdt_test_pro", "pro_monthly", "Pro Monthly");
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: previousUserId,
        dodoCustomerId: customerId,
        email: "shared@example.com",
        normalizedEmail: "shared@example.com",
        createdAt: BASE_TIMESTAMP - 1000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_new_signed_real_shared_customer",
      eventType: "subscription.active",
      rawPayload: makeSubscriptionPayload({
        subscription_id: subscriptionId,
        customer: { customer_id: customerId, email: "shared@example.com", name: "Shared Customer" },
        metadata: { wm_user_id: newUserId, wm_user_id_sig: userSig },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", subscriptionId)).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", newUserId)).first(),
      ]);
      return { sub, entitlement };
    });
    expect(rows.sub?.userId).toBe(newUserId);
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
  });

  test("dispute.lost expires only the disputed subscription when another active subscription covers the user", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dispute_multi";

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId,
        dodoCustomerId: "cust_dispute_multi",
        email: "multi@example.com",
        normalizedEmail: "multi@example.com",
        createdAt: BASE_TIMESTAMP - 1000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_disputed_multi",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        dodoCustomerId: "cust_dispute_multi",
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_cover_multi",
        dodoProductId: "pdt_test_api",
        planKey: "api_starter",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 45 * 86400000,
        dodoCustomerId: "cust_dispute_multi",
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: BASE_TIMESTAMP + 30 * 86400000,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dispute_multi",
      eventType: "dispute.lost",
      rawPayload: makePaymentPayload("payment.succeeded", {
        payment_id: "pay_dispute_multi",
        subscription_id: "sub_disputed_multi",
        customer: { customer_id: "cust_dispute_multi", email: "multi@example.com" },
        metadata: { wm_user_id: userId },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [disputed, cover, entitlement, paymentEvent] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_disputed_multi")).unique(),
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_cover_multi")).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first(),
        ctx.db.query("paymentEvents").withIndex("by_dodoPaymentId", (q) => q.eq("dodoPaymentId", "pay_dispute_multi")).first(),
      ]);
      return { disputed, cover, entitlement, paymentEvent };
    });
    expect(rows.disputed?.status).toBe("expired");
    expect(rows.cover?.status).toBe("active");
    expect(rows.entitlement?.planKey).toBe("api_starter");
    expect(rows.entitlement?.validUntil).toBe(BASE_TIMESTAMP + 45 * 86400000);
    expect(rows.entitlement?.features.tier).toBe(getFeaturesForPlan("api_starter").tier);
    expect(rows.paymentEvent?.status).toBe("dispute_lost");
  });

  test("dispute.lost preserves a future complimentary entitlement floor", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dispute_comp";
    const compUntil = BASE_TIMESTAMP + 60 * 86400000;

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId,
        dodoSubscriptionId: "sub_dispute_comp",
        dodoProductId: "pdt_test_pro",
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: BASE_TIMESTAMP - 86400000,
        currentPeriodEnd: BASE_TIMESTAMP + 30 * 86400000,
        rawPayload: {},
        updatedAt: BASE_TIMESTAMP - 1000,
      });
      await ctx.db.insert("entitlements", {
        userId,
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: compUntil,
        compUntil,
        updatedAt: BASE_TIMESTAMP - 1000,
      });
    });

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_dispute_comp",
      eventType: "dispute.lost",
      rawPayload: makePaymentPayload("payment.succeeded", {
        payment_id: "pay_dispute_comp",
        subscription_id: "sub_dispute_comp",
        customer: { customer_id: "cust_dispute_comp", email: "comp@example.com" },
        metadata: { wm_user_id: userId },
      }),
      timestamp: BASE_TIMESTAMP + 1000,
    });

    const rows = await t.run(async (ctx) => {
      const [sub, entitlement] = await Promise.all([
        ctx.db.query("subscriptions").withIndex("by_dodoSubscriptionId", (q) => q.eq("dodoSubscriptionId", "sub_dispute_comp")).unique(),
        ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", userId)).first(),
      ]);
      return { sub, entitlement };
    });
    expect(rows.sub?.status).toBe("expired");
    expect(rows.entitlement?.planKey).toBe("pro_monthly");
    expect(rows.entitlement?.validUntil).toBe(compUntil);
    expect(rows.entitlement?.compUntil).toBe(compUntil);
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

  // #4438 — the pending-payment dedup guard needs to resolve a pending row to a
  // tier group. The session-create metadata bridge carries `wm_plan_key` the
  // same way it carries `wm_user_id`; the webhook persists it on the
  // `paymentEvents` row so a later checkout can read PRODUCT_CATALOG[planKey].
  test("payment.processing persists planKey from data.metadata.wm_plan_key", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.processing", {
      status: "requires_customer_action",
      metadata: { wm_user_id: "test-user-001", wm_plan_key: "pro_monthly" },
    });
    await processEvent(t, "wh_plankey_proc", "payment.processing", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].status).toBe("requires_customer_action");
    expect(paymentEvents[0].planKey).toBe("pro_monthly");
  });

  // Backward-compat: a session created before this shipped carries no
  // `wm_plan_key`. The row must still persist (planKey simply undefined) — never
  // throw — and the guard fails open for that legacy pending payment.
  test("payment.processing without wm_plan_key persists row with undefined planKey", async () => {
    const t = convexTest(schema, modules);

    const payload = makePaymentPayload("payment.processing", { status: "processing" });
    await processEvent(t, "wh_no_plankey", "payment.processing", payload, BASE_TIMESTAMP);

    const paymentEvents = await t.run(async (ctx) =>
      ctx.db.query("paymentEvents").collect(),
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].planKey).toBeUndefined();
  });

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
