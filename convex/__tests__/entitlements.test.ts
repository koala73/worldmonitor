import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";

const modules = import.meta.glob("../**/*.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const FUTURE = NOW + 86400000 * 30; // 30 days from now
const PAST = NOW - 86400000; // 1 day ago

async function seedEntitlement(
  t: ReturnType<typeof convexTest>,
  overrides: {
    userId?: string;
    planKey?: string;
    validUntil?: number;
    updatedAt?: number;
  } = {},
) {
  const planKey = overrides.planKey ?? "pro_monthly";
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId: overrides.userId ?? "user-test",
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil: overrides.validUntil ?? FUTURE,
      updatedAt: overrides.updatedAt ?? NOW,
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("entitlement query", () => {
  test("public query returns free-tier defaults when unauthenticated", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(api.entitlements.getEntitlementsForUser, {});

    expect(result.planKey).toBe("free");
    expect(result.features.tier).toBe(0);
    expect(result.features.apiAccess).toBe(false);
    expect(result.validUntil).toBe(0);
  });

  test("returns free-tier defaults for unknown userId", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-nonexistent",
    });

    expect(result.planKey).toBe("free");
    expect(result.features.tier).toBe(0);
    expect(result.features.apiAccess).toBe(false);
    expect(result.validUntil).toBe(0);
  });

  test("returns active entitlements for subscribed user", async () => {
    const t = convexTest(schema, modules);

    await seedEntitlement(t, {
      userId: "user-pro",
      planKey: "pro_monthly",
      validUntil: FUTURE,
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-pro",
    });

    expect(result.planKey).toBe("pro_monthly");
    expect(result.features.tier).toBe(1);
    expect(result.features.apiAccess).toBe(false);
  });

  test("returns free-tier for expired entitlements", async () => {
    const t = convexTest(schema, modules);

    await seedEntitlement(t, {
      userId: "user-expired",
      planKey: "pro_monthly",
      validUntil: PAST,
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-expired",
    });

    expect(result.planKey).toBe("free");
    expect(result.features.tier).toBe(0);
    expect(result.features.apiAccess).toBe(false);
    expect(result.validUntil).toBe(0);
  });

  test("returns correct tier for api_starter plan", async () => {
    const t = convexTest(schema, modules);

    await seedEntitlement(t, {
      userId: "user-api",
      planKey: "api_starter",
      validUntil: FUTURE,
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-api",
    });

    expect(result.features.tier).toBe(2);
    expect(result.features.apiAccess).toBe(true);
  });

  test("returns correct tier for enterprise plan", async () => {
    const t = convexTest(schema, modules);

    await seedEntitlement(t, {
      userId: "user-enterprise",
      planKey: "enterprise",
      validUntil: FUTURE,
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-enterprise",
    });

    expect(result.features.tier).toBe(3);
    expect(result.features.apiAccess).toBe(true);
    expect(result.features.prioritySupport).toBe(true);
  });

  test("getFeaturesForPlan throws on unknown plan key", () => {
    expect(() => getFeaturesForPlan("nonexistent_plan")).toThrow(
      /Unknown planKey "nonexistent_plan"/,
    );
  });

  test("does not throw when duplicate entitlement rows exist for same userId", async () => {
    const t = convexTest(schema, modules);

    // Seed two rows for the same userId (simulates concurrent webhook retry scenario)
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: "user-dup",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: FUTURE,
        updatedAt: NOW,
      });
      await ctx.db.insert("entitlements", {
        userId: "user-dup",
        planKey: "pro_monthly",
        features: getFeaturesForPlan("pro_monthly"),
        validUntil: FUTURE,
        updatedAt: NOW + 1,
      });
    });

    // Internal query must not throw (uses .first() not .unique())
    await expect(
      t.query(internal.entitlements.getEntitlementsByUserId, { userId: "user-dup" }),
    ).resolves.toMatchObject({ planKey: "pro_monthly" });
  });
});
