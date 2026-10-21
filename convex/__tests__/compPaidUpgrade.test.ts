import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { signAnonClaimToken } from "../lib/identitySigning";

const modules = import.meta.glob("../**/*.ts");
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const USER = "synthetic_comp_upgrade";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: USER, planKey: "pro_monthly", days: 90,
  });
  await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId: USER, dodoSubscriptionId: "sub_comp_upgrade",
    dodoProductId: PRODUCT_CATALOG.pro_monthly.dodoProductId!, planKey: "pro_monthly",
    status: "active", currentPeriodStart: NOW - DAY, currentPeriodEnd: NOW + 30 * DAY,
    rawPayload: {}, updatedAt: NOW - 1000,
  }));
  return t;
}

async function read(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", USER)).unique());
}

test.each([NOW - DAY, NOW])("a live Pro grant replaces stale-active Business coverage ending at %s", async (end) => {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId: USER, dodoSubscriptionId: "sub_stale_business",
    dodoProductId: PRODUCT_CATALOG.api_business.dodoProductId!, planKey: "api_business",
    status: "active", currentPeriodStart: NOW - 31 * DAY, currentPeriodEnd: end,
    rawPayload: {}, updatedAt: NOW - DAY,
  }));
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: USER, planKey: "pro_monthly", days: 90,
  });
  expect(await read(t)).toMatchObject({ planKey: "pro_monthly", validUntil: NOW + 90 * DAY });
});

async function event(t: ReturnType<typeof convexTest>, type: string, planKey: string, at: number, end: number) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `comp_${type}_${at}`, eventType: type, timestamp: at,
    rawPayload: { type, data: {
      subscription_id: "sub_comp_upgrade", product_id: PRODUCT_CATALOG[planKey].dodoProductId!,
      previous_billing_date: new Date(NOW).toISOString(), next_billing_date: new Date(end).toISOString(),
    } },
  });
}

test("paid Business upgrade applies immediately, then expires back to the Pro comp floor", async () => {
  const t = await setup();
  await event(t, "subscription.plan_changed", "api_business", NOW + 1000, NOW + 30 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "api_business", compUntil: NOW + 90 * DAY });
  await event(t, "subscription.expired", "api_business", NOW + 2000, NOW + 30 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "pro_monthly", validUntil: NOW + 90 * DAY });
  vi.setSystemTime(NOW + 91 * DAY);
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: USER });
  expect(await read(t)).toMatchObject({ planKey: "free" });
});

test("paid renewal beyond comp expiry extends access immediately", async () => {
  const t = await setup();
  await event(t, "subscription.renewed", "pro_monthly", NOW + 1000, NOW + 120 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "pro_monthly", validUntil: NOW + 120 * DAY });
});

test("paid expiration keeps an unexpired Pro comp and comp expiry removes it", async () => {
  const t = await setup();
  await event(t, "subscription.expired", "pro_monthly", NOW + 1000, NOW + 30 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "pro_monthly", validUntil: NOW + 90 * DAY });
  vi.setSystemTime(NOW + 91 * DAY);
  await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: USER });
  expect(await read(t)).toMatchObject({ planKey: "free" });
});

test("claim preserves the recorded comp source under stronger paid coverage", async () => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-comp-claim-secret");
  const t = await setup();
  await event(t, "subscription.plan_changed", "api_business", NOW + 1000, NOW + 30 * DAY);
  const anonId = "11111111-1111-4111-8111-111111111111";
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: anonId, planKey: "api_starter", days: 120,
  });
  await t.withIdentity({ subject: USER }).mutation(api.payments.billing.claimSubscription, {
    anonId, claimToken: await signAnonClaimToken(anonId),
  });
  expect(await read(t)).toMatchObject({ planKey: "api_business", compPlanKey: "api_starter" });
  await event(t, "subscription.expired", "api_business", NOW + 2000, NOW + 30 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "api_starter", validUntil: NOW + 120 * DAY });
});

test("legacy comp rows retain old behavior without inferring provenance from their effective plan", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    const row = await ctx.db.query("entitlements").unique();
    await ctx.db.patch(row!._id, { compPlanKey: undefined });
  });
  await event(t, "subscription.plan_changed", "api_business", NOW + 1000, NOW + 30 * DAY);
  expect(await read(t)).toMatchObject({ planKey: "pro_monthly", compUntil: NOW + 90 * DAY });
  expect((await read(t))?.compPlanKey).toBeUndefined();
});

