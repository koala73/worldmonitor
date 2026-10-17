/**
 * alertRules.chokepoints — chokepoint-scope persistence + normalization
 * (#9217 item 6). Same contract as alertRules-tickers.test.ts, except ids
 * are checked against the closed list in shared/chokepoint-alert-ids.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-chokepoints", tokenIdentifier: "clerk|user-tests-chokepoints" };
const VARIANT = "full";

async function seedProEntitlement(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: USER.subject,
      planKey: "pro_monthly",
      features: {
        tier: 1,
        maxDashboards: 10,
        apiAccess: false,
        apiRateLimit: 0,
        prioritySupport: false,
        exportFormats: ["json"],
      },
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    });
  });
}

async function readRow(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) => q.eq("userId", USER.subject).eq("variant", VARIANT))
      .unique();
  });
}

const base = {
  variant: VARIANT,
  enabled: true,
  eventTypes: ["chokepoint_disruption"],
  sensitivity: "critical" as const,
  channels: [],
};

describe("alertRules.chokepoints", () => {
  test("a Pro user without API access stores a normalized chokepoint list", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    await t.withIdentity(USER).mutation(api.alertRules.setAlertRules, {
      ...base,
      chokepoints: [" HORMUZ_STRAIT", "suez", "hormuz_strait", "atlantis", "", "panama"],
    });
    const row = await readRow(t);
    expect(row?.chokepoints).toEqual(["hormuz_strait", "suez", "panama"]);
    expect(row?.eventTypes).toEqual(["chokepoint_disruption"]);
  });

  test("absent on insert when omitted, preserved on omit, reset by []", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    const asUser = t.withIdentity(USER);
    await asUser.mutation(api.alertRules.setAlertRules, base);
    expect(await readRow(t)).not.toHaveProperty("chokepoints");

    await asUser.mutation(api.alertRules.setAlertRules, { ...base, chokepoints: ["suez"] });
    await asUser.mutation(api.alertRules.setAlertRules, { ...base, countries: ["FR"] });
    expect((await readRow(t))?.chokepoints).toEqual(["suez"]);

    await asUser.mutation(api.alertRules.setAlertRules, { ...base, chokepoints: [] });
    expect((await readRow(t))?.chokepoints).toEqual([]);
  });

  test("setAlertRulesForUser forwards and normalizes chokepoints", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: USER.subject,
      ...base,
      chokepoints: ["Bab_El_Mandeb", "nope"],
    });
    expect((await readRow(t))?.chokepoints).toEqual(["bab_el_mandeb"]);
  });

  test("setNotificationConfigForUser forwards, normalizes and preserves on omit", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      ...base,
      chokepoints: ["taiwan_strait", "TAIWAN_STRAIT"],
    });
    expect((await readRow(t))?.chokepoints).toEqual(["taiwan_strait"]);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, {
      userId: USER.subject,
      variant: VARIANT,
      digestMode: "realtime",
    });
    expect((await readRow(t))?.chokepoints).toEqual(["taiwan_strait"]);
  });
});

describe("alertRules.chokepoints rejects a list with no known id", () => {
  test("setAlertRules throws CHOKEPOINTS_INVALID instead of widening to every chokepoint", async () => {
    const t = convexTest(schema, modules);
    await seedProEntitlement(t);
    await expect(
      t.withIdentity(USER).mutation(api.alertRules.setAlertRules, { ...base, chokepoints: ["hormuz", "Strait of Hormuz"] }),
    ).rejects.toThrow(/CHOKEPOINTS_INVALID/);
    expect(await readRow(t)).toBeNull();
  });
});

describe("/relay/notification-channels forwards chokepoints", () => {
  async function relayPost(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
    process.env.CONVEX_TENANT_RELAY_SECRET = "relay-secret";
    return await t.fetch("/relay/notification-channels", {
      method: "POST",
      headers: { Authorization: "Bearer relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER.subject, ...base, ...body }),
    });
  }

  for (const action of ["set-alert-rules", "set-notification-config"]) {
    test(`${action} stores the normalized list`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      const res = await relayPost(t, { action, chokepoints: ["KERCH_STRAIT", "suez"] });
      expect(res.status).toBe(200);
      expect((await readRow(t))?.chokepoints).toEqual(["kerch_strait", "suez"]);
    });

    test(`${action} answers 400 CHOKEPOINTS_INVALID for unknown ids`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      const res = await relayPost(t, { action, chokepoints: ["hormuz"] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("CHOKEPOINTS_INVALID");
    });

    test(`${action} rejects a non-array`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      const res = await relayPost(t, { action, chokepoints: "suez" });
      expect(res.status).toBe(400);
      expect(await readRow(t)).toBeNull();
    });
  }
});
