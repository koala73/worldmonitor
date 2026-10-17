/**
 * One-click unsubscribe (RFC 8058): signed token, GET confirm page that never
 * changes state, POST that unsubscribes without login, per-list effect, the
 * pre-signed URLs on /relay/channels, and the winback headers.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  buildUnsubscribeUrl,
  listUnsubscribeHeaders,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../lib/emailUnsubscribe";
import { WINBACK_MIN_AGE_MS, buildDunningEmail } from "../payments/subscriptionEmails";

const modules = import.meta.glob("../**/*.ts");
const SECRET = "test-email-unsubscribe-secret-0123456789";
const USER = "user_unsub_1";
const EMAIL = "reader@example.com";
const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", SECRET);
  vi.stubEnv("CONVEX_SITE_URL", "https://synthetic.convex.site");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedRules(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const base = { userId: USER, enabled: true, eventTypes: [], sensitivity: "high" as const, updatedAt: 1 };
    await ctx.db.insert("alertRules", { ...base, variant: "full", channels: ["email", "telegram"], digestMode: "daily" });
    await ctx.db.insert("alertRules", { ...base, variant: "tech", channels: ["email", "slack"] });
    await ctx.db.insert("alertRules", { ...base, variant: "finance", channels: ["email"], digestMode: "realtime" });
  });
}

async function channelsByVariant(t: ReturnType<typeof convexTest>) {
  const rules = await t.run((ctx) => ctx.db.query("alertRules").collect());
  return Object.fromEntries(rules.map((r) => [r.variant, r.channels]));
}

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

describe("token", () => {
  test("round-trips and carries no email address", async () => {
    const token = await signUnsubscribeToken(USER, "brief");
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(token).not.toContain("@");
    expect(await verifyUnsubscribeToken(token)).toEqual({ userId: USER, list: "brief" });
  });

  test("rejects tampering, a wrong secret and garbage", async () => {
    const token = (await signUnsubscribeToken(USER, "alerts"))!;
    const [v, payload, sig] = token.split(".");
    const forged = `${v}.${Buffer.from(JSON.stringify({ u: "someone_else", l: "alerts" })).toString("base64url")}.${sig}`;
    expect(await verifyUnsubscribeToken(forged)).toBeNull();
    expect(await verifyUnsubscribeToken(`${v}.${payload}.${"0".repeat(64)}`)).toBeNull();
    expect(await verifyUnsubscribeToken("nope")).toBeNull();
    expect(await verifyUnsubscribeToken(null)).toBeNull();
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "a-different-secret-0123456789");
    expect(await verifyUnsubscribeToken(token)).toBeNull();
  });

  test("no secret means no token and no URL (send degrades, never fails)", async () => {
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "");
    expect(await signUnsubscribeToken(USER, "brief")).toBeNull();
    expect(await buildUnsubscribeUrl(USER, "brief")).toBeNull();
  });

  test("URL and RFC 8058 headers", async () => {
    const url = (await buildUnsubscribeUrl(USER, "marketing"))!;
    expect(url.startsWith("https://synthetic.convex.site/email/unsubscribe?t=v1.")).toBe(true);
    expect(listUnsubscribeHeaders(url)).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(listUnsubscribeHeaders(null)).toBeUndefined();
    expect(listUnsubscribeHeaders("http://insecure.example/x")).toBeUndefined();
  });
});

