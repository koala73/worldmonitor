import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { adminNewSubscriptionHtml } from "../payments/subscriptionEmails";

// The admin alerts must report what the customer was charged. Shapes below are
// the ones production stored for Black Friday 2026: the subscription events
// carry the list renewal (35999) with no discount fields, and the charge, its
// tax and the discount code arrive only on payment.succeeded, which usually
// lands a few hundred milliseconds after subscription.active / plan_changed.

const modules = import.meta.glob("../**/*.ts");

const NOW = new Date("2026-11-27T17:25:07Z").getTime();
const DAY_MS = 86_400_000;
const ANNUAL = PRODUCT_CATALOG.pro_annual!;
const MONTHLY = PRODUCT_CATALOG.pro_monthly!;

type ResendSend = { to: string[]; subject: string; html: string };

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockResend() {
  vi.useFakeTimers();
  process.env.RESEND_API_KEY = "re_test";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  return () => fetchMock.mock.calls
    .filter(([url]) => String(url) === "https://api.resend.com/emails")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as ResendSend);
}

async function seedPlans(t: ReturnType<typeof convexTest>, userId: string) {
  await t.run(async (ctx) => {
    // The customers row is how the webhook attributes an unsigned checkout.
    await ctx.db.insert("customers", {
      userId,
      dodoCustomerId: "cust_bf_001",
      email: "buyer@example.com",
      createdAt: NOW - DAY_MS,
      updatedAt: NOW - DAY_MS,
    });
    for (const key of ["pro_monthly", "pro_annual"]) {
      await ctx.db.insert("productPlans", {
        dodoProductId: PRODUCT_CATALOG[key]!.dodoProductId!,
        planKey: key,
        displayName: PRODUCT_CATALOG[key]!.displayName,
        isActive: true,
      });
    }
  });
}

async function deliver(
  t: ReturnType<typeof convexTest>,
  eventType: string,
  data: Record<string, unknown>,
  timestamp = NOW,
) {
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `wh_${Math.random().toString(36).slice(2)}`,
    eventType,
    rawPayload: { type: eventType, business_id: "biz_test", timestamp: new Date(timestamp).toISOString(), data },
    timestamp,
  });
}

const customer = { customer_id: "cust_bf_001", email: "buyer@example.com", name: "Buyer" };

function subscriptionData(subscriptionId: string, productId: string, userId: string, recurring: number) {
  return {
    payload_type: "Subscription",
    subscription_id: subscriptionId,
    product_id: productId,
    status: "active",
    customer,
    metadata: { wm_user_id: userId },
    previous_billing_date: new Date(NOW).toISOString(),
    next_billing_date: new Date(NOW + 365 * DAY_MS).toISOString(),
    recurring_pre_tax_amount: recurring,
    currency: "USD",
    tax_inclusive: false,
  };
}

function paymentData(subscriptionId: string, userId: string, total: number, extra: Record<string, unknown> = {}) {
  return {
    payload_type: "Payment",
    payment_id: `pay_${subscriptionId}`,
    subscription_id: subscriptionId,
    status: "succeeded",
    customer,
    metadata: { wm_user_id: userId },
    total_amount: total,
    tax: 0,
    currency: "USD",
    discount_id: "dsc_test_blackfriday",
    ...extra,
  };
}

/** Runs the jobs the webhook scheduled for "now", leaving delayed ones queued. */
async function runDueJobs(t: ReturnType<typeof convexTest>) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

const adminNew = (sends: ResendSend[]) => sends.filter((s) => s.subject.startsWith("[WM] New User Subscribed"));
const adminUpgrade = (sends: ResendSend[]) => sends.filter((s) => s.subject.startsWith("[WM] Plan Upgrade"));
const row = (label: string, value: string) =>
  new RegExp(`${label}:</td><td[^>]*>${value.replace(/[$.()]/g, "\\$&")}`);

