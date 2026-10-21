import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");
const NOW = 1_800_000_000_000;
const END = NOW + 30 * 86_400_000;
const USER = "synthetic_attribution_owner";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function payload(type: string, customer = true) {
  return { type, data: {
    subscription_id: "sub_attribution",
    ...(!type.startsWith("payment.") ? { product_id: PRODUCT_CATALOG.api_business.dodoProductId! } : {}),
    payment_id: "pay_attribution", status: type === "payment.failed" ? "failed" : "active",
    previous_billing_date: new Date(NOW).toISOString(), next_billing_date: new Date(END).toISOString(),
    ...(customer ? { customer: { customer_id: "cus_attribution", email: "buyer@example.test" } } : {}),
    total_amount: 29900, currency: "USD", metadata: {},
  } };
}

async function capture(t: ReturnType<typeof convexTest>, type: string, customer = true) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: "wh_attribution", eventType: type, rawPayload: payload(type, customer), timestamp: NOW,
  });
  return t.run(async (ctx) => (await ctx.db.query("unattributedPaymentEvents").unique())!._id);
}

async function state(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    incidents: await ctx.db.query("unattributedPaymentEvents").collect(),
    webhooks: await ctx.db.query("webhookEvents").collect(),
    customers: await ctx.db.query("customers").collect(),
    subscriptions: await ctx.db.query("subscriptions").collect(),
    entitlements: await ctx.db.query("entitlements").collect(),
    payments: await ctx.db.query("paymentEvents").collect(),
  }));
}

async function seedSubscription(t: ReturnType<typeof convexTest>, userId = USER) {
  await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId, dodoSubscriptionId: "sub_attribution", dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!,
    planKey: "api_business", status: "active", currentPeriodStart: NOW, currentPeriodEnd: END,
    rawPayload: {}, updatedAt: NOW,
  }));
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId });
}

test.each(["subscription.active", "subscription.updated"])("%s without customer identity stays unresolved and retryable", async (type) => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, type, false);
  const before = await state(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
      .rejects.toThrow("customer identity");
    expect(await state(t)).toEqual(before);
  }
});

test("paid audit alone cannot resolve; a matching fulfilled subscription enables exactly one repair", async () => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, "payment.succeeded");
  const before = await state(t);
  await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .rejects.toThrow("subscription access");
  expect(await state(t)).toEqual(before);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId: USER, dodoCustomerId: "cus_attribution", email: "buyer@example.test",
    normalizedEmail: "buyer@example.test", createdAt: NOW, updatedAt: NOW,
  }));
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: "wh_subscription_fulfilled", eventType: "subscription.active",
    rawPayload: payload("subscription.active"), timestamp: NOW,
  });
  const result = await t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER });
  expect(result).toMatchObject({ attributedTo: USER, outcome: "subscription_access_confirmed" });
  const after = await state(t);
  expect(after.incidents[0].resolved).toBe(true);
  expect(after.payments).toHaveLength(1);
  expect(after.payments[0]).toMatchObject({ userId: USER, status: "succeeded" });
  await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .rejects.toThrow("already attributed");
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: "wh_attribution", eventType: "payment.succeeded", rawPayload: payload("payment.succeeded"), timestamp: NOW,
  });
  expect(await state(t)).toEqual(after);
});

test("subscription-first ownership cannot resolve to a different operator target", async () => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, "payment.succeeded");
  await seedSubscription(t, "different_owner");
  const before = await state(t);
  await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .rejects.toThrow();
  expect(await state(t)).toEqual(before);
});

test("a legacy comp freeze is not proof of the purchased Business access", async () => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, "subscription.active");
  await t.run((ctx) => ctx.db.insert("entitlements", {
    userId: USER, planKey: "pro_monthly", features: getFeaturesForPlan("pro_monthly"),
    validUntil: END, compUntil: END, updatedAt: NOW,
  }));
  const before = await state(t);
  await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .rejects.toThrow("subscription access");
  expect(await state(t)).toEqual(before);
});

test("uncharged failure explicitly resolves only payment audit attribution", async () => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, "payment.failed");
  expect(await t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .toMatchObject({ attributedTo: USER, outcome: "audit_only" });
  const after = await state(t);
  expect(after.payments[0]).toMatchObject({ userId: USER, status: "failed" });
  expect(after.incidents[0].resolved).toBe(true);
  expect(after.entitlements).toHaveLength(0);
});

test.each([false, true])("a lower-tier fulfillment cannot close a Business payment (matching product ID: %s)", async (matchingProductId) => {
  const t = convexTest(schema, modules);
  const rowId = await capture(t, "payment.succeeded");
  await t.run((ctx) => ctx.db.patch(rowId, { dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId! }));
  await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId: USER, dodoSubscriptionId: "sub_attribution",
    dodoProductId: PRODUCT_CATALOG[matchingProductId ? "api_business" : "pro_monthly"].dodoProductId!,
    planKey: "pro_monthly", status: "active", currentPeriodStart: NOW, currentPeriodEnd: END,
    rawPayload: {}, updatedAt: NOW,
  }));
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: USER });
  const before = await state(t);
  await expect(t.mutation(internal.payments.webhookMutations.attributeUnattributedPayment, { rowId, userId: USER }))
    .rejects.toThrow("purchased product");
  expect(await state(t)).toEqual(before);
});