describe("/email/unsubscribe", () => {
  test("GET shows a confirm form and changes nothing (link scanners prefetch)", async () => {
    const t = convexTest(schema, modules);
    await seedRules(t);
    const url = (await buildUnsubscribeUrl(USER, "brief"))!;
    const res = await t.fetch(pathOf(url), { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("daily brief");
    expect(html).toContain('href="https://www.worldmonitor.app/dashboard?settings=notifications"');
    expect(html).toContain('mailto:support@worldmonitor.app?subject=Unsubscribe%20from%20product%20emails');
    expect((await channelsByVariant(t)).full).toEqual(["email", "telegram"]);
  });

  test("one-click POST for the brief drops email from digest rules only", async () => {
    const t = convexTest(schema, modules);
    await seedRules(t);
    const url = (await buildUnsubscribeUrl(USER, "brief"))!;
    const res = await t.fetch(pathOf(url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await channelsByVariant(t)).toEqual({
      full: ["telegram"],
      tech: ["email", "slack"],
      finance: ["email"],
    });
    // Idempotent: a second POST (Gmail retries) is still 200.
    expect((await t.fetch(pathOf(url), { method: "POST", body: "List-Unsubscribe=One-Click" })).status).toBe(200);
  });

  test("POST for alerts drops email from real-time rules only", async () => {
    const t = convexTest(schema, modules);
    await seedRules(t);
    const url = (await buildUnsubscribeUrl(USER, "alerts"))!;
    expect((await t.fetch(pathOf(url), { method: "POST", body: "List-Unsubscribe=One-Click" })).status).toBe(200);
    expect(await channelsByVariant(t)).toEqual({
      full: ["email", "telegram"],
      tech: ["slack"],
      finance: [],
    });
  });

  test("the confirm form's token-in-body POST works too", async () => {
    const t = convexTest(schema, modules);
    await seedRules(t);
    const token = (await signUnsubscribeToken(USER, "alerts"))!;
    const res = await t.fetch("/email/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `t=${encodeURIComponent(token)}`,
    });
    expect(res.status).toBe(200);
    expect((await channelsByVariant(t)).finance).toEqual([]);
  });

  test("an invalid token is a 400 on GET and POST and changes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedRules(t);
    expect((await t.fetch("/email/unsubscribe?t=v1.bad.sig", { method: "GET" })).status).toBe(400);
    expect((await t.fetch("/email/unsubscribe?t=v1.bad.sig", { method: "POST" })).status).toBe(400);
    expect((await t.fetch("/email/unsubscribe", { method: "POST" })).status).toBe(400);
    expect((await channelsByVariant(t)).finance).toEqual(["email"]);
  });

  test("marketing POST suppresses marketing mail but not account mail", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { userId: USER, email: "Reader@Example.com", firstSeenAt: 1, lastSeenAt: 1 });
    });
    const url = (await buildUnsubscribeUrl(USER, "marketing"))!;
    expect((await t.fetch(pathOf(url), { method: "POST", body: "List-Unsubscribe=One-Click" })).status).toBe(200);
    expect(await t.query(internal.emailSuppressions.isEmailSuppressed, { email: EMAIL, purpose: "marketing" })).toBe(true);
    expect(await t.query(internal.emailSuppressions.isEmailSuppressed, { email: EMAIL, purpose: "transactional" })).toBe(false);
  });

  test("marketing unsubscribe never downgrades a bounce", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { userId: USER, email: EMAIL, firstSeenAt: 1, lastSeenAt: 1 });
      await ctx.db.insert("emailSuppressions", { normalizedEmail: EMAIL, reason: "bounce", suppressedAt: 1 });
    });
    await t.mutation(internal.emailUnsubscribe.applyUnsubscribe, { userId: USER, list: "marketing" });
    const rows = await t.run((ctx) => ctx.db.query("emailSuppressions").collect());
    expect(rows.map((r) => r.reason)).toEqual(["bounce"]);
  });
});

describe("/relay/channels", () => {
  test("email channels carry pre-signed brief and alerts URLs", async () => {
    vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "delivery-secret");
    vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "tenant-secret");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationChannels", {
        userId: USER, channelType: "email", email: EMAIL,
        emailOwnership: "verified_account", verified: true, linkedAt: 1,
      });
      await ctx.db.insert("notificationChannels", {
        userId: USER, channelType: "telegram", chatId: "chat-1",
        telegramOwnership: "verified_callback", verified: true, linkedAt: 1,
      });
    });
    const res = await t.fetch("/relay/channels", {
      method: "POST",
      headers: { Authorization: "Bearer delivery-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER }),
    });
    const channels = (await res.json()) as Array<{ channelType: string; unsubscribeUrls?: { brief: string; alerts: string } }>;
    const email = channels.find((c) => c.channelType === "email")!;
    expect(await verifyUnsubscribeToken(new URL(email.unsubscribeUrls!.brief).searchParams.get("t")))
      .toEqual({ userId: USER, list: "brief" });
    expect(await verifyUnsubscribeToken(new URL(email.unsubscribeUrls!.alerts).searchParams.get("t")))
      .toEqual({ userId: USER, list: "alerts" });
    expect(channels.find((c) => c.channelType === "telegram")!.unsubscribeUrls).toBeUndefined();
  });
});

