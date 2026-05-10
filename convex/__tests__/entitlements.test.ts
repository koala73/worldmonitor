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

  test("mcpAccess: free is false, paid tiers are true (plan 2026-05-10-001)", () => {
    // Free tier — must NOT grant Pro MCP access.
    expect(getFeaturesForPlan("free").mcpAccess).toBe(false);

    // All paid tiers grant MCP access.
    expect(getFeaturesForPlan("pro_monthly").mcpAccess).toBe(true);
    expect(getFeaturesForPlan("pro_annual").mcpAccess).toBe(true);
    expect(getFeaturesForPlan("api_starter").mcpAccess).toBe(true);
    expect(getFeaturesForPlan("api_starter_annual").mcpAccess).toBe(true);
    expect(getFeaturesForPlan("api_business").mcpAccess).toBe(true);
    expect(getFeaturesForPlan("enterprise").mcpAccess).toBe(true);
  });

  test("read-time catalog merge surfaces mcpAccess on legacy rows lacking the field (reviewer round-2 P1.3)", async () => {
    const t = convexTest(schema, modules);

    // Simulate a pre-U10 entitlement row: pro_monthly plan, but the stored
    // features object is the OLD shape without mcpAccess. After read-time
    // merge with the catalog, the response should surface mcpAccess: true.
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: "user-legacy",
        planKey: "pro_monthly",
        features: {
          tier: 1,
          apiAccess: false,
          apiRateLimit: 60,
          maxDashboards: 10,
          prioritySupport: false,
          exportFormats: ["csv"],
          // NO mcpAccess field — legacy shape
        },
        validUntil: FUTURE,
        updatedAt: NOW,
      });
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-legacy",
    });

    expect(result.planKey).toBe("pro_monthly");
    expect(result.features.tier).toBe(1);
    expect(result.features.mcpAccess).toBe(true); // surfaced from catalog default
  });

  test("read-time catalog merge: stored features win on conflict (per-user overrides preserved)", async () => {
    const t = convexTest(schema, modules);

    // If a stored row had mcpAccess: false (e.g. admin per-user override),
    // the merge must NOT clobber it with the catalog default.
    await t.run(async (ctx) => {
      await ctx.db.insert("entitlements", {
        userId: "user-override",
        planKey: "pro_monthly",
        features: {
          tier: 1,
          apiAccess: false,
          apiRateLimit: 60,
          maxDashboards: 10,
          prioritySupport: false,
          exportFormats: ["csv"],
          mcpAccess: false, // explicit override
        },
        validUntil: FUTURE,
        updatedAt: NOW,
      });
    });

    const result = await t.query(internal.entitlements.getEntitlementsByUserId, {
      userId: "user-override",
    });

    expect(result.features.mcpAccess).toBe(false); // override preserved
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
