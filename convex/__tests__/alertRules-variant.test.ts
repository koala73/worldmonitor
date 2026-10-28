/**
 * alertRules.variant is a closed set (PREFERENCE_VARIANTS). Each write path
 * upserts one row per (userId, variant), so a free-form string let one account
 * mint unbounded rows until `getAlertRules` (by_user .collect()) passed
 * Convex's 16 MiB per-function read limit (Sentry WORLDMONITOR-16T).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { PREFERENCE_VARIANTS } from "../../shared/cloud-preferences-contract";

const modules = import.meta.glob("../**/*.ts");

const USER = { subject: "user-tests-variant", tokenIdentifier: "clerk|user-tests-variant" };
const BOGUS = "probe-variant-0001";

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

async function variantsStored(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", USER.subject))
      .collect();
    return rows.map((r) => r.variant).sort();
  });
}

const ruleArgs = { enabled: false, eventTypes: [], channels: [] };

describe("alertRules public mutations reject unknown variants", () => {
  const writes: Array<[string, (t: ReturnType<typeof convexTest>, variant: string) => Promise<unknown>]> = [
    ["setAlertRules", (t, variant) => t.withIdentity(USER).mutation(api.alertRules.setAlertRules, { variant, ...ruleArgs })],
    ["setDigestSettings", (t, variant) => t.withIdentity(USER).mutation(api.alertRules.setDigestSettings, { variant, digestMode: "daily" })],
    ["setQuietHours", (t, variant) => t.withIdentity(USER).mutation(api.alertRules.setQuietHours, { variant, quietHoursEnabled: false })],
    ["setAlertRulesForUser", (t, variant) => t.mutation(internal.alertRules.setAlertRulesForUser, { userId: USER.subject, variant, ...ruleArgs })],
    ["setDigestSettingsForUser", (t, variant) => t.mutation(internal.alertRules.setDigestSettingsForUser, { userId: USER.subject, variant, digestMode: "daily" })],
    ["setQuietHoursForUser", (t, variant) => t.mutation(internal.alertRules.setQuietHoursForUser, { userId: USER.subject, variant, quietHoursEnabled: false })],
    ["setNotificationConfigForUser", (t, variant) => t.mutation(internal.alertRules.setNotificationConfigForUser, { userId: USER.subject, variant, enabled: false })],
  ];

  for (const [name, write] of writes) {
    test(`${name} stores no row for an unknown variant`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      await expect(write(t, BOGUS)).rejects.toThrow(/variant/);
      expect(await variantsStored(t)).toEqual([]);
    });

    test(`${name} still accepts every dashboard variant`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      for (const variant of PREFERENCE_VARIANTS) await write(t, variant);
      expect(await variantsStored(t)).toEqual([...PREFERENCE_VARIANTS].sort());
    });
  }
});

describe("/relay/notification-channels answers 400 INVALID_VARIANT", () => {
  async function relayPost(t: ReturnType<typeof convexTest>, body: Record<string, unknown>) {
    process.env.CONVEX_TENANT_RELAY_SECRET = "relay-secret";
    return await t.fetch("/relay/notification-channels", {
      method: "POST",
      headers: { Authorization: "Bearer relay-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER.subject, ...body }),
    });
  }

  const actions: Array<[string, Record<string, unknown>]> = [
    ["set-alert-rules", ruleArgs],
    ["set-digest-settings", { digestMode: "daily" }],
    ["set-quiet-hours", { quietHoursEnabled: false }],
    ["set-notification-config", { enabled: false }],
  ];

  for (const [action, body] of actions) {
    test(`${action} with an unknown variant`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      const res = await relayPost(t, { action, variant: BOGUS, ...body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("INVALID_VARIANT");
      expect(await variantsStored(t)).toEqual([]);
    });

    test(`${action} with a dashboard variant`, async () => {
      const t = convexTest(schema, modules);
      await seedProEntitlement(t);
      const res = await relayPost(t, { action, variant: "energy", ...body });
      expect(res.status).toBe(200);
      expect(await variantsStored(t)).toEqual(["energy"]);
    });
  }
});

describe("purgeUnknownVariantRules", () => {
  test("deletes legacy unknown-variant rows across pages and keeps dashboard rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const row = { userId: USER.subject, enabled: false, eventTypes: [], sensitivity: "high" as const, channels: [], updatedAt: 1 };
      for (let i = 0; i < 150; i++) await ctx.db.insert("alertRules", { ...row, variant: `${BOGUS}-${i}` });
      for (const variant of PREFERENCE_VARIANTS) await ctx.db.insert("alertRules", { ...row, variant });
    });

    const preview = await t.mutation(internal.alertRules.purgeUnknownVariantRules, { cursor: null, dryRun: true });
    expect(preview.deleted).toBe(0);
    expect(preview.unknownByVariant.length).toBeGreaterThan(0);
    expect((await variantsStored(t)).length).toBe(150 + PREFERENCE_VARIANTS.length);

    let cursor: string | null = null;
    let deleted = 0;
    let calls = 0;
    do {
      const res: { deleted: number; nextCursor: string | null } =
        await t.mutation(internal.alertRules.purgeUnknownVariantRules, { cursor });
      deleted += res.deleted;
      cursor = res.nextCursor;
      calls += 1;
    } while (cursor !== null && calls < 20);

    expect(cursor).toBeNull();
    expect(calls).toBeGreaterThan(1);
    expect(deleted).toBe(150);
    expect(await variantsStored(t)).toEqual([...PREFERENCE_VARIANTS].sort());
    expect((await t.mutation(internal.alertRules.purgeUnknownVariantRules, { cursor: null })).deleted).toBe(0);
  });

  test("dry run counts variants that collide with Object.prototype keys", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const row = { userId: USER.subject, enabled: false, eventTypes: [], sensitivity: "high" as const, channels: [], updatedAt: 1 };
      for (const variant of ["constructor", "constructor", "__proto__", "toString"]) {
        await ctx.db.insert("alertRules", { ...row, variant });
      }
    });

    const preview = await t.mutation(internal.alertRules.purgeUnknownVariantRules, { cursor: null, dryRun: true });
    const byName = (a: { variant: string }, b: { variant: string }) => a.variant.localeCompare(b.variant);
    expect([...preview.unknownByVariant].sort(byName)).toEqual([
      { variant: "__proto__", variantLength: 9, count: 1 },
      { variant: "constructor", variantLength: 11, count: 2 },
      { variant: "toString", variantLength: 8, count: 1 },
    ].sort(byName));
  });

  test("dry run keeps distinct variants that share a 40-character prefix apart", async () => {
    const t = convexTest(schema, modules);
    const prefix = "x".repeat(40);
    await t.run(async (ctx) => {
      const row = { userId: USER.subject, enabled: false, eventTypes: [], sensitivity: "high" as const, channels: [], updatedAt: 1 };
      for (const variant of [`${prefix}-a`, `${prefix}-a`, `${prefix}-bb`, prefix]) {
        await ctx.db.insert("alertRules", { ...row, variant });
      }
    });

    const preview = await t.mutation(internal.alertRules.purgeUnknownVariantRules, { cursor: null, dryRun: true });
    const byLength = (a: { variantLength: number }, b: { variantLength: number }) => a.variantLength - b.variantLength;
    expect([...preview.unknownByVariant].sort(byLength)).toEqual([
      { variant: prefix, variantLength: 40, count: 1 },
      { variant: `${prefix}…`, variantLength: 42, count: 2 },
      { variant: `${prefix}…`, variantLength: 43, count: 1 },
    ]);
  });
});
