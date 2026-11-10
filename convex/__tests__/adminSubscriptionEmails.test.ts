import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { MCP_ATTRIBUTION_SOURCE } from "../../shared/mcp-attribution";
import { adminNewSubscriptionHtml } from "../payments/subscriptionEmails";

const modules = import.meta.glob("../**/*.ts");

const PURCHASED_AT = new Date("2026-03-21T10:00:00Z").getTime();
const DAY_MS = 86_400_000;

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
    .filter(([url]) => String(url).includes("api.resend.com"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as ResendSend);
}

async function seedPlan(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productPlans", {
      dodoProductId: "pdt_test_pro",
      planKey: "pro_monthly",
      displayName: "Pro Monthly",
      isActive: true,
    });
  });
}

async function activate(
  t: ReturnType<typeof convexTest>,
  data: Record<string, unknown>,
) {
  const userId = (data.metadata as { wm_user_id?: string } | undefined)?.wm_user_id ?? "user_buyer";
  await t.run(async (ctx) => {
    await ctx.db.insert("customers", {
      userId,
      dodoCustomerId: "cust_conv_001",
      email: "buyer@example.com",
      createdAt: PURCHASED_AT,
      updatedAt: PURCHASED_AT,
    });
  });
  await t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
    webhookId: `wh_${Math.random().toString(36).slice(2)}`,
    eventType: "subscription.active",
    rawPayload: {
      type: "subscription.active",
      business_id: "biz_test",
      timestamp: new Date(PURCHASED_AT).toISOString(),
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_conv_001",
        product_id: "pdt_test_pro",
        status: "active",
        customer: { customer_id: "cust_conv_001", email: "buyer@example.com", name: "Buyer" },
        previous_billing_date: "2026-03-21T00:00:00Z",
        next_billing_date: "2026-04-21T00:00:00Z",
        recurring_pre_tax_amount: 3999,
        currency: "USD",
        ...data,
      },
    },
    timestamp: PURCHASED_AT,
  });
}

const CONVERSION_LABELS = [
  "Source:",
  "Referrer:",
  "Landing Page:",
  "First Visit:",
  "MCP Funnel:",
  "Referral:",
  "Billing Country:",
  "Account First Seen:",
];

