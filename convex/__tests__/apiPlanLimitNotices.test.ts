import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  classifyUsageThreshold,
  getUsageRatio,
  isNoticeEmailDue,
  shouldRecoverNotice,
} from "../apiPlanLimitNotices";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const publicFns = (api as any).apiPlanLimitNotices;
const internalFns = (internal as any).apiPlanLimitNotices;

const USER = { subject: "user-api", tokenIdentifier: "clerk|user-api" };
const NOW = 1_800_000_000_000;

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-api",
    planKey: "api_starter",
    dimension: "api_daily_requests",
    windowKey: "2026-07-02",
    windowStart: NOW,
    windowEnd: NOW + 86_400_000,
    limit: 1_000,
    usage: 850,
    source: "axiom:wm_api_usage",
    sourceFreshAt: NOW,
    computedAt: NOW,
    ...overrides,
  };
}

describe("api plan-limit classifiers", () => {
  test("classifies daily warning and over-limit thresholds", () => {
    expect(classifyUsageThreshold({
      dimension: "api_daily_requests",
      usage: 799,
      limit: 1_000,
    })).toBeNull();
    expect(classifyUsageThreshold({
      dimension: "api_daily_requests",
      usage: 800,
      limit: 1_000,
    })).toBe("warning");
    expect(classifyUsageThreshold({
      dimension: "api_daily_requests",
      usage: 1_000,
      limit: 1_000,
    })).toBe("over_limit");
  });

  test("classifies sustained burst only after three of five over-limit buckets", () => {
    expect(classifyUsageThreshold({
      dimension: "api_minute_burst",
      usage: 75,
      limit: 60,
      minuteBuckets: [10, 20, 75, 30, 40],
    })).toBeNull();
    expect(classifyUsageThreshold({
      dimension: "api_minute_burst",
      usage: 75,
      limit: 60,
      minuteBuckets: [61, 20, 75, 30, 90],
    })).toBe("sustained_burst");
  });

  test("handles unlimited and recovery cases without non-finite ratios", () => {
    expect(classifyUsageThreshold({
      dimension: "api_daily_requests",
      usage: 100_000,
      limit: null,
    })).toBeNull();
    expect(getUsageRatio(10, 0)).toBeNull();
    expect(shouldRecoverNotice({
      dimension: "api_daily_requests",
      usage: 400,
      limit: 1_000,
      usageRatio: 0.4,
    })).toBe(true);
  });

  test("dedupes email cadence by notice state", () => {
    expect(isNoticeEmailDue({ state: "warning", now: NOW })).toBe(true);
    expect(isNoticeEmailDue({
      state: "sustained_burst",
      lastEmailedAt: NOW - (5 * 60 * 60 * 1000),
      now: NOW,
    })).toBe(false);
    expect(isNoticeEmailDue({
      state: "sustained_burst",
      lastEmailedAt: NOW - (6 * 60 * 60 * 1000),
      now: NOW,
    })).toBe(true);
  });
});

describe("api plan-limit notice persistence", () => {
  test("upserts one rollup and one deduped warning notice", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup(),
      notice: { state: "warning", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    const second = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 900, computedAt: NOW + 60_000 }),
      notice: { state: "warning", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });

    expect(String(first.noticeId)).toBe(String(second.noticeId));

    const rows = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "user-api",
      state: "warning",
      usage: 900,
      current: true,
      emailStatus: "pending",
    });
  });

  test("acknowledgement hides only the current user's notice", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });

    const before = await t.withIdentity(USER).query(publicFns.listCurrentForUser, {});
    expect(before).toHaveLength(1);

    await t.withIdentity(USER).mutation(publicFns.acknowledgeNotice, {
      noticeId: created.noticeId,
    });

    const after = await t.withIdentity(USER).query(publicFns.listCurrentForUser, {});
    expect(after).toHaveLength(0);
  });

  test("recovery clears current notices for a user and dimension", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });

    const result = await t.mutation(internalFns.clearRecoveredCurrentNotices, {
      userId: "user-api",
      dimension: "api_daily_requests",
      recoveredAt: NOW + 120_000,
    });

    expect(result.cleared).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(rows[0].current).toBe(false);
  });

  test("failed email notices remain eligible for retry", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    await t.mutation(internalFns.markEmailStatus, {
      noticeId: created.noticeId,
      emailStatus: "failed",
    });

    const due = await t.query(internalFns.listEmailDue, { now: NOW + 60_000 });
    expect(due.map((notice: { _id: unknown }) => String(notice._id))).toContain(String(created.noticeId));
  });

  test("sent notice stays sent across rescans before email cadence is due", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200, planKey: "pro_monthly", dimension: "mcp_daily_calls", limit: 50 }),
      notice: { state: "over_limit", ctaKind: "checkout", upgradeTargetPlanKey: "api_starter" },
    });
    await t.mutation(internalFns.markEmailStatus, {
      noticeId: created.noticeId,
      emailStatus: "sent",
      emailedAt: NOW + 1_000,
    });

    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({
        usage: 1_300,
        planKey: "pro_monthly",
        dimension: "mcp_daily_calls",
        limit: 50,
        computedAt: NOW + 60_000,
      }),
      notice: { state: "over_limit", ctaKind: "checkout", upgradeTargetPlanKey: "api_starter" },
    });

    const rows = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      usage: 1_300,
      emailStatus: "sent",
      lastEmailedAt: NOW + 1_000,
    });
    const readiness = await t.query(internalFns.getEnforcementReadiness, { now: NOW + 120_000 });
    expect(readiness.ready).toBe(true);
    expect(readiness.unknown).toHaveLength(0);
  });

  test("escalating usage retires superseded lower-severity notices", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 850 }),
      notice: { state: "warning", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200, computedAt: NOW + 60_000 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });

    const rows = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(rows).toHaveLength(2);
    expect(rows.filter((notice) => notice.current)).toHaveLength(1);
    expect(rows.find((notice) => notice.state === "warning")).toMatchObject({
      current: false,
      lastSeenAt: NOW + 60_000,
    });
    expect(rows.find((notice) => notice.state === "over_limit")).toMatchObject({
      current: true,
      usage: 1_200,
    });

    const visible = await t.withIdentity(USER).query(publicFns.listCurrentForUser, {});
    expect(visible).toHaveLength(1);
    expect(visible[0].state).toBe("over_limit");
  });

  test("enforcement readiness blocks pending or self-serve-blocked notices", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: {
        state: "over_limit",
        ctaKind: "contact_support",
        upgradeTargetPlanKey: "api_business",
        blockedReason: "api_business_not_self_serve",
      },
    });

    const readiness = await t.query(internalFns.getEnforcementReadiness, { now: NOW + 60_000 });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocked).toHaveLength(1);
    expect(readiness.blocked[0].readinessReason).toBe("api_business_not_self_serve");
  });

  test("enforcement readiness passes after current over-limit notice is emailed", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200, planKey: "pro_monthly", dimension: "mcp_daily_calls", limit: 50 }),
      notice: { state: "over_limit", ctaKind: "checkout", upgradeTargetPlanKey: "api_starter" },
    });
    await t.mutation(internalFns.markEmailStatus, {
      noticeId: created.noticeId,
      emailStatus: "sent",
      emailedAt: NOW + 1_000,
    });

    const readiness = await t.query(internalFns.getEnforcementReadiness, { now: NOW + 60_000 });
    expect(readiness.ready).toBe(true);
    expect(readiness.notified).toHaveLength(1);
    expect(readiness.blocked).toHaveLength(0);
    expect(readiness.unknown).toHaveLength(0);
  });
});