test.each(["anonymous", "authenticated"])("claim refuses an unknown active %s comp source combined with a known source", async (unknownSource) => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-comp-claim-secret");
  const t = await setup();
  const anonId = "11111111-1111-4111-8111-111111111111";
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: anonId, planKey: "api_starter", days: 120,
  });
  await t.run(async (ctx) => {
    const row = await ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", unknownSource === "anonymous" ? anonId : USER)).unique();
    await ctx.db.patch(row!._id, { compPlanKey: undefined });
  });
  await expect(t.withIdentity({ subject: USER }).mutation(api.payments.billing.claimSubscription, {
    anonId, claimToken: await signAnonClaimToken(anonId),
  })).rejects.toThrow("LEGACY_COMP_SOURCE_REQUIRES_AUDIT");
  expect(await t.run((ctx) => ctx.db.query("entitlements").collect())).toHaveLength(2);
});

test("claim retains the longest known comp duration when the stronger plan is shorter", async () => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-comp-claim-secret");
  const t = await setup();
  const anonId = "11111111-1111-4111-8111-111111111111";
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: anonId, planKey: "api_starter", days: 30,
  });
  await t.withIdentity({ subject: USER }).mutation(api.payments.billing.claimSubscription, {
    anonId, claimToken: await signAnonClaimToken(anonId),
  });
  expect(await read(t)).toMatchObject({ compPlanKey: "api_starter", compUntil: NOW + 90 * DAY });
});

test("a new grant cannot relabel an unaudited legacy duration", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    const row = await ctx.db.query("entitlements").unique();
    await ctx.db.patch(row!._id, { compPlanKey: undefined });
  });
  const before = await read(t);
  await expect(t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: USER, planKey: "pro_monthly", days: 7,
  })).rejects.toThrow("LEGACY_COMP_SOURCE_REQUIRES_AUDIT");
  expect(await read(t)).toEqual(before);
});

test("a stale higher paid plan cannot hide a live paid plan behind the comp floor", async () => {
  const t = convexTest(schema, modules);
  for (const [suffix, planKey, end] of [
    ["stale", "api_business", NOW - DAY],
    ["live", "api_starter", NOW + 30 * DAY],
  ] as const) {
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: USER, dodoSubscriptionId: `sub_${suffix}`,
      dodoProductId: PRODUCT_CATALOG[planKey].dodoProductId!, planKey,
      status: "active", currentPeriodStart: NOW - 31 * DAY, currentPeriodEnd: end,
      rawPayload: {}, updatedAt: NOW - DAY,
    }));
  }
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: USER, planKey: "pro_monthly", days: 90,
  });
  expect(await read(t)).toMatchObject({
    planKey: "api_starter", validUntil: NOW + 30 * DAY,
    compPlanKey: "pro_monthly", compUntil: NOW + 90 * DAY,
  });
});

test.each(["paid", "comp"])("expiry of the winning %s source restores remaining coverage without another webhook", async (winner) => {
  const t = convexTest(schema, modules);
  const paidPlan = winner === "paid" ? "api_business" : "pro_monthly";
  const compPlan = winner === "comp" ? "api_business" : "pro_monthly";
  const paidEnd = NOW + (winner === "paid" ? 7 : 30) * DAY;
  const compDays = winner === "comp" ? 7 : 30;
  await t.run((ctx) => ctx.db.insert("subscriptions", {
    userId: USER, dodoSubscriptionId: "sub_boundary",
    dodoProductId: PRODUCT_CATALOG[paidPlan].dodoProductId!, planKey: paidPlan,
    status: "active", currentPeriodStart: NOW - DAY, currentPeriodEnd: paidEnd,
    rawPayload: {}, updatedAt: NOW,
  }));
  await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
    userId: USER, planKey: compPlan, days: compDays,
  });
  expect(await read(t)).toMatchObject({ planKey: "api_business", validUntil: NOW + 7 * DAY });
  await vi.advanceTimersByTimeAsync(8 * DAY);
  await t.finishInProgressScheduledFunctions();
  expect(await t.withIdentity({ subject: USER }).query(api.entitlements.getEntitlementsForUser, {}))
    .toMatchObject({ planKey: "pro_monthly", validUntil: NOW + 30 * DAY });
  await vi.advanceTimersByTimeAsync(23 * DAY);
  await t.finishInProgressScheduledFunctions();
  expect(await t.withIdentity({ subject: USER }).query(api.entitlements.getEntitlementsForUser, {}))
    .toMatchObject({ planKey: "free" });
});

test("a scheduled coverage transition re-reads a newer paid renewal", async () => {
  const t = await setup();
  await event(t, "subscription.plan_changed", "api_business", NOW + 1000, NOW + 7 * DAY);
  await vi.advanceTimersByTimeAsync(DAY);
  await event(t, "subscription.renewed", "api_business", NOW + DAY, NOW + 120 * DAY);
  await vi.advanceTimersByTimeAsync(7 * DAY);
  await t.finishInProgressScheduledFunctions();
  expect(await t.withIdentity({ subject: USER }).query(api.entitlements.getEntitlementsForUser, {}))
    .toMatchObject({ planKey: "api_business", validUntil: NOW + 120 * DAY });
  expect(await read(t)).toMatchObject({ compPlanKey: "pro_monthly", compUntil: NOW + 90 * DAY });
});
