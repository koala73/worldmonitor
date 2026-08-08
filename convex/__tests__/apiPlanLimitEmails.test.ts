import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const noticeFns = (internal as any).apiPlanLimitNotices;
const emailFns = (internal as any).apiPlanLimitEmails;

const NOW = 1_800_000_000_000;
const originalFetch = globalThis.fetch;
const originalResend = process.env.RESEND_API_KEY;

function restoreEnv() {
  if (originalResend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResend;
}

async function seedNotice(t: ReturnType<typeof convexTest>, userId = "user-api") {
  return await t.mutation(noticeFns.recordUsageEvaluation, {
    rollup: {
      userId,
      planKey: "api_starter",
      dimension: "api_daily_requests",
      windowKey: "2026-07-02",
      windowStart: NOW,
      windowEnd: NOW + 86_400_000,
      limit: 1_000,
      usage: 1_200,
      source: "test",
      sourceFreshAt: NOW,
      computedAt: NOW,
    },
    notice: {
      state: "over_limit",
      upgradeTargetPlanKey: "api_business",
      ctaKind: "contact_support",
      blockedReason: "api_business_not_self_serve",
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  vi.restoreAllMocks();
});

describe("api plan-limit email delivery", () => {
  test("sends due notice and records sent status", async () => {
    const t = convexTest(schema, modules);
    await seedNotice(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user-api",
        email: "Owner@Example.com",
        normalizedEmail: "owner@example.com",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    process.env.RESEND_API_KEY = "resend-test";
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }) as typeof fetch;

    const summary = await t.action(emailFns.sendDuePlanLimitEmails, { now: NOW + 1_000, live: true });
    expect(summary).toMatchObject({ considered: 1, sent: 1, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      to: ["owner@example.com"],
      subject: "World Monitor usage notice: daily API requests exceeded plan limit",
    });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices[0].emailStatus).toBe("sent");
    expect(notices[0].lastEmailedAt).toBe(NOW + 1_000);
  });

  test("dry-run kill-switch (no live flag) sends nothing and leaves notices pending", async () => {
    const t = convexTest(schema, modules);
    await seedNotice(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user-api",
        email: "owner@example.com",
        normalizedEmail: "owner@example.com",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    // Even with a Resend key and a due, deliverable notice, the default run must
    // NOT send: PLAN_LIMIT_NOTIFY_LIVE is unset and no `live` arg is passed.
    process.env.RESEND_API_KEY = "resend-test";
    delete process.env.PLAN_LIMIT_NOTIFY_LIVE;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const summary = await t.action(emailFns.sendDuePlanLimitEmails, { now: NOW + 1_000 });
    expect(summary).toMatchObject({ considered: 1, sent: 0, skipped: 0, failed: 0, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices[0]).toMatchObject({ emailStatus: "pending", current: true });
  });

  test("suppressed recipient marks notice suppressed without calling Resend", async () => {
    const t = convexTest(schema, modules);
    await seedNotice(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user-api",
        email: "owner@example.com",
        normalizedEmail: "owner@example.com",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("emailSuppressions", {
        normalizedEmail: "owner@example.com",
        reason: "bounce",
        suppressedAt: NOW,
      });
    });
    process.env.RESEND_API_KEY = "resend-test";
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const summary = await t.action(emailFns.sendDuePlanLimitEmails, { now: NOW + 1_000, live: true });
    expect(summary).toMatchObject({ considered: 1, sent: 0, skipped: 1, failed: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices[0].emailStatus).toBe("suppressed");
  });

  test("missing recipient marks notice skipped and leaves in-app notice current", async () => {
    const t = convexTest(schema, modules);
    await seedNotice(t);
    process.env.RESEND_API_KEY = "resend-test";

    const summary = await t.action(emailFns.sendDuePlanLimitEmails, { now: NOW + 1_000, live: true });
    expect(summary).toMatchObject({ considered: 1, sent: 0, skipped: 1, failed: 0 });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices[0]).toMatchObject({ emailStatus: "skipped", current: true });
  });

  test("continues through Resend failures before surfacing the batch error", async () => {
    const t = convexTest(schema, modules);
    await seedNotice(t, "user-api-1");
    await seedNotice(t, "user-api-2");
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user-api-1",
        email: "one@example.com",
        normalizedEmail: "one@example.com",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("customers", {
        userId: "user-api-2",
        email: "two@example.com",
        normalizedEmail: "two@example.com",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    process.env.RESEND_API_KEY = "resend-test";
    const calls: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.to[0]);
      if (calls.length === 1) {
        return new Response("temporary upstream error", { status: 503 });
      }
      return new Response(JSON.stringify({ id: "email_2" }), { status: 200 });
    }) as typeof fetch;

    await expect(t.action(emailFns.sendDuePlanLimitEmails, { now: NOW + 1_000, live: true }))
      .rejects
      .toThrow("[apiPlanLimitEmails] 1 email delivery failure");
    expect(calls).toEqual(["one@example.com", "two@example.com"]);

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    const failedNotice = notices.find((notice) => notice.userId === "user-api-1");
    expect(failedNotice).toMatchObject({ emailStatus: "failed" });
    expect(failedNotice?.lastEmailedAt).toBeUndefined();
    expect(notices.find((notice) => notice.userId === "user-api-2")).toMatchObject({
      emailStatus: "sent",
      lastEmailedAt: NOW + 1_000,
    });
  });
});
