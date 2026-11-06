// SM-097: a user can hold two concurrent subscriptions on different lines
// (API Starter + Pro Monthly). The entitlement row carries only the winning
// subscription's paid-through date, so when that higher-tier subscription
// stops covering, the row must fall back to the subscription that still
// covers instead of lapsing to free.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { signAnonClaimToken } from "../lib/identitySigning";

const modules = import.meta.glob("../**/*.ts");

const USER = "synthetic_sm097_user";
const CUSTOMER = "cus_synthetic_sm097";
const at = (iso: string) => new Date(iso).getTime();

const API_PAID_FROM = "2026-03-01T00:00:00Z";
const API_PAID_TO = "2026-04-01T00:00:00Z";
const PRO_PAID_FROM = "2026-03-15T00:00:00Z";
const PRO_PAID_TO = "2026-04-15T00:00:00Z";

type T = ReturnType<typeof convexTest>;

function payload(over: Record<string, unknown>) {
  return {
    type: "subscription.event",
    data: {
      payload_type: "Subscription",
      status: "active",
      customer: { customer_id: CUSTOMER, email: "sm097@example.com", name: "Synthetic" },
      metadata: {},
      ...over,
    },
  };
}

const apiStarter = (over: Record<string, unknown> = {}) => payload({
  subscription_id: "sub_sm097_api",
  product_id: "pdt_sm097_api",
  previous_billing_date: API_PAID_FROM,
  next_billing_date: API_PAID_TO,
  ...over,
});

const proMonthly = (over: Record<string, unknown> = {}) => payload({
  subscription_id: "sub_sm097_pro",
  product_id: "pdt_sm097_pro",
  previous_billing_date: PRO_PAID_FROM,
  next_billing_date: PRO_PAID_TO,
  ...over,
});

async function setup(): Promise<T> {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", { dodoProductId: "pdt_sm097_api", planKey: "api_starter", displayName: "API Starter", isActive: true });
    await ctx.db.insert("productPlans", { dodoProductId: "pdt_sm097_pro", planKey: "pro_monthly", displayName: "Pro Monthly", isActive: true });
    await ctx.db.insert("customers", { userId: USER, dodoCustomerId: CUSTOMER, email: "sm097@example.com", createdAt: 0, updatedAt: 0 });
  });
  return t;
}

let webhookSeq = 0;
async function send(t: T, eventType: string, body: ReturnType<typeof payload>, eventIso: string, processedIso: string) {
  vi.setSystemTime(at(processedIso));
  webhookSeq += 1;
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `wh_sm097_${webhookSeq}`, eventType, rawPayload: body, timestamp: at(eventIso),
  });
}

/** API Starter bought 03-01 (paid to 04-01), Pro Monthly bought 03-15 (paid to 04-15). */
async function holdBoth(t: T) {
  await send(t, "subscription.active", apiStarter(), API_PAID_FROM, "2026-03-01T00:00:01Z");
  await send(t, "subscription.active", proMonthly(), PRO_PAID_FROM, "2026-03-15T00:00:01Z");
}

async function effectivePlan(t: T, readIso: string) {
  vi.setSystemTime(at(readIso));
  return (await t.query(internal.entitlements.getEntitlementsByUserId, { userId: USER })).planKey;
}

async function entitlementRow(t: T) {
  return t.run((ctx) => ctx.db.query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", USER)).unique());
}

async function pendingRechecks(t: T, userId = USER) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name.includes("recomputeEntitlementForUser")
    && job.state.kind === "pending"
    && (job.args[0] as { userId?: string }).userId === userId);
}

/**
 * Lets the scheduler reach every pending job, advancing the fake clock to each.
 * Keep job delays under 2^31-1 ms (~24.8 days): fake timers, like Node, clamp
 * a longer delay to 1 ms, so the job would run before its boundary.
 */