describe("winback", () => {
  test("goes from news@ with one-click headers and a footer link", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER,
        dodoSubscriptionId: "sub_unsub_1",
        dodoProductId: "pdt_test",
        planKey: "pro_monthly",
        status: "cancelled",
        currentPeriodStart: Date.now() - 80 * DAY_MS,
        currentPeriodEnd: Date.now() - (WINBACK_MIN_AGE_MS + 5 * DAY_MS),
        cancelledAt: Date.now() - 80 * DAY_MS,
        rawPayload: { subscription_id: "sub_unsub_1", customer: { email: EMAIL } },
        updatedAt: Date.now() - 1000,
      });
    });

    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url) === "https://api.resend.com/emails")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(sends).toHaveLength(1);
    const send = sends[0];
    expect(send.from).toBe("World Monitor <news@worldmonitor.app>");
    expect(send.reply_to).toBe("elie@worldmonitor.app");
    expect(send.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = /^<(https:\/\/[^>]+)>$/.exec(send.headers["List-Unsubscribe"])![1]!;
    expect(await verifyUnsubscribeToken(new URL(url).searchParams.get("t"))).toEqual({ userId: USER, list: "marketing" });
    expect(send.html).toContain("Unsubscribe from World Monitor product emails");

    // Following the link stops the next winback-class (marketing) send.
    await t.mutation(internal.emailUnsubscribe.applyUnsubscribe, { userId: USER, list: "marketing" });
    expect(await t.query(internal.emailSuppressions.isEmailSuppressed, { email: EMAIL, purpose: "marketing" })).toBe(true);
  });

  test("without the secret, winback has an explicit support opt-out and no header", () => {
    const { html } = buildDunningEmail("winback_day30", "Pro (Monthly)", "https://www.worldmonitor.app/pro", undefined, undefined, null);
    expect(html).toContain('href="mailto:support@worldmonitor.app?subject=Unsubscribe%20from%20product%20emails"');
    expect(html).toContain("Email support to unsubscribe from product emails");
    expect(html).not.toContain("https://www.worldmonitor.app/settings");
    const dunning = buildDunningEmail("dunning_day3", "Pro (Monthly)", "https://www.worldmonitor.app/dashboard");
    expect(dunning.html).not.toContain("Unsubscribe%20from%20product%20emails");
    expect(dunning.html).not.toContain("Unsubscribe from World Monitor product emails");
    expect(listUnsubscribeHeaders(null)).toBeUndefined();
  });

  test("marketing unsubscribe covers every subscription checkout address", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("subscriptions", {
          userId: USER,
          dodoSubscriptionId: `sub_many_${i}`,
          dodoProductId: "pdt_test",
          planKey: "pro_monthly",
          status: "cancelled",
          currentPeriodStart: 1,
          currentPeriodEnd: 2,
          rawPayload: { customer: { email: `checkout${i}@example.com` } },
          updatedAt: 1,
        });
      }
    });
    await t.mutation(internal.emailUnsubscribe.applyUnsubscribe, { userId: USER, list: "marketing" });
    expect(await t.query(internal.emailSuppressions.isEmailSuppressed, { email: "checkout24@example.com", purpose: "marketing" })).toBe(true);
  });

  test("payment-failure dunning stays on noreply@ without unsubscribe headers", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        userId: USER,
        dodoSubscriptionId: "sub_unsub_2",
        dodoProductId: "pdt_test",
        planKey: "pro_monthly",
        status: "on_hold",
        onHoldAt: Date.now() - 2 * 60 * 60 * 1000,
        currentPeriodStart: Date.now() - 20 * DAY_MS,
        currentPeriodEnd: Date.now() + 10 * DAY_MS,
        rawPayload: { subscription_id: "sub_unsub_2", customer: { email: EMAIL } },
        updatedAt: Date.now() - 1000,
      });
    });
    await t.mutation(internal.payments.subscriptionEmails.runDunningScan, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sends = fetchMock.mock.calls
      .filter(([url]) => String(url) === "https://api.resend.com/emails")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(sends.length).toBeGreaterThan(0);
    for (const send of sends) {
      expect(send.from).toBe("World Monitor <noreply@worldmonitor.app>");
      expect(send.headers).toBeUndefined();
    }
  });
});
