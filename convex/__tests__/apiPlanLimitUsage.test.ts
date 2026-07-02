import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { getFeaturesForPlan } from "../lib/entitlements";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const usageFns = (internal as any).apiPlanLimitUsage;

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 30 * 86_400_000;

async function seedEntitlement(t: ReturnType<typeof convexTest>, userId: string, planKey: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("entitlements", {
      userId,
      planKey,
      features: getFeaturesForPlan(planKey),
      validUntil: FUTURE,
      updatedAt: NOW,
    });
  });
}

describe("api plan-limit usage scanner", () => {
  test("dry run reports would-notify without mutating notice state", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      dryRun: true,
      now: NOW,
      rows: [{
        userId: "user-api",
        dimension: "api_daily_requests",
        usage: 850,
        source: "test",
      }],
    });

    expect(summary).toMatchObject({
      dryRun: true,
      evaluated: 1,
      wouldNotify: 1,
      notified: 0,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(0);
  });

  test("records over-limit API Starter notice and blocks readiness when Business is not self-serve", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-api", "api_starter");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-api",
        dimension: "api_daily_requests",
        usage: 1_200,
        source: "test",
      }],
    });

    expect(summary.notified).toBe(1);
    expect(summary.blocked).toContainEqual({
      userId: "user-api",
      dimension: "api_daily_requests",
      reason: "api_business_not_self_serve",
    });

    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      state: "over_limit",
      ctaKind: "contact_support",
      blockedReason: "api_business_not_self_serve",
      upgradeTargetPlanKey: "api_business",
    });
  });

  test("does not emit MCP minute notices without durable limiter-hit buckets", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "mcp_minute_burst",
        usage: 75,
        source: "test",
      }],
    });

    expect(summary).toMatchObject({
      evaluated: 1,
      wouldNotify: 0,
      notified: 0,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(0);
  });

  test("emits MCP minute notices from durable limiter-hit buckets", async () => {
    const t = convexTest(schema, modules);
    await seedEntitlement(t, "user-pro", "pro_monthly");

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "user-pro",
        dimension: "mcp_minute_burst",
        usage: 90,
        minuteBuckets: [61, 62, 10, 65, 20],
        source: "axiom:mcp_rate_limit_hit",
      }],
    });

    expect(summary).toMatchObject({
      evaluated: 1,
      wouldNotify: 1,
      notified: 1,
    });
    const notices = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      dimension: "mcp_minute_burst",
      state: "sustained_burst",
      ctaKind: "checkout",
      upgradeTargetPlanKey: "api_starter",
    });
  });

  test("skips rows that cannot be joined to an active entitlement", async () => {
    const t = convexTest(schema, modules);

    const summary = await t.action(usageFns.scanApiPlanLimitUsageInternal, {
      now: NOW,
      rows: [{
        userId: "unknown-user",
        dimension: "api_daily_requests",
        usage: 2_000,
        source: "test",
      }],
    });

    expect(summary.skipped).toContainEqual({
      userId: "unknown-user",
      dimension: "api_daily_requests",
      reason: "unknown_or_inactive_entitlement",
    });
  });
});
