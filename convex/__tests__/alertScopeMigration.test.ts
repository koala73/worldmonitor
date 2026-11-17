import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { ALERT_SETTINGS_URL, alertScopeNoticeContent } from "../alertScopeMigration";

const modules = import.meta.glob("../**/*.ts");
const fns = (internal as any).alertScopeMigration;
const DAY = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
const originalResend = process.env.RESEND_API_KEY;
const originalLive = process.env.ALERT_SCOPE_NOTICE_LIVE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalResend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResend;
  if (originalLive === undefined) delete process.env.ALERT_SCOPE_NOTICE_LIVE;
  else process.env.ALERT_SCOPE_NOTICE_LIVE = originalLive;
  vi.restoreAllMocks();
});

type T = ReturnType<typeof convexTest>;

async function seedRule(t: T, userId: string, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => ctx.db.insert("alertRules", {
    userId,
    variant: "full",
    enabled: true,
    eventTypes: [],
    sensitivity: "critical",
    channels: ["web_push"],
    updatedAt: 1,
    ...extra,
  } as any));
}

async function follow(t: T, userId: string, countries: string[]) {
  await t.run(async (ctx) => {
    let at = 1_000;
    for (const country of countries) {
      await ctx.db.insert("followedCountries", { userId, country, addedAt: at++ });
    }
  });
}

async function makePro(t: T, userId: string) {
  await t.run(async (ctx) => ctx.db.insert("entitlements", {
    userId,
    planKey: "pro_monthly",
    features: { tier: 1, maxDashboards: 10, apiAccess: false, apiRateLimit: 0, prioritySupport: false, exportFormats: [] },
    validUntil: Date.now() + 30 * DAY,
    updatedAt: Date.now(),
  } as any));
}

async function rule(t: T, id: unknown) {
  return await t.run(async (ctx) => ctx.db.get(id as any)) as any;
}

async function notices(t: T) {
  return await t.run(async (ctx) => ctx.db.query("alertScopeNotices").collect());
}

async function migrate(t: T, dryRun: boolean) {
  return await t.mutation(fns.migrateUnscopedRealtimeRules, { dryRun });
}

describe("realtime alert scope migration (#10873)", () => {
  test("a dry run counts what it would do and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    const r1 = await seedRule(t, "u1");
    await follow(t, "u1", ["UA", "IL"]);
    await seedRule(t, "u2");

    const summary = await migrate(t, true);
    expect(summary).toMatchObject({ dryRun: true, unscopedRealtime: 2, scoped: 1, globalOnly: 1, alreadyMigrated: 0, isDone: true });
    expect((await rule(t, r1)).countries).toBeUndefined();
    expect(await notices(t)).toHaveLength(0);
  });

  test("copies followed countries oldest first into an unscoped realtime rule", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    const r1 = await seedRule(t, "u1");
    await follow(t, "u1", ["UA", "IL", "TW", "ua"]);

    const summary = await migrate(t, false);
    expect(summary).toMatchObject({ scoped: 1, globalOnly: 0 });
    expect((await rule(t, r1)).countries).toEqual(["UA", "IL", "TW"]);
    const [notice] = await notices(t);
    expect(notice).toMatchObject({ userId: "u1", outcome: "scoped", countries: ["UA", "IL", "TW"], emailStatus: "pending" });
  });

  test("clamps a free (or lapsed) account to the free ladder's country cap", async () => {
    const t = convexTest(schema, modules);
    const r1 = await seedRule(t, "free-user");
    await follow(t, "free-user", ["UA", "IL", "TW", "KZ", "CO"]);

    await migrate(t, false);
    expect((await rule(t, r1)).countries).toEqual(["UA", "IL", "TW"]);
  });

  test("leaves the rule empty and records global_only when the user follows nothing", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    const r1 = await seedRule(t, "u1");

    await migrate(t, false);
    expect((await rule(t, r1)).countries).toBeUndefined();
    expect((await notices(t))[0]).toMatchObject({ outcome: "global_only", countries: [] });
  });

  test("runs once per rule: a re-run never re-scopes a rule its owner cleared", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    const r1 = await seedRule(t, "u1");
    await follow(t, "u1", ["UA"]);
    await migrate(t, false);
    await t.run(async (ctx) => ctx.db.patch(r1 as any, { countries: [] }));

    const again = await migrate(t, false);
    expect(again).toMatchObject({ unscopedRealtime: 1, alreadyMigrated: 1, scoped: 0 });
    expect((await rule(t, r1)).countries).toEqual([]);
    expect(await notices(t)).toHaveLength(1);
  });

  test("leaves digest, disabled and already-scoped rules alone", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    await follow(t, "u1", ["UA"]);
    const digest = await seedRule(t, "u1", { variant: "finance", digestMode: "daily" });
    const disabled = await seedRule(t, "u1", { variant: "tech", enabled: false });
    const scoped = await seedRule(t, "u1", { variant: "energy", countries: ["FR"] });

    const summary = await migrate(t, false);
    expect(summary).toMatchObject({ unscopedRealtime: 0 });
    expect((await rule(t, digest)).countries).toBeUndefined();
    expect((await rule(t, disabled)).countries).toBeUndefined();
    expect((await rule(t, scoped)).countries).toEqual(["FR"]);
    expect(await notices(t)).toHaveLength(0);
  });

  test("pages through rules with the returned cursor", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 5; i++) await seedRule(t, `u${i}`);
    const first = await t.mutation(fns.migrateUnscopedRealtimeRules, { dryRun: false, batchSize: 2 });
    expect(first).toMatchObject({ scanned: 2, isDone: false });
    let cursor = first.continueCursor;
    let total = first.globalOnly;
    for (let guard = 0; guard < 10; guard++) {
      const next = await t.mutation(fns.migrateUnscopedRealtimeRules, { dryRun: false, batchSize: 2, cursor });
      total += next.globalOnly;
      cursor = next.continueCursor;
      if (next.isDone) break;
    }
    expect(total).toBe(5);
  });
});

