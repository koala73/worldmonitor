import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { API_STARTER_SWITCH_TARGETS } from "../payments/billing";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { classifyPlanChange } from "../payments/subscriptionHelpers";

const modules = import.meta.glob("../**/*.ts");

const NOW = new Date("2026-03-21T10:00:00Z").getTime();
const DAY_MS = 86_400_000;

type ResendSend = { to: string[]; subject: string; html: string };

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyPlanChange", () => {
  test.each([
    ["pro_monthly", "pro_annual", "upgrade"],
    ["pro_annual", "pro_monthly", "downgrade"],
    ["pro_monthly", "pro_business_monthly", "upgrade"],
    ["pro_annual", "pro_business_annual", "upgrade"],
    ["pro_business_monthly", "pro_monthly", "downgrade"],
    ["pro_business_annual", "pro_monthly", "downgrade"],
    ["pro_annual", "pro_business_monthly", "upgrade"],
    ["pro_monthly", "api_starter", "upgrade"],
    // The three in-place Pro → API Starter switches (API_STARTER_SWITCH_TARGETS).
    ["pro_monthly_mcp", "api_starter", "upgrade"],
    ["pro_annual", "api_starter_annual", "upgrade"],
    ["api_starter", "pro_annual", "downgrade"],
    ["api_starter_annual", "api_business", "upgrade"],
    ["api_business_annual", "api_starter", "downgrade"],
    ["free", "pro_monthly", "upgrade"],
    ["api_business", "enterprise", "upgrade"],
    ["pro_monthly", "pro_monthly", "lateral"],
    ["pro_monthly", "unknown_plan", "lateral"],
    ["unknown_plan", "pro_annual", "lateral"],
  ] as const)("%s -> %s is %s", (from, to, expected) => {
    expect(classifyPlanChange(from, to)).toBe(expected);
  });
});

function mockResend() {
  vi.useFakeTimers();
  process.env.RESEND_API_KEY = "re_test";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  return () => fetchMock.mock.calls
    .filter(([url]) => String(url) === "https://api.resend.com/emails")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as ResendSend);
}

async function seedSubscription(t: ReturnType<typeof convexTest>, planKey: string, amount: number) {
  await t.run(async (ctx) => {
    for (const key of ["pro_monthly", "pro_monthly_mcp", "pro_annual", "pro_business_monthly", "api_starter", "api_starter_annual"]) {
      await ctx.db.insert("productPlans", {
        dodoProductId: PRODUCT_CATALOG[key]!.dodoProductId!,
        planKey: key,
        displayName: PRODUCT_CATALOG[key]!.displayName,
        isActive: true,
      });
    }
    await ctx.db.insert("subscriptions", {
      userId: "user_upgrader",
      dodoSubscriptionId: "sub_up_001",
      dodoProductId: PRODUCT_CATALOG[planKey]!.dodoProductId!,
      planKey,
      status: "active",
      currentPeriodStart: NOW - 10 * DAY_MS,
      currentPeriodEnd: NOW + 20 * DAY_MS,
      dodoCustomerId: "cust_up_001",
      rawPayload: { product_id: PRODUCT_CATALOG[planKey]!.dodoProductId, recurring_pre_tax_amount: amount, currency: "USD", customer: { email: "upgrader@example.com" } },
      updatedAt: NOW - 10 * DAY_MS,
    });
  });
}

async function deliver(
  t: ReturnType<typeof convexTest>,
  eventType: "subscription.plan_changed" | "subscription.updated" | "subscription.renewed",
  planKey: string,
  amount: number,
  timestamp = NOW,
  extra: Record<string, unknown> = {},
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `wh_${Math.random().toString(36).slice(2)}`,
    eventType,
    rawPayload: {
      type: eventType,
      business_id: "biz_test",
      timestamp: new Date(timestamp).toISOString(),
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_up_001",
        product_id: PRODUCT_CATALOG[planKey]!.dodoProductId,
        status: "active",
        customer: { customer_id: "cust_up_001", email: "upgrader@example.com" },
        metadata: { wm_user_id: "user_upgrader" },
        previous_billing_date: new Date(NOW - 10 * DAY_MS).toISOString(),
        next_billing_date: new Date(NOW + 20 * DAY_MS).toISOString(),
        recurring_pre_tax_amount: amount,
        currency: "USD",
        ...extra,
      },
    },
    timestamp,
  });
}

const upgradeSends = (sends: ResendSend[]) => sends.filter((send) => send.subject.startsWith("[WM] Plan Upgrade"));

