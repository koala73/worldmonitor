import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

/**
 * #10976: a rule save from the settings panel carries `enabledIntent` when the
 * user did not set the toggle. "connect" (a channel is being connected) on a
 * rule with no stored channel switches alerts on, unless the plan would refuse
 * the enabled rule, in which case the rule stays off and the response says
 * why. "keep", and "connect" on a rule that already has a channel, keep the
 * stored value. A save without `enabledIntent` stores `enabled` as sent.
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

async function patchRule(t: ReturnType<typeof convexTest>, patch: { enabled?: boolean; channels?: Rule["channels"] }) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("alertRules").withIndex("by_user_variant", (q) => q.eq("userId", USER).eq("variant", VARIANT)).unique();
    await ctx.db.patch(row!._id, patch);
  });
}

describe("set-alert-rules enabledIntent (#10976)", () => {
  test("connect on a disabled rule with no channel switches alerts on", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("connect on a variant with no rule creates it enabled", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("connect on a rule that already has a channel keeps the stored value, off or on", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: ["telegram"] });

    const off = await post(t, { action: "set-alert-rules", enabled: true, enabledIntent: "connect", channels: ["telegram", "email"] });
    expect(await off.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["telegram", "email"] });

    await patchRule(t, { enabled: true, channels: ["telegram"] });
    const on = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["telegram", "email"] });
    expect(await on.json()).toEqual({ ok: true, enabled: true });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["telegram", "email"] });
  });

  test("reconnecting a rule's only channel keeps an opt-out", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: ["email"] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"] });

    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });
  });

  test("two connect saves for one channel leave alerts on in either landing order", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const first = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"], eventTypes: ["watchlist_story_alert"] });
    const second = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"] });

    expect(await first.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await second.json()).toEqual({ ok: true, enabled: true });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("keep stores the stored value whatever enabled the save carries", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: true, channels: ["email"] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "keep", channels: ["email"] });

    expect(await res.json()).toEqual({ ok: true, enabled: true });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });
  });

  test("keep does not switch on a rule with no channel when it stores one", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "keep", channels: ["email"] });

    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });
  });

  test("without enabledIntent, enabled is stored as sent, with or without a first channel", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: true, channels: [] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, channels: ["email"] });

    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });
  });

  test("a save without enabled is still refused", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);

    const res = await post(t, { action: "set-alert-rules", enabledIntent: "keep", channels: ["email"] });

    expect(res.status).toBe(400);
  });

  test("an unknown enabledIntent is refused", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);

    const res = await post(t, { action: "set-alert-rules", enabled: true, enabledIntent: "always", channels: ["email"] });

    expect(res.status).toBe(400);
    expect(await storedRule(t)).toBeNull();
  });

  test("a free account with no country keeps the rule off and says why", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { enabled: false, channels: [], countries: [] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"], countries: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, enabled: false, firstChannel: "held", reason: { code: "ALERT_COUNTRY_SCOPE_REQUIRED" },
    });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"], countries: [] });
  });

  test("a free account with a country switches alerts on", async () => {
    const t = convexTest(schema, modules);

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"], countries: ["UA"] });

    expect(await res.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"], countries: ["UA"] });
  });

  test("a free account over the cross-variant country limit keeps the rule off", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { variant: "tech", enabled: true, channels: ["email"], countries: ["UA", "PL", "FR"] });
    await seedRule(t, { enabled: false, channels: [], countries: ["DE"] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["email"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, enabled: false, firstChannel: "held", reason: { code: "ALERT_COUNTRIES_UPGRADE_REQUIRED" },
    });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"], countries: ["DE"] });
  });

  test("a free account still cannot store a paid channel", async () => {
    const t = convexTest(schema, modules);
    await seedRule(t, { enabled: false, channels: [], countries: ["UA"] });

    const res = await post(t, { action: "set-alert-rules", enabled: false, enabledIntent: "connect", channels: ["slack"] });

    expect(res.status).toBe(402);
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: [] });
  });
});

describe("set-notification-config enabledIntent (#10976)", () => {
  test("connect switches a rule with no channel on, and keep leaves a later save alone", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const first = await post(t, { action: "set-notification-config", enabled: false, enabledIntent: "connect", channels: ["email"], digestMode: "realtime" });
    expect(await first.json()).toEqual({ ok: true, enabled: true, firstChannel: "on" });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email"] });

    const kept = await post(t, { action: "set-notification-config", enabled: false, enabledIntent: "keep", channels: ["email", "telegram"], digestMode: "realtime" });
    expect(await kept.json()).toEqual({ ok: true, enabled: true });
    expect(await storedRule(t)).toMatchObject({ enabled: true, channels: ["email", "telegram"] });
  });

  test("without enabledIntent, an omitted enabled leaves the stored value", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await seedRule(t, { enabled: false, channels: [] });

    const res = await post(t, { action: "set-notification-config", channels: ["email"], digestMode: "realtime" });

    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: ["email"] });
  });
});
