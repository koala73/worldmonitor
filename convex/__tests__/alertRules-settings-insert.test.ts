import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

/**
 * #10976: saving quiet hours, or a realtime digest setting, on a variant with
 * no rule used to insert `enabled: true, channels: []`. The relay read that as
 * an enabled realtime subscription, matched critical stories to it and dropped
 * them with "No usable channel". A settings save must not create a rule the
 * relay delivers to; enabling stays with the writes that choose channels.
 */

const modules = import.meta.glob("../**/*.ts");
const USER = "user-settings-insert";
const VARIANT = "energy";
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-gateway");
  vi.stubEnv("CONVEX_NOTIFICATION_RELAY_SECRET", "synthetic-delivery");
});
afterEach(() => vi.unstubAllEnvs());

const gatewayPost = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { Authorization: "Bearer synthetic-gateway", "Content-Type": "application/json" },
  body: JSON.stringify({ userId: USER, variant: VARIANT, ...body }),
});

async function seedPro(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER, planKey: "pro_monthly",
      features: { tier: 1, maxDashboards: 10, apiAccess: true, apiRateLimit: 1000, prioritySupport: true, exportFormats: ["json"] },
      validUntil: Date.now() + 30 * DAY, updatedAt: Date.now(),
    });
  });
}

async function relayRuleUsers(t: ReturnType<typeof convexTest>): Promise<string[]> {
  const res = await t.fetch("/relay/enabled-rules", { headers: { Authorization: "Bearer synthetic-delivery" } });
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ userId: string }>).map((r) => r.userId);
}

async function storedRule(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("alertRules")
    .withIndex("by_user_variant", (q) => q.eq("userId", USER).eq("variant", VARIANT))
    .unique());
}

describe("settings saves on a variant with no rule (#10976)", () => {
  test("a quiet-hours save stores the preference without an enabled rule", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    const res = await t.fetch("/relay/notification-channels", gatewayPost({
      action: "set-quiet-hours", quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: "UTC",
    }));
    expect(res.status).toBe(200);
    expect(await relayRuleUsers(t)).toEqual([]);
    expect(await storedRule(t)).toMatchObject({
      enabled: false, channels: [], quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7,
    });
  });

  test("a realtime digest-settings save stores the preference without an enabled rule", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    const res = await t.fetch("/relay/notification-channels", gatewayPost({
      action: "set-digest-settings", digestMode: "realtime", digestHour: 9, digestTimezone: "UTC",
    }));
    expect(res.status).toBe(200);
    expect(await relayRuleUsers(t)).toEqual([]);
    expect(await storedRule(t)).toMatchObject({ enabled: false, channels: [], digestMode: "realtime", digestHour: 9 });
  });

  test("a digest-cadence save still creates an enabled digest rule", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    const res = await t.fetch("/relay/notification-channels", gatewayPost({
      action: "set-digest-settings", digestMode: "daily", digestHour: 8, digestTimezone: "UTC",
    }));
    expect(res.status).toBe(200);
    expect(await storedRule(t)).toMatchObject({ enabled: true, digestMode: "daily" });
  });

  test("switching alerts on in settings afterwards enables the rule with its channel and keeps quiet hours", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER, variant: VARIANT, quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7,
    });
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER, variant: VARIANT, enabled: true, eventTypes: [], sensitivity: "critical",
      channels: ["email"], countries: ["AE"], enforceEntitlement: true,
    });
    expect(await storedRule(t)).toMatchObject({
      enabled: true, channels: ["email"], countries: ["AE"], quietHoursEnabled: true, quietHoursStart: 22,
    });
    expect(await relayRuleUsers(t)).toEqual([USER]);
  });

  test("the activation alerts step afterwards enables the rule, scoped to followed countries", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("followedCountries", { userId: USER, country: "AE", addedAt: 1 });
    });
    await t.mutation(internal.alertRules.setDigestSettingsForUser, {
      userId: USER, variant: VARIANT, digestMode: "realtime",
    });
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER, variant: VARIANT, enabled: true, sensitivity: "critical", channels: ["web_push"],
      seedCountriesFromFollowed: true,
    });
    expect(await storedRule(t)).toMatchObject({
      enabled: true, channels: ["web_push"], countries: ["AE"], digestMode: "realtime",
    });
    expect(await relayRuleUsers(t)).toEqual([USER]);
  });

  test("a free account re-enabling the staged rule still needs a country scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setQuietHoursForUser, {
      userId: USER, variant: VARIANT, quietHoursEnabled: false, countries: [], enforceEntitlement: true,
    });
    await expect(t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER, variant: VARIANT, enabled: true, eventTypes: [], sensitivity: "critical",
      channels: ["web_push"], enforceEntitlement: true,
    })).rejects.toThrow(/ALERT_COUNTRY_SCOPE_REQUIRED/);
  });
});

describe("settings saves on an existing rule keep its enabled state", () => {
  for (const enabled of [true, false]) {
    test(`quiet-hours and digest saves leave enabled:${enabled} as stored`, async () => {
      const t = convexTest(schema, modules);
      await seedPro(t);
      await t.mutation(internal.alertRules.setAlertRulesForUser, {
        userId: USER, variant: VARIANT, enabled, eventTypes: [], sensitivity: "critical", channels: ["email"],
      });
      await t.mutation(internal.alertRules.setQuietHoursForUser, {
        userId: USER, variant: VARIANT, quietHoursEnabled: true, quietHoursStart: 23, quietHoursEnd: 6,
      });
      await t.mutation(internal.alertRules.setDigestSettingsForUser, {
        userId: USER, variant: VARIANT, digestMode: "realtime", digestHour: 7,
      });
      expect(await storedRule(t)).toMatchObject({ enabled, channels: ["email"], quietHoursStart: 23, digestHour: 7 });
    });
  }
});
