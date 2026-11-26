import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

/**
 * #10976: a rule save that sends no `enabled` gives the server the decision.
 * The save that stores a rule's first channel switches alerts on, unless the
 * plan would refuse the enabled rule, in which case the rule stays off and the
 * response says why. Any other save without `enabled` keeps the stored value.
 */

const modules = import.meta.glob("../**/*.ts");
const USER = "user-first-channel";
const VARIANT = "full";
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-gateway");
});
afterEach(() => vi.unstubAllEnvs());

type Rule = {
  variant?: string;
  enabled: boolean;
  channels: Array<"email" | "telegram" | "web_push" | "slack" | "webhook">;
  countries?: string[];
};

function post(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
  return t.fetch("/relay/notification-channels", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-gateway", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER, variant: VARIANT, eventTypes: [], sensitivity: "critical", ...body }),
  });
}

async function seedPro(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER, planKey: "pro_monthly",
      features: { tier: 1, maxDashboards: 10, apiAccess: true, apiRateLimit: 1000, prioritySupport: true, exportFormats: ["json"] },
      validUntil: Date.now() + 30 * DAY, updatedAt: Date.now(),
    });
  });
}

async function seedRule(t: ReturnType<typeof convexTest>, rule: Rule) {
  await t.run(async (ctx) => {
    await ctx.db.insert("alertRules", {
      userId: USER, variant: rule.variant ?? VARIANT, enabled: rule.enabled, eventTypes: [],
      sensitivity: "critical", channels: rule.channels, countries: rule.countries, updatedAt: Date.now(),
    });
  });
}

async function storedRule(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("alertRules")
    .withIndex("by_user_variant", (q) => q.eq("userId", USER).eq("variant", VARIANT))
    .unique());
}

describe("set-alert-rules without enabled (#10976)", () => {
  test("the first channel on a disabled rule switches alerts on", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const res = await post(t, { action: "set-alert-rules", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("the first channel on a variant with no rule creates it enabled", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);

    const res = await post(t, { action: "set-alert-rules", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("a second channel keeps the stored value, off or on", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: ["telegram"] });

    const off = await post(t, { action: "set-alert-rules", channels: ["telegram", "email"] });
    expect(await off.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["telegram", "email"] });

    await t.run(async (ctx) => {
      const row = await ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", USER)).unique();
      await ctx.db.patch(row!._id, { enabled: true, channels: ["telegram"] });
    });
    const on = await post(t, { action: "set-alert-rules", channels: ["telegram", "email"] });
    expect(await on.json()).toEqual({ ok: true, enabled: true });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["telegram", "email"] });
  });

  test("a save with no channel keeps a disabled rule off", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);

    const res = await post(t, { action: "set-alert-rules", channels: [] });

    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: [] });
  });

  test("an explicit enabled:false is stored as sent, with or without a first channel", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: ["email"] });

    const same = await post(t, { action: "set-alert-rules", enabled: false, channels: ["email"] });
    expect(await same.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });

    await t.run(async (ctx) => {
      const row = await ctx.db.query("alertRules").withIndex("by_user", (q) => q.eq("userId", USER)).unique();
      await ctx.db.patch(row!._id, { channels: [] });
    });
    const first = await post(t, { action: "set-alert-rules", enabled: false, channels: ["email"] });
    expect(await first.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });
  });

  test("a free account with no country keeps the rule off and says why", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { enabled: false, channels: [], countries: [] });

    const res = await post(t, { action: "set-alert-rules", channels: ["email"], countries: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, enabled: false, firstChannel: "held", reason: { code: "ALERT_COUNTRY_SCOPE_REQUIRED" },
    });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"], countries: [] });
  });

  test("a free account with a country switches alerts on", async () => {
    const t = convexTest(schema, modules);

    const res = await post(t, { action: "set-alert-rules", channels: ["email"], countries: ["UA"] });

    expect(await res.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"], countries: ["UA"] });
  });

  test("a free account over the cross-variant country limit keeps the rule off", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { variant: "tech", enabled: true, channels: ["email"], countries: ["UA", "PL", "FR"] });
    await seedRule(t, { enabled: false, channels: [], countries: ["DE"] });

    const res = await post(t, { action: "set-alert-rules", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, enabled: false, firstChannel: "held", reason: { code: "ALERT_COUNTRIES_UPGRADE_REQUIRED" },
    });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"], countries: ["DE"] });
  });

  test("a free account still cannot store a paid channel", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { enabled: false, channels: [], countries: ["UA"] });

    const res = await post(t, { action: "set-alert-rules", channels: ["slack"] });

    expect(res.status).toBe(402);
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: [] });
  });
});

describe("set-notification-config without enabled (#10976)", () => {
  test("the first channel switches alerts on, a later channel keeps the stored value", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const first = await post(t, { action: "set-notification-config", channels: ["email"], digestMode: "realtime" });
    expect(await first.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });

    await post(t, { action: "set-alert-rules", enabled: false, channels: ["email"] });
    const second = await post(t, { action: "set-notification-config", channels: ["email", "telegram"], digestMode: "realtime" });
    expect(await second.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email", "telegram"] });
  });
});