describe("admin new-subscription alert: the amount actually charged", () => {
  test("a discounted purchase reports the $144 charge, the code and the list renewal", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_bf_new");

    await deliver(t, "subscription.active", subscriptionData("sub_bf_new", ANNUAL.dodoProductId!, "user_bf_new", 35999));
    await runDueJobs(t); // the alert job runs before payment.succeeded lands
    await deliver(t, "payment.succeeded", paymentData("sub_bf_new", "user_bf_new", 14400));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = adminNew(sends());
    expect(emails).toHaveLength(1);
    const html = emails[0]!.html;
    expect(html).toMatch(row("Amount Paid", "$144.00 USD"));
    expect(html).toMatch(row("List Price", "$359.99 USD"));
    expect(html).toMatch(row("Saved", "$215.99 USD (60% off)"));
    expect(html).toMatch(row("Discount", "dsc_test_blackfriday"));
    expect(html).toMatch(row("Renews At", "$359.99 USD (pre-tax)"));
    expect(html).not.toMatch(row("Amount Paid", "$359.99"));
  });

  test("the charge is found when payment.succeeded lands before subscription.active", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_bf_first");

    await deliver(t, "payment.succeeded", paymentData("sub_bf_first", "user_bf_first", 14400));
    await deliver(t, "subscription.active", subscriptionData("sub_bf_first", ANNUAL.dodoProductId!, "user_bf_first", 35999));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = adminNew(sends());
    expect(email?.html).toMatch(row("Amount Paid", "$144.00 USD"));
  });

  test("a full-price purchase shows the charge once, with no renewal row", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_full");

    await deliver(t, "subscription.active", subscriptionData("sub_full", MONTHLY.dodoProductId!, "user_full", 3999));
    await deliver(t, "payment.succeeded", paymentData("sub_full", "user_full", 3999, { discount_id: null }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const [email] = adminNew(sends());
    expect(email?.html).toMatch(row("Amount Paid", "$39.99 USD"));
    expect(email?.html).not.toMatch(/Renews At|List Price|Saved|Discount:/);
  });

  test("with no charge recorded the alert names the renewal price, never Amount Paid", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_nopay");

    await deliver(t, "subscription.active", subscriptionData("sub_nopay", ANNUAL.dodoProductId!, "user_nopay", 35999));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = adminNew(sends());
    expect(emails).toHaveLength(1);
    expect(emails[0]!.html).toMatch(row("Renewal Price", "$359.99 USD (pre-tax)"));
    expect(emails[0]!.html).not.toMatch(/Amount Paid/);
  });

  test("the customer welcome is sent once and not held back by the charge lookup", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_welcome");

    await deliver(t, "subscription.active", subscriptionData("sub_welcome", ANNUAL.dodoProductId!, "user_welcome", 35999));
    await runDueJobs(t);
    expect(sends().filter((s) => s.subject.startsWith("Welcome to World Monitor"))).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(sends().filter((s) => s.subject.startsWith("Welcome to World Monitor"))).toHaveLength(1);
  });
});

describe("adminNewSubscriptionHtml: tax and currency", () => {
  const base = { userEmail: "buyer@example.com", planKey: "pro_annual", userId: "user_x" };

  test("a taxed charge names the tax and compares the pre-tax part to the list price", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      recurringPreTaxAmount: 35999,
      currency: "USD",
      charge: { amount: 17280, currency: "USD", tax: 2880, discountId: "dsc_x" },
    });
    expect(html).toMatch(row("Amount Paid", "$172.80 USD (incl. $28.80 USD tax)"));
    expect(html).toMatch(row("Saved", "$215.99 USD (60% off)"));
  });

  test("a non-USD charge makes no list-price comparison", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      recurringPreTaxAmount: 27482,
      currency: "GBP",
      charge: { amount: 13192, currency: "GBP", tax: 2199, discountId: "dsc_x" },
    });
    expect(html).toMatch(row("Amount Paid", "£131.92 GBP (incl. £21.99 GBP tax)"));
    expect(html).toMatch(row("Renews At", "£274.82 GBP (pre-tax)"));
    expect(html).not.toMatch(/List Price|Saved/);
  });
});

describe("admin plan-upgrade alert: the amount actually charged", () => {
  async function seedMonthly(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: "user_switch",
        dodoSubscriptionId: "sub_switch",
        dodoProductId: MONTHLY.dodoProductId!,
        planKey: "pro_monthly",
        status: "active",
        currentPeriodStart: NOW - 15 * DAY_MS,
        currentPeriodEnd: NOW + 15 * DAY_MS,
        dodoCustomerId: "cust_bf_001",
        rawPayload: { product_id: MONTHLY.dodoProductId, recurring_pre_tax_amount: 3999, currency: "USD" },
        updatedAt: NOW - 15 * DAY_MS,
      });
    });
  }

  test("a Black Friday switch reports the prorated charge and the code", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_switch");
    await seedMonthly(t);

    await deliver(t, "subscription.plan_changed", subscriptionData("sub_switch", ANNUAL.dodoProductId!, "user_switch", 35999));
    await runDueJobs(t);
    await deliver(t, "payment.succeeded", paymentData("sub_switch", "user_switch", 12414));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = adminUpgrade(sends());
    expect(emails).toHaveLength(1);
    const html = emails[0]!.html;
    expect(html).toMatch(row("Charged Now", "$124.14 USD"));
    expect(html).toMatch(row("Discount", "dsc_test_blackfriday"));
    expect(html).toMatch(row("New Price", "$359.99 USD / year"));
  });

  test("with no charge recorded the switch alert still goes out, without a charge row", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlans(t, "user_switch");
    await seedMonthly(t);

    await deliver(t, "subscription.plan_changed", subscriptionData("sub_switch", ANNUAL.dodoProductId!, "user_switch", 35999));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const emails = adminUpgrade(sends());
    expect(emails).toHaveLength(1);
    expect(emails[0]!.html).not.toMatch(/Charged Now/);
  });
});
