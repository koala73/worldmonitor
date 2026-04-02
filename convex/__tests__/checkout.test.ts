import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = new Date("2026-03-21T10:00:00Z").getTime();
const TEST_USER_ID = "user_checkout_test_001";
const TEST_CUSTOMER_ID = "cust_checkout_e2e";

/**
 * Helper to call the seedProductPlans mutation and return plans list.
 */
async function seedAndListPlans(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.payments.seedProductPlans.seedProductPlans, {});
  return t.query(api.payments.seedProductPlans.listProductPlans, {});
}

/**
 * Helper to seed a customer record that maps dodoCustomerId to userId.
 * This mirrors the production flow where checkout metadata or a prior
 * subscription.active event populates the customers table.
 */
async function seedCustomer(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("customers", {
      userId: TEST_USER_ID,
      dodoCustomerId: TEST_CUSTOMER_ID,
      email: "test@example.com",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });
  });
}

/**
 * Helper to simulate a subscription webhook event.
 * The seeded customer mapping mirrors production renewals where Dodo
 * customer ownership can be resolved even when metadata is absent.
 */
async function simulateSubscriptionWebhook(
  t: ReturnType<typeof convexTest>,
  opts: {
    webhookId: string;
    subscriptionId: string;
    productId: string;
    customerId?: string;
    previousBillingDate?: string;
    nextBillingDate?: string;
    timestamp?: number;
  },
) {
  await t.mutation(
    internal.payments.webhookMutations.processWebhookEvent,
    {
      webhookId: opts.webhookId,
      eventType: "subscription.active",
      rawPayload: {
        type: "subscription.active",
        data: {
          subscription_id: opts.subscriptionId,
          product_id: opts.productId,
          customer: {
            customer_id: opts.customerId ?? TEST_CUSTOMER_ID,
          },
          previous_billing_date:
            opts.previousBillingDate ?? new Date().toISOString(),
          next_billing_date:
            opts.nextBillingDate ??
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          metadata: {},
        },
      },
      timestamp: opts.timestamp ?? BASE_TIMESTAMP,
    },
  );
}

// ---------------------------------------------------------------------------
// E2E Contract Tests: Checkout -> Webhook -> Entitlements
// ---------------------------------------------------------------------------

describe("E2E checkout-to-entitlement contract", () => {
  test("product plans can be seeded and queried", async () => {
    const t = convexTest(schema, modules);

    const plans = await seedAndListPlans(t);

    // Should have at least 5 plans: pro_monthly, pro_annual, api_starter, api_business, enterprise
    expect(plans.length).toBeGreaterThanOrEqual(5);

    // Verify key plans exist
    const proMonthly = plans.find((p) => p.planKey === "pro_monthly");
    expect(proMonthly).toBeDefined();
    expect(proMonthly!.displayName).toBe("Pro Monthly");

    const proAnnual = plans.find((p) => p.planKey === "pro_annual");
    expect(proAnnual).toBeDefined();
    expect(proAnnual!.displayName).toBe("Pro Annual");

    const apiStarter = plans.find((p) => p.planKey === "api_starter");
    expect(apiStarter).toBeDefined();

    const apiBusiness = plans.find((p) => p.planKey === "api_business");
    expect(apiBusiness).toBeDefined();

    const enterprise = plans.find((p) => p.planKey === "enterprise");
    expect(enterprise).toBeDefined();
  });

  test("checkout -> subscription.active webhook -> entitlements granted for pro_monthly", async () => {
    const t = convexTest(schema, modules);

    // Step 1: Seed product plans + customer mapping
    const plans = await seedAndListPlans(t);
    await seedCustomer(t);
    const proMonthly = plans.find((p) => p.planKey === "pro_monthly");
    expect(proMonthly).toBeDefined();

    // Step 2: Simulate subscription.active webhook (with wm_user_id metadata)
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await simulateSubscriptionWebhook(t, {
      webhookId: "wh_checkout_e2e_001",
      subscriptionId: "sub_checkout_e2e_001",
      productId: proMonthly!.dodoProductId,
      nextBillingDate: futureDate.toISOString(),
    });

    // Step 3: Query entitlements for the real user (not fallback)
    const entitlements = await t.query(
      internal.entitlements.getEntitlementsByUserId,
      { userId: TEST_USER_ID },
    );

    // Step 4: Assert pro_monthly entitlements
    expect(entitlements.planKey).toBe("pro_monthly");
    expect(entitlements.features.tier).toBe(1);
    expect(entitlements.features.apiAccess).toBe(false);
    expect(entitlements.features.maxDashboards).toBe(10);
  });

  test("checkout -> subscription.active webhook -> entitlements granted for api_starter", async () => {
    const t = convexTest(schema, modules);

    // Step 1: Seed product plans + customer mapping
    const plans = await seedAndListPlans(t);
    await seedCustomer(t);
    const apiStarter = plans.find((p) => p.planKey === "api_starter");
    expect(apiStarter).toBeDefined();

    // Step 2: Simulate subscription.active webhook
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await simulateSubscriptionWebhook(t, {
      webhookId: "wh_checkout_e2e_002",
      subscriptionId: "sub_checkout_e2e_002",
      productId: apiStarter!.dodoProductId,
      nextBillingDate: futureDate.toISOString(),
    });

    // Step 3: Query entitlements
    const entitlements = await t.query(
      internal.entitlements.getEntitlementsByUserId,
      { userId: TEST_USER_ID },
    );

    // Step 4: Assert api_starter entitlements
    expect(entitlements.planKey).toBe("api_starter");
    expect(entitlements.features.tier).toBe(2);
    expect(entitlements.features.apiAccess).toBe(true);
    expect(entitlements.features.apiRateLimit).toBeGreaterThan(0);
    expect(entitlements.features.apiRateLimit).toBe(60);
    expect(entitlements.features.maxDashboards).toBe(25);
  });

  test("expired entitlements fall back to free tier", async () => {
    const t = convexTest(schema, modules);

    // Step 1: Seed product plans + customer mapping
    const plans = await seedAndListPlans(t);
    await seedCustomer(t);
    const proMonthly = plans.find((p) => p.planKey === "pro_monthly");
    expect(proMonthly).toBeDefined();

    // Step 2: Simulate webhook with billing dates both in the past (expired)
    const pastStart = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const pastEnd = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    await simulateSubscriptionWebhook(t, {
      webhookId: "wh_checkout_e2e_003",
      subscriptionId: "sub_checkout_e2e_003",
      productId: proMonthly!.dodoProductId,
      previousBillingDate: pastStart.toISOString(),
      nextBillingDate: pastEnd.toISOString(),
    });

    // Step 3: Query entitlements -- should return free tier (expired)
    const entitlements = await t.query(
      internal.entitlements.getEntitlementsByUserId,
      { userId: TEST_USER_ID },
    );

    // Step 4: Assert free tier defaults
    expect(entitlements.planKey).toBe("free");
    expect(entitlements.features.tier).toBe(0);
    expect(entitlements.features.apiAccess).toBe(false);
    expect(entitlements.validUntil).toBe(0);
  });
});
