/**
 * alertRules.orbitalSites: the watched-site scope of the opt-in watched-site
 * alerts. Pro-only on every writer, bounded by shared/alert-rule-shape.ts, and
 * stored per account like every other scope.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { ORBITAL_ALERT_SITES_MAX, ORBITAL_SITE_ALERT_EVENT_TYPES } from "../../shared/alert-rule-shape";
import orbitalSiteAlerts from "../../scripts/lib/orbital-site-alerts.cjs";

const modules = import.meta.glob("../**/*.ts");

const ALICE = "user-orbital-alice";
const BOB = "user-orbital-bob";
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
  eventTypes: ["orbital_site_change", "orbital_imaging_window"],
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

describe("alertRules.orbitalSites", () => {
  test("the rule gate and the relay name the same event types", () => {
    expect([...ORBITAL_SITE_ALERT_EVENT_TYPES]).toEqual(orbitalSiteAlerts.ORBITAL_SITE_EVENT_TYPES);
  });

  test("a Pro account stores its watched sites, deduped in first-seen order", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await t.mutation(internal.alertRules.setAlertRulesForUser, {
      userId: ALICE, ...base, orbitalSites: ["chokepoint:hormuz_strait", "conflict-zone:sudan", "chokepoint:hormuz_strait"],
    });
    const row = await readRow(t, ALICE);
    expect(row?.orbitalSites).toEqual(["chokepoint:hormuz_strait", "conflict-zone:sudan"]);
    expect(row?.eventTypes).toEqual(["orbital_site_change", "orbital_imaging_window"]);
  });

  test("preserved on omit and cleared by []", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await t.mutation(internal.alertRules.setNotificationConfigForUser, { userId: ALICE, ...base, orbitalSites: ["conflict-zone:sudan"] });
    await t.mutation(internal.alertRules.setNotificationConfigForUser, { userId: ALICE, variant: VARIANT, digestMode: "realtime" });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual(["conflict-zone:sudan"]);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: [] });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual([]);
  });

  for (const [name, args] of [
    ["the event type", { eventTypes: ["orbital_site_change"] }],
    ["a watched site", { eventTypes: [], orbitalSites: ["conflict-zone:sudan"] }],
  ] as const) {
    test(`a free account cannot create a rule asking for ${name}`, async () => {
      const t = convexTest(schema, modules);
      for (const mutation of [internal.alertRules.setAlertRulesForUser, internal.alertRules.setNotificationConfigForUser]) {
        await expect(t.mutation(mutation, { userId: ALICE, ...base, ...args })).rejects.toThrow(/PRO_REQUIRED/);
      }
      expect(await readRow(t, ALICE)).toBeNull();
    });
  }

  test("a free account can still clear its watched-site alerts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, eventTypes: [], orbitalSites: [] });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual([]);
  });

  test("a rule with more sites than the shape bound is rejected", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    const tooMany = Array.from({ length: ORBITAL_ALERT_SITES_MAX + 1 }, (_, i) => `military-base:site_${i}`);
    await expect(t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: tooMany }))
      .rejects.toThrow(/ORBITAL_SITES_INVALID/);
    await expect(t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: ["Not a site id"] }))
      .rejects.toThrow(/ORBITAL_SITES_INVALID/);
    expect(await readRow(t, ALICE)).toBeNull();
    const atBound = tooMany.slice(0, ORBITAL_ALERT_SITES_MAX);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: atBound });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual(atBound);
  });

  test("accepts every id the watched-site registry publishes", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    const nbsp = "military-base:british_gurkha\u00a0dharan";
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: [nbsp] });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual([nbsp]);
  });

  test("one account cannot read or change another account's rule", async () => {
    const t = convexTest(schema, modules);
    await seedPro(t, ALICE);
    await seedPro(t, BOB);
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: ALICE, ...base, orbitalSites: ["conflict-zone:sudan"] });
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: BOB, ...base, orbitalSites: ["chokepoint:suez"] });
    await t.mutation(internal.alertRules.setAlertRulesForUser, { userId: BOB, ...base, orbitalSites: [] });
    expect((await readRow(t, ALICE))?.orbitalSites).toEqual(["conflict-zone:sudan"]);
    const bobRules = await t.query(internal.alertRules.getAlertRulesByUserId, { userId: BOB });
    expect(bobRules.map((rule) => [rule.userId, rule.orbitalSites])).toEqual([[BOB, []]]);
  });
});

describe("/relay/notification-channels forwards orbitalSites", () => {
  for (const action of ["set-alert-rules", "set-notification-config"]) {
    test(`${action} stores the list, rejects an oversized one and answers a free account with 402`, async () => {
      const t = convexTest(schema, modules);
      await seedPro(t, ALICE);
      const ok = await relayPost(t, { action, userId: ALICE, ...base, orbitalSites: ["conflict-zone:sudan"] });
      expect(ok.status).toBe(200);
      expect((await readRow(t, ALICE))?.orbitalSites).toEqual(["conflict-zone:sudan"]);

      const tooMany = Array.from({ length: ORBITAL_ALERT_SITES_MAX + 1 }, (_, i) => `military-base:site_${i}`);
      const oversized = await relayPost(t, { action, userId: ALICE, ...base, orbitalSites: tooMany });
      expect([oversized.status, (await oversized.json()).error]).toEqual([400, "ORBITAL_SITES_INVALID"]);

      const free = await relayPost(t, { action, userId: BOB, ...base, orbitalSites: ["conflict-zone:sudan"] });
      expect([free.status, (await free.json()).error]).toEqual([402, "PRO_REQUIRED"]);
      expect(await readRow(t, BOB)).toBeNull();
    });
  }
});