async function runScheduled(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

beforeEach(() => {
  vi.useFakeTimers();
  webhookSeq = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("SM-097: coverage falls back to a subscription that still covers", () => {
  test("a cancelled API Starter reaching period end keeps the live Pro subscription", async () => {
    const t = await setup();
    await holdBoth(t);
    await send(t, "subscription.updated", apiStarter({ cancel_at_next_billing_date: true }), "2026-03-20T00:00:00Z", "2026-03-20T00:00:01Z");
    await send(t, "subscription.cancelled", apiStarter({ status: "cancelled" }), "2026-04-01T00:00:05Z", "2026-04-01T00:00:06Z");

    expect(await effectivePlan(t, "2026-04-05T00:00:00Z")).toBe("pro_monthly");
    expect(await entitlementRow(t)).toMatchObject({ planKey: "pro_monthly", validUntil: at(PRO_PAID_TO) });
  });

  test("a lost subscription.cancelled still falls back at the higher tier's period end", async () => {
    const t = await setup();
    await holdBoth(t);
    await send(t, "subscription.updated", apiStarter({ cancel_at_next_billing_date: true }), "2026-03-20T00:00:00Z", "2026-03-20T00:00:01Z");
    expect(await entitlementRow(t)).toMatchObject({ planKey: "api_starter", validUntil: at(API_PAID_TO) });

    await runScheduled(t);

    expect(await entitlementRow(t)).toMatchObject({ planKey: "pro_monthly", validUntil: at(PRO_PAID_TO) });
    expect(await effectivePlan(t, "2026-04-05T00:00:00Z")).toBe("pro_monthly");
  });

  test("an on_hold API Starter past its paid-through date falls back to the live Pro subscription", async () => {
    const t = await setup();
    await holdBoth(t);
    await send(t, "subscription.on_hold", apiStarter({ status: "on_hold" }), "2026-03-25T00:00:00Z", "2026-03-25T00:00:01Z");
    expect(await entitlementRow(t)).toMatchObject({ planKey: "api_starter", validUntil: at(API_PAID_TO) });

    await runScheduled(t);

    expect(await effectivePlan(t, "2026-04-05T00:00:00Z")).toBe("pro_monthly");
  });

  test("a delayed historical event for the live subscription does not re-elect a lapsed higher tier", async () => {
    const t = await setup();
    await holdBoth(t);
    await send(t, "subscription.cancelled", apiStarter({ status: "cancelled" }), "2026-03-20T00:00:00Z", "2026-03-20T00:00:01Z");
    vi.setSystemTime(at("2026-04-03T00:00:00Z"));
    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: USER });
    expect(await effectivePlan(t, "2026-04-03T00:00:01Z")).toBe("pro_monthly");

    // Dodo redelivers a Pro subscription.updated stamped 03-25 after the
    // first attempt failed; it is processed on 04-03.
    await send(t, "subscription.updated", proMonthly(), "2026-03-25T00:00:00Z", "2026-04-03T00:01:00Z");

    expect(await effectivePlan(t, "2026-04-03T00:02:00Z")).toBe("pro_monthly");
  });

  test("repeat webhooks keep exactly one pending recheck at the winning period end", async () => {
    const t = await setup();
    await holdBoth(t);
    await send(t, "subscription.updated", apiStarter({ cancel_at_next_billing_date: true }), "2026-03-20T00:00:00Z", "2026-03-20T00:00:01Z");
    await send(t, "subscription.updated", proMonthly(), "2026-03-21T00:00:00Z", "2026-03-21T00:00:01Z");
    await send(t, "subscription.updated", proMonthly(), "2026-03-22T00:00:00Z", "2026-03-22T00:00:01Z");

    const pending = await pendingRechecks(t);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scheduledTime).toBe(at(API_PAID_TO));
  });

  test("a recheck that is no longer needed is cancelled", async () => {
    const t = await setup();
    await holdBoth(t);
    expect(await pendingRechecks(t)).toHaveLength(1);

    // API Starter renews past Pro's paid-through date: nothing outlives it.
    await send(t, "subscription.renewed", apiStarter({
      previous_billing_date: API_PAID_TO, next_billing_date: "2026-05-01T00:00:00Z",
    }), "2026-04-01T00:00:01Z", "2026-04-01T00:00:02Z");

    expect(await pendingRechecks(t)).toHaveLength(0);
    expect(await entitlementRow(t)).toMatchObject({ planKey: "api_starter", validUntil: at("2026-05-01T00:00:00Z") });
  });

  test("a claim that moves the entitlement row re-targets its pending recheck to the claiming user", async () => {
    vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-sm097-claim-secret");
    const DAY = 86_400_000;
    const now = at("2026-03-10T00:00:00Z");
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const anonId = "22222222-2222-4222-8222-222222222222";
    // Anonymous buyer: API Starter paid 10 days plus a 90-day Pro comp, so a
    // recheck at API Starter's period end is scheduled for the anon ID.
    await t.mutation(internal.payments.billing.grantComplimentaryEntitlement, {
      userId: anonId, planKey: "pro_monthly", days: 90,
    });
    await t.run((ctx) => ctx.db.insert("subscriptions", {
      userId: anonId, dodoSubscriptionId: "sub_sm097_anon_api",
      dodoProductId: PRODUCT_CATALOG.api_starter.dodoProductId!, planKey: "api_starter",
      status: "active", currentPeriodStart: now - DAY, currentPeriodEnd: now + 10 * DAY,
      rawPayload: {}, updatedAt: now - DAY,
    }));
    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: anonId });
    expect(await pendingRechecks(t, anonId)).toHaveLength(1);

    // The claim moves the anon entitlement row to USER, who has none.
    await t.withIdentity({ subject: USER }).mutation(api.payments.billing.claimSubscription, {
      anonId, claimToken: await signAnonClaimToken(anonId),
    });

    expect(await pendingRechecks(t, anonId)).toHaveLength(0);
    const pending = await pendingRechecks(t);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scheduledTime).toBe(now + 10 * DAY);

    await runScheduled(t);
    expect(await entitlementRow(t)).toMatchObject({ planKey: "pro_monthly", validUntil: now + 90 * DAY });
  });
});