describe("admin plan-upgrade email", () => {
  test("an upgrade sends one admin email naming both plans and the price change", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.plan_changed", "pro_business_monthly", 4999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const all = sends();
    expect(all).toHaveLength(1);
    const [email] = upgradeSends(all);
    expect(email?.to).toEqual(["elie@worldmonitor.app"]);
    expect(email?.subject).toBe("[WM] Plan Upgrade: Pro (Monthly) → Pro Business (Monthly)");
    expect(email?.html).toMatch(/From:<\/td><td[^>]*>Pro \(Monthly\)</);
    expect(email?.html).toMatch(/To:<\/td><td[^>]*>Pro Business \(Monthly\)</);
    expect(email?.html).toMatch(/Old Price:<\/td><td[^>]*>\$39\.99 USD \/ month</);
    expect(email?.html).toMatch(/New Price:<\/td><td[^>]*>\$49\.99 USD \/ month</);
    expect(email?.html).toMatch(/Change:<\/td><td[^>]*>\+\$10\.00 USD \/ month</);
    expect(email?.html).toMatch(/Email:<\/td><td[^>]*>upgrader@example\.com</);
    expect(email?.html).toMatch(/User ID:<\/td><td[^>]*>user_upgrader</);
  });

  test("monthly to annual compares the yearly cost", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.plan_changed", "pro_annual", 35999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = upgradeSends(sends());
    expect(email?.subject).toBe("[WM] Plan Upgrade: Pro (Monthly) → Pro (Annual)");
    expect(email?.html).toMatch(/New Price:<\/td><td[^>]*>\$359\.99 USD \/ year</);
    expect(email?.html).toMatch(/Change:<\/td><td[^>]*>-\$119\.89 USD \/ year \(annualized\)</);
  });

  // Pro Monthly → Pro Yearly with the Black Friday code. Dodo reports the
  // discounted first year as recurring_pre_tax_amount while a discount cycle
  // remains (a live Pro Yearly subscription read 28799 against a 35999 list).
  test("a discounted switch to annual reports the first-year charge and the list renewal", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.plan_changed", "pro_annual", 14400, NOW, {
      discount_id: "dsc_test_bf",
      discount_cycles_remaining: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = upgradeSends(sends());
    expect(email?.subject).toBe("[WM] Plan Upgrade: Pro (Monthly) → Pro (Annual)");
    expect(email?.html).toMatch(/New Price:<\/td><td[^>]*>\$144\.00 USD \/ year \(discounted first year\)</);
    expect(email?.html).toMatch(/Renews At:<\/td><td[^>]*>\$359\.99 USD \/ year \(list price\)</);
    // The ongoing change compares list prices, not the one-off first year.
    expect(email?.html).toMatch(/Change:<\/td><td[^>]*>-\$119\.89 USD \/ year \(annualized\)</);
    expect(email?.html).not.toMatch(/-\$335\.88/);
  });

  // A code that covers two cycles keeps the discounted price at the next
  // renewal, so the email must not say it renews at list.
  test("a discount covering two cycles makes no list-price renewal claim", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.plan_changed", "pro_annual", 14400, NOW, {
      discount_id: "dsc_test_two",
      discount_cycles_remaining: 2,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = upgradeSends(sends());
    expect(email?.html).toMatch(/New Price:<\/td><td[^>]*>\$144\.00 USD \/ year</);
    expect(email?.html).not.toMatch(/first year/);
    expect(email?.html).not.toMatch(/Renews At/);
    expect(email?.html).not.toMatch(/list price/);
  });

  test("the switch to annual moves the plan, the period and the entitlement", async () => {
    mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);
    const nextBilling = NOW + 365 * DAY_MS;

    await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
      webhookId: "wh_switch_annual",
      eventType: "subscription.plan_changed",
      rawPayload: {
        type: "subscription.plan_changed",
        business_id: "biz_test",
        timestamp: new Date(NOW).toISOString(),
        data: {
          payload_type: "Subscription",
          subscription_id: "sub_up_001",
          product_id: PRODUCT_CATALOG.pro_annual!.dodoProductId,
          status: "active",
          customer: { customer_id: "cust_up_001", email: "upgrader@example.com" },
          metadata: { wm_user_id: "user_upgrader" },
          previous_billing_date: new Date(NOW).toISOString(),
          next_billing_date: new Date(nextBilling).toISOString(),
          recurring_pre_tax_amount: 14400,
          currency: "USD",
          discount_id: "dsc_test_bf",
          discount_cycles_remaining: 1,
        },
      },
      timestamp: NOW,
    });

    const sub = await t.run((ctx) => ctx.db.query("subscriptions").first());
    expect(sub?.planKey).toBe("pro_annual");
    expect(sub?.dodoProductId).toBe(PRODUCT_CATALOG.pro_annual!.dodoProductId);
    expect(sub?.currentPeriodStart).toBe(NOW);
    expect(sub?.currentPeriodEnd).toBe(nextBilling);
    const entitlement = await t.run((ctx) => ctx.db.query("entitlements").first());
    expect(entitlement?.planKey).toBe("pro_annual");
    expect(entitlement?.validUntil).toBeGreaterThanOrEqual(nextBilling);
  });

  test("a downgrade sends nothing", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_business_monthly", 4999);

    await deliver(t, "subscription.plan_changed", "pro_monthly", 3999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(sends()).toHaveLength(0);
    const sub = await t.run(async (ctx) => ctx.db.query("subscriptions").first());
    expect(sub?.planKey).toBe("pro_monthly");
  });

  test("a replayed upgrade event sends nothing the second time", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.plan_changed", "pro_business_monthly", 4999);
    await deliver(t, "subscription.plan_changed", "pro_business_monthly", 4999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(upgradeSends(sends())).toHaveLength(1);
  });

  test("a renewal carrying the new product before plan_changed does not pose as the old price", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.renewed", "pro_business_monthly", 4999);
    await deliver(t, "subscription.plan_changed", "pro_business_monthly", 4999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = upgradeSends(sends());
    expect(email?.html).toMatch(/Old Price:<\/td><td[^>]*>\$39\.99 USD \/ month \(list price\)</);
    expect(email?.html).toMatch(/Change:<\/td><td[^>]*>\+\$10\.00 USD \/ month</);
  });

  test("the upgrade is announced once when subscription.updated lands before plan_changed", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);

    await deliver(t, "subscription.updated", "pro_business_monthly", 4999);
    await deliver(t, "subscription.plan_changed", "pro_business_monthly", 4999);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const upgrades = upgradeSends(sends());
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.html).toMatch(/Old Price:<\/td><td[^>]*>\$39\.99 USD \/ month</);
  });
});