describe("alert scope notice", () => {
  async function seedCustomer(t: T, userId: string, email: string) {
    await t.run(async (ctx) => ctx.db.insert("customers", {
      userId, email, normalizedEmail: email.toLowerCase(), createdAt: 1, updatedAt: 1,
    } as any));
  }

  test("names the countries and links to the settings", () => {
    const scoped = alertScopeNoticeContent(["UA", "IL"]);
    expect(scoped.text).toContain("Ukraine, Israel");
    expect(scoped.text).toContain(ALERT_SETTINGS_URL);
    expect(scoped.html).toContain(`href="${ALERT_SETTINGS_URL}"`);
    const none = alertScopeNoticeContent([]);
    expect(none.subject).toBe("Add countries to keep getting local alerts");
    expect(none.text).toContain("global critical events only");
  });

  test("is a dry run unless live, and sends nothing", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, "u1");
    await migrate(t, false);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    delete process.env.ALERT_SCOPE_NOTICE_LIVE;

    const summary = await t.action(fns.sendAlertScopeNotices, {});
    expect(summary).toMatchObject({ live: false, users: 1, sent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await notices(t))[0].emailStatus).toBe("pending");
  });

  test("sends one email per user across variant rows and marks them sent", async () => {
    const t = convexTest(schema, modules);
    await makePro(t, "u1");
    await follow(t, "u1", ["UA"]);
    await seedRule(t, "u1");
    await seedRule(t, "u1", { variant: "finance" });
    await migrate(t, false);
    await seedCustomer(t, "u1", "Owner@Example.com");
    process.env.RESEND_API_KEY = "test-key";
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }) as any;

    const summary = await t.action(fns.sendAlertScopeNotices, { live: true });
    expect(summary).toMatchObject({ users: 1, sent: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].to).toEqual(["owner@example.com"]);
    expect(bodies[0].text).toContain("Ukraine");
    const rows = await notices(t);
    expect(rows.map((r) => r.emailStatus)).toEqual(["sent", "sent"]);
  });

  test("keeps a failed send pending, then gives up after three attempts", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, "u1");
    await migrate(t, false);
    await seedCustomer(t, "u1", "a@example.com");
    process.env.RESEND_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as any;

    for (let i = 0; i < 2; i++) {
      await expect(t.action(fns.sendAlertScopeNotices, { live: true })).rejects.toThrow(/notice send failure/);
    }
    expect((await notices(t))[0]).toMatchObject({ emailStatus: "pending", emailAttempts: 2 });
    await expect(t.action(fns.sendAlertScopeNotices, { live: true })).rejects.toThrow(/Resend 503/);
    expect((await notices(t))[0]).toMatchObject({ emailStatus: "failed", emailAttempts: 3 });
  });

  test("skips a user with no email address", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, "u1");
    await migrate(t, false);
    process.env.RESEND_API_KEY = "test-key";
    const summary = await t.action(fns.sendAlertScopeNotices, { live: true });
    expect(summary).toMatchObject({ skipped: 1, sent: 0 });
    expect((await notices(t))[0].emailStatus).toBe("skipped");
  });
});
