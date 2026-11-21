/**
 * alertRules.reservoirAlert: the settings of the opt-in reservoir level alert. Pro-only on every
 * writer, bounded by shared/alert-rule-shape.ts, stored per account like every other scope.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { RESERVOIR_ALERT_EVENT_TYPE, RESERVOIR_ALERT_RESERVOIRS_MAX } from "../../shared/alert-rule-shape";
import reservoirLevelAlerts from "../../scripts/lib/reservoir-level-alerts.cjs";

const modules = import.meta.glob("../**/*.ts");

const ALICE = "user-reservoir-alice";
const BOB = "user-reservoir-bob";
const VARIANT = "full";

async function seedPro(t: ReturnType<typeof convexTest>, userId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey: "pro_monthly",
      features: { tier: 1, maxDashboards: 10, apiAccess: false, apiRateLimit: 0, prioritySupport: false, exportFormats: ["json"] },
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    });
  });
}

async function readRow(t: ReturnType<typeof convexTest>, userId: string) {
  return await t.run(async (ctx) => ctx.db
    .query("alertRules")
    .withIndex("by_user_variant", (q) => q.eq("userId", userId).eq("variant", VARIANT))
    .unique());
}

const base = {
  variant: VARIANT,
  enabled: true,
  eventTypes: [RESERVOIR_ALERT_EVENT_TYPE],
  sensitivity: "critical" as const,
  channels: [] as never[],
};

async function relayPost(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
  process.env.CONVEX_TENANT_RELAY_SECRET = "relay-secret";
  return await t.fetch("/relay/notification-channels", {
    method: "POST",
    headers: { Authorization: "Bearer relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("alertRules.reservoirAlert", () => {
  test("the rule gate and the relay name the same event type", () => {
    expect(RESERVOIR_ALERT_EVENT_TYPE).toBe(reservoirLevelAlerts.RESERVOIR_ALERT_EVENT_TYPE);
  });

  test("a Pro account stores its reservoirs deduped in first-seen order, with its threshold and seasonal choice", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser", "tana", "nasser"], belowPercent: 20, seasonalDrop: true },
    });
    expect((await readRow(t, ALICE))?.reservoirAlert).toEqual({ reservoirs: ["nasser", "tana"], belowPercent: 20, seasonalDrop: true });
  });

  test("preserved on omit and cleared by an empty list", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, { userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser"], seasonalDrop: true } });
    await t.mutation(internal.alertRules.setNotificationConfigForUser, { userId: ALICE, variant: VARIANT, digestMode: "realtime" });
    expect((await readRow(t, ALICE))?.reservoirAlert).toEqual({ reservoirs: ["nasser"], seasonalDrop: true });
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, eventTypes: [], reservoirAlert: { reservoirs: [] } });
    expect((await readRow(t, ALICE))?.reservoirAlert).toEqual({ reservoirs: [] });
  });

  for (const [name, args] of [
    ["the event type", { eventTypes: [RESERVOIR_ALERT_EVENT_TYPE] }],
    ["a reservoir", { eventTypes: [], reservoirAlert: { reservoirs: ["nasser"], belowPercent: 10 } }],
  ] as const) {
    test(`a free account cannot create a rule asking for ${name}`, async () => {
      const t = convexTest(schema, modules);
      for (const mutation of [internal.alertRules.setAlertRulesForUser, internal.alertRules.setNotificationConfigForUser]) {
        await expect(t.mutation(mutation, { userId: ALICE, ...base, ...args })).rejects.toThrow(/PRO_REQUIRED/);
      }
      expect(await readRow(t, ALICE)).toBeNull();
    });
  }

  test("a free account can still clear its reservoir alert", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, eventTypes: [], reservoirAlert: { reservoirs: [] } });
    expect((await readRow(t, ALICE))?.reservoirAlert).toEqual({ reservoirs: [] });
  });

  test("a threshold outside the bound, a malformed id and an oversized list are rejected", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    for (const reservoirAlert of [
      { reservoirs: ["nasser"], belowPercent: 0 },
      { reservoirs: ["nasser"], belowPercent: 51 },
      { reservoirs: ["nasser"], belowPercent: 12.5 },
      { reservoirs: ["Not A Reservoir"] },
      { reservoirs: Array.from({ length: RESERVOIR_ALERT_RESERVOIRS_MAX + 1 }, (_, i) => `r${i}`) },
    ]) {
      await expect(t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, reservoirAlert }))
        .rejects.toThrow(/RESERVOIR_ALERT_INVALID/);
    }
    expect(await readRow(t, ALICE)).toBeNull();
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser"], belowPercent: 50 } });
    expect((await readRow(t, ALICE))?.reservoirAlert?.belowPercent).toBe(50);
  });

  test("one account cannot read or change another account's rule", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await seedPro(t, BOB);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser"], belowPercent: 10 } });
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: BOB, ...base, reservoirAlert: { reservoirs: ["tana"], seasonalDrop: true } });
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: BOB, ...base, reservoirAlert: { reservoirs: [] } });
    expect((await readRow(t, ALICE))?.reservoirAlert).toEqual({ reservoirs: ["nasser"], belowPercent: 10 });
    const bobRules = await t.query(internal.alertRules.getAlertRulesByUserId, { userId: BOB });
    expect(bobRules.map((rule) => [rule.userId, rule.reservoirAlert])).toEqual([[BOB, { reservoirs: [] }]]);
  });
});

describe("/relay/notification-channels forwards reservoirAlert", () => {
  for (const action of ["set-alert-rules", "set-notification-config"]) {
    test(`${action} stores the settings, rejects a bad one and answers a free account with 402`, async () => {
      const t = convexTest(schema, modules);
      await seedPro(t, ALICE);
      const settings = { reservoirs: ["nasser"], belowPercent: 15, seasonalDrop: true };
      const ok = await relayPost(t, { action, userId: ALICE, ...base, reservoirAlert: settings });
      expect(ok.status).toBe(200);
      expect((await readRow(t, ALICE))?.reservoirAlert).toEqual(settings);

      const bad = await relayPost(t, { action, userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser"], belowPercent: 99 } });
      expect([bad.status, (await bad.json()).error]).toEqual([400, "RESERVOIR_ALERT_INVALID"]);
      const extra = await relayPost(t, { action, userId: ALICE, ...base, reservoirAlert: { reservoirs: ["nasser"], mode: "x" } });
      expect(extra.status).toBe(400);
      expect((await readRow(t, ALICE))?.reservoirAlert).toEqual(settings);

      const free = await relayPost(t, { action, userId: BOB, ...base, reservoirAlert: settings });
      expect([free.status, (await free.json()).error]).toEqual([402, "PRO_REQUIRED"]);
      expect(await readRow(t, BOB)).toBeNull();
    });
  }
});