// The in-place Pro → API Starter switch (runPlanChange kind "api_starter")
// reaches the webhook as subscription.plan_changed, never as a new purchase.
// These pin what that path gives an API Starter buyer that a fresh checkout's
// subscription.active would: the API entitlement and key issuance, and the
// admin alert naming both plans.
describe("Pro → API Starter plan change", () => {
  const keyArgs = (n: number) => ({
    userId: "user_upgrader",
    name: `key ${n}`,
    keyPrefix: `wm_0000${n}`,
    keyHash: String(n).repeat(64).slice(0, 64),
  });

  test("every switch source is announced as an upgrade, with both plan names", async () => {
    const expected: Record<string, [string, number, string]> = {
      pro_monthly: ["Pro (Monthly)", 3999, "API Starter (Monthly)"],
      pro_monthly_mcp: ["Pro (Monthly)", 1499, "API Starter (Monthly)"],
      pro_annual: ["Pro (Annual)", 35999, "API Starter (Annual)"],
    };
    expect(Object.keys(API_STARTER_SWITCH_TARGETS).sort()).toEqual(Object.keys(expected).sort());
    for (const [from, to] of Object.entries(API_STARTER_SWITCH_TARGETS)) {
      const [fromName, amount, toName] = expected[from]!;
      expect(classifyPlanChange(from, to), from).toBe("upgrade");
      const sends = mockResend();
      const t = convexTest(schema, modules);
      await seedSubscription(t, from, amount);
      await deliver(t, "subscription.plan_changed", to, PRODUCT_CATALOG[to]!.priceCents!);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const upgrades = upgradeSends(sends());
      expect(upgrades, from).toHaveLength(1);
      expect(upgrades[0]?.subject).toBe(`[WM] Plan Upgrade: ${fromName} → ${toName}`);
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  test("the switch grants API access, so the account can create an API key", async () => {
    mockResend();
    const t = convexTest(schema, modules);
    await seedSubscription(t, "pro_monthly", 3999);
    await t.mutation(internal.payments.subscriptionHelpers.recomputeEntitlementForUser, { userId: "user_upgrader", eventTimestamp: NOW });
    vi.setSystemTime(NOW);
    await expect(t.mutation(internal.apiKeys.createApiKeyForUser, keyArgs(1))).rejects.toThrow(/API_ACCESS_REQUIRED/);

    await deliver(t, "subscription.plan_changed", "api_starter", 9999);
    const entitlement = await t.run((ctx) => ctx.db.query("entitlements").first());
    expect(entitlement?.planKey).toBe("api_starter");
    expect(entitlement?.features.apiAccess).toBe(true);
    expect(entitlement?.features.planLimits).toEqual(PRODUCT_CATALOG.api_starter!.features.planLimits);
    await expect(t.mutation(internal.apiKeys.createApiKeyForUser, keyArgs(2))).resolves.toBeDefined();
  });
});