describe("admin new-subscription email: conversion context", () => {
  test("a fully attributed checkout reaches the admin email as one row per signal", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlan(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        userId: "user_buyer",
        email: "buyer@example.com",
        normalizedEmail: "buyer@example.com",
        firstSeenAt: PURCHASED_AT - 35 * DAY_MS,
        lastSeenAt: PURCHASED_AT,
      });
      await ctx.db.insert("users", {
        userId: "user_referrer",
        email: "referrer@example.com",
        normalizedEmail: "referrer@example.com",
        firstSeenAt: PURCHASED_AT - 200 * DAY_MS,
        lastSeenAt: PURCHASED_AT,
      });
      await ctx.db.insert("userReferralCodes", {
        userId: "user_referrer",
        code: "friend42",
        createdAt: PURCHASED_AT - 100 * DAY_MS,
      });
    });

    await activate(t, {
      metadata: {
        wm_user_id: "user_buyer",
        wm_acq_source: "twitter",
        wm_acq_medium: "social",
        wm_acq_campaign: "launch",
        wm_acq_referrer: "t.co",
        wm_acq_landing: "pricing",
        wm_acq_first_seen: "2026-03-11",
        wm_attribution: MCP_ATTRIBUTION_SOURCE,
        affonso_referral: "friend42",
      },
      billing: { country: "LB", city: "Beirut", street: "x", state: "x", zipcode: "x" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const admin = sends().find((send) => send.subject.startsWith("[WM] New User Subscribed"));
    expect(admin?.to).toEqual(["elie@worldmonitor.app"]);
    const html = admin?.html ?? "";
    expect(html).toMatch(/Source:<\/td><td[^>]*>twitter \/ social \/ launch</);
    expect(html).toMatch(/Referrer:<\/td><td[^>]*>t\.co</);
    expect(html).toMatch(/Landing Page:<\/td><td[^>]*>pricing</);
    expect(html).toMatch(/First Visit:<\/td><td[^>]*>2026-03-11 \(10 days before purchase\)</);
    expect(html).toMatch(new RegExp(`MCP Funnel:</td><td[^>]*>${MCP_ATTRIBUTION_SOURCE}<`));
    expect(html).toMatch(/Referral:<\/td><td[^>]*>friend42 \(referrer@example\.com\)</);
    expect(html).toMatch(/Billing Country:<\/td><td[^>]*>LB</);
    expect(html).toMatch(/Account First Seen:<\/td><td[^>]*>2026-02-14 \(35 days before purchase\)</);
    expect(html).not.toContain("not captured");
  });

  test("the customer welcome email carries none of the conversion rows", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlan(t);

    await activate(t, {
      metadata: {
        wm_user_id: "user_buyer",
        wm_acq_source: "twitter",
        wm_acq_referrer: "t.co",
        wm_attribution: MCP_ATTRIBUTION_SOURCE,
        affonso_referral: "friend42",
      },
      billing: { country: "LB" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const all = sends();
    const welcome = all.find((send) => send.subject.startsWith("Welcome to World Monitor"));
    expect(welcome?.to).toEqual(["buyer@example.com"]);
    for (const label of CONVERSION_LABELS) expect(welcome?.html).not.toContain(label);
    expect(welcome?.html).not.toContain("friend42");
    expect(welcome?.html).not.toContain("t.co");
    expect(all.find((send) => send.subject.startsWith("[WM] New User Subscribed"))?.html).toContain("friend42");
  });

  test("a checkout with no acquisition, MCP or referral metadata says so", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlan(t);

    await activate(t, { metadata: { wm_user_id: "user_buyer" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const html = sends().find((send) => send.subject.startsWith("[WM] New User Subscribed"))?.html ?? "";
    expect(html).toMatch(/Source:<\/td><td[^>]*>not captured</);
    expect(html).not.toContain("Referrer:");
    expect(html).not.toContain("Billing Country:");
  });

  test("the exact landing path from the checkout metadata reaches the admin email", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlan(t);

    await activate(t, {
      metadata: {
        wm_user_id: "user_buyer",
        wm_acq_referrer: "chatgpt.com",
        wm_acq_landing: "countries",
        wm_acq_path: "/countries/iran/",
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const html = sends().find((send) => send.subject.startsWith("[WM] New User Subscribed"))?.html ?? "";
    expect(html).toMatch(/Landing Page:<\/td><td[^>]*>\/countries\/iran\/ \(countries\)</);
  });

  test("a crafted landing path in the checkout metadata never reaches the admin email", async () => {
    const sends = mockResend();
    const t = convexTest(schema, modules);
    await seedPlan(t);

    await activate(t, {
      metadata: {
        wm_user_id: "user_buyer",
        wm_acq_landing: "countries",
        wm_acq_path: "/countries/<img src=x>/",
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const html = sends().find((send) => send.subject.startsWith("[WM] New User Subscribed"))?.html ?? "";
    expect(html).toMatch(/Landing Page:<\/td><td[^>]*>countries</);
    expect(html).not.toContain("img");
  });
});

describe("adminNewSubscriptionHtml", () => {
  const base = {
    userEmail: "buyer@example.com",
    planKey: "pro_monthly",
    userId: "user_buyer",
  };

  test("a direct visit is a captured source, not a missing one", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: { purchasedAt: PURCHASED_AT, acquisition: { referrer: "direct", firstSeen: "2026-03-21" } },
    });
    expect(html).toMatch(/Referrer:<\/td><td[^>]*>direct</);
    expect(html).toMatch(/First Visit:<\/td><td[^>]*>2026-03-21 \(same day as purchase\)</);
    expect(html).not.toContain("not captured");
  });

  test("a tagged link with no referrer header does not read as a direct visit", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: {
        purchasedAt: PURCHASED_AT,
        acquisition: { source: "chatgpt-com", referrer: "direct", landing: "dashboard", firstSeen: "2026-03-20" },
      },
    });
    expect(html).toMatch(/Source:<\/td><td[^>]*>ChatGPT \(chatgpt-com\)</);
    expect(html).toMatch(/Referrer:<\/td><td[^>]*>none recorded \(source from utm tag\)</);
    expect(html).not.toMatch(/Referrer:<\/td><td[^>]*>direct</);
  });

  test("a medium or campaign tag without utm_source keeps the direct referrer", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: { purchasedAt: PURCHASED_AT, acquisition: { medium: "email", referrer: "direct" } },
    });
    expect(html).toMatch(/Referrer:<\/td><td[^>]*>direct</);
  });

  test("an AI assistant source reads by its product name, with the stored tag beside it", () => {
    const sourceRow = (source: string, extra: Record<string, string> = {}) => adminNewSubscriptionHtml({
      ...base,
      conversion: { purchasedAt: PURCHASED_AT, acquisition: { source, ...extra } },
    }).match(/Source:<\/td><td[^>]*>([^<]*)</)?.[1];
    expect(sourceRow("chatgpt-com")).toBe("ChatGPT (chatgpt-com)");
    expect(sourceRow("perplexity-ai")).toBe("Perplexity (perplexity-ai)");
    expect(sourceRow("claude-ai", { medium: "referral" })).toBe("Claude (claude-ai) / referral");
    expect(sourceRow("twitter", { medium: "social" })).toBe("twitter / social");
    expect(sourceRow("constructor")).toBe("constructor");
    expect(sourceRow("tostring")).toBe("tostring");
  });

  test("the landing page row names the exact path and its family", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: {
        purchasedAt: PURCHASED_AT,
        acquisition: { referrer: "direct", landing: "countries", path: "/countries/iran/" },
      },
    });
    expect(html).toMatch(/Landing Page:<\/td><td[^>]*>\/countries\/iran\/ \(countries\)</);
  });

  test("a record written before the path existed shows the family alone", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: { purchasedAt: PURCHASED_AT, acquisition: { referrer: "direct", landing: "countries" } },
    });
    expect(html).toMatch(/Landing Page:<\/td><td[^>]*>countries</);
  });

  test("a referral alone counts as a captured source", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: { purchasedAt: PURCHASED_AT, referralCode: "friend42" },
    });
    expect(html).toMatch(/Referral:<\/td><td[^>]*>friend42</);
    expect(html).not.toContain("not captured");
  });

  test("escapes every conversion value", () => {
    const html = adminNewSubscriptionHtml({
      ...base,
      conversion: {
        purchasedAt: PURCHASED_AT,
        referralCode: "<b>code</b>",
        referrerEmail: "<script>alert(1)</script>@example.com",
        billingCountry: "<i>",
      },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>code</b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
    expect(html).toContain("&lt;b&gt;code&lt;/b&gt;");
  });

  test("a job queued before conversion context existed renders without conversion rows", () => {
    const html = adminNewSubscriptionHtml(base);
    for (const label of CONVERSION_LABELS) expect(html).not.toContain(label);
    expect(html).toContain("buyer@example.com");
  });
});
