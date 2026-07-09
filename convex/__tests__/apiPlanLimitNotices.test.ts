import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  classifyUsageThreshold,
  getUsageRatio,
  isNoticeEmailDue,
  shouldRecoverNotice,
  MAX_EMAIL_ATTEMPTS,
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

  test("writes no rollup for a below-threshold (no-notice) scan", async () => {
    const t = convexTest(schema, modules);

    // The scanner evaluates EVERY api-access/Pro account each run and the daily
    // meter reads 0 for a missing key, so the no-notice case is the zero-usage
    // majority. Persisting a rollup for it grew apiUsageRollups O(accounts)/day
    // and outpaced the prune -- so a no-notice scan must write nothing.
    const res = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 100 }),
    });

    expect(res.rollupId).toBeNull();
    expect(res.noticeId).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("apiUsageRollups").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect())).toHaveLength(0);
  });

  test("a dead-zone rescan refreshes the live notice but adds no new rollup", async () => {
    const t = convexTest(schema, modules);

    // An over_limit scan writes exactly one rollup + notice.
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    expect(await t.run((ctx) => ctx.db.query("apiUsageRollups").collect())).toHaveLength(1);

    // A dead-zone rescan (700/1000 = 0.7): no threshold notice -> no new rollup,
    // but the live notice is still kept fresh (lastSeenAt/usage refreshed).
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 700, computedAt: NOW + 3_600_000 }),
    });

    expect(await t.run((ctx) => ctx.db.query("apiUsageRollups").collect())).toHaveLength(1);
    const notice = (await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect()))[0];
    expect(notice.current).toBe(true);
    expect(notice.lastSeenAt).toBe(NOW + 3_600_000);
    expect(notice.usage).toBe(700);
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

  test("live-notice lookups ignore accumulated non-current history", async () => {
    const t = convexTest(schema, modules);
    // Pile up superseded (current:false) history for one (user, dimension).
    await t.run(async (ctx) => {
      for (let i = 1; i <= 6; i++) {
        await ctx.db.insert("apiPlanLimitNotices", {
          userId: "user-api",
          planKey: "api_starter",
          dimension: "api_daily_requests",
          state: "over_limit",
          windowKey: `2026-06-0${i}`,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          usage: 1_500,
          limit: 1_000,
          usageRatio: 1.5,
          current: false,
          emailStatus: "sent",
          ctaKind: "contact_support",
        });
      }
    });

    // One live notice via the normal path.
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "contact_support" },
    });

    // Settings list returns only the single live, unacknowledged notice.
    const visible = await t.withIdentity(USER).query(publicFns.listCurrentForUser, {});
    expect(visible).toHaveLength(1);
    expect(visible[0].current).toBe(true);
    expect(visible[0].usage).toBe(1_200);

    // Supersede keeps exactly one current row despite the 6-row history pile.
    const currentRows = await t.run((ctx) =>
      ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_dimension_current", (q) =>
          q.eq("userId", "user-api").eq("dimension", "api_daily_requests").eq("current", true),
        )
        .collect());
    expect(currentRows).toHaveLength(1);
  });

  test("dead-zone rescans keep a live notice fresh so readiness doesn't false-stale it", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "contact_support" },
    });

    // Three hourly rescans in the dead zone (700/1000 = 0.7): no threshold
    // notice, and not recovered (recovery needs < 0.5), so recordUsageEvaluation
    // is invoked with notice undefined. The live notice must stay observed.
    for (const h of [1, 2, 3]) {
      await t.mutation(internalFns.recordUsageEvaluation, {
        rollup: rollup({ usage: 700, computedAt: NOW + h * 3_600_000 }),
        notice: undefined,
      });
    }

    const row = await t.run((ctx) => ctx.db.get(created.noticeId));
    expect(row?.current).toBe(true);
    expect(row?.lastSeenAt).toBe(NOW + 3 * 3_600_000); // tracked forward
    expect(row?.usage).toBe(700); // banner shows the live reading, not stale 1200

    // 3h05m after the first scan: NOT stale, because it was observed each hour.
    const readiness = await t.query(internalFns.getEnforcementReadiness, {
      now: NOW + 3 * 3_600_000 + 300_000,
    });
    expect(
      readiness.blocked.filter((b: { readinessReason?: string }) => b.readinessReason === "stale_notice_source"),
    ).toHaveLength(0);
  });

  test("listEmailDue is not starved by a backlog of superseded pending rows", async () => {
    const t = convexTest(schema, modules);
    const OLD = NOW - 10 * 86_400_000;
    // Backlog of dead (current:false) pending rows with OLD lastSeenAt -- these
    // sort first in the oldest-first email-due scan and, without a current-scoped
    // index, consume the whole take() budget before the live notice is reached.
    await t.run(async (ctx) => {
      for (let i = 0; i < 7; i++) {
        await ctx.db.insert("apiPlanLimitNotices", {
          userId: `dead-${i}`,
          planKey: "api_starter",
          dimension: "api_daily_requests",
          state: "over_limit",
          windowKey: `dead-${i}`,
          firstSeenAt: OLD,
          lastSeenAt: OLD + i,
          usage: 1_500,
          limit: 1_000,
          usageRatio: 1.5,
          current: false,
          emailStatus: "pending",
          ctaKind: "contact_support",
        });
      }
    });

    // One genuinely-due, current pending notice (newer lastSeenAt).
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "contact_support" },
    });

    const due = await t.query(internalFns.listEmailDue, { now: NOW + 60_000, limit: 2 });
    expect(due.map((n: { _id: unknown }) => String(n._id))).toContain(String(created.noticeId));
  });

  test("dismissal persists across a same-window rescan", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    await t.withIdentity(USER).mutation(publicFns.acknowledgeNotice, { noticeId: created.noticeId });
    expect(await t.withIdentity(USER).query(publicFns.listCurrentForUser, {})).toHaveLength(0);

    // The hourly scanner re-evaluates the same day+state an hour later. It must
    // NOT clear acknowledgedAt, or "Dismiss" would only last until the next scan.
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_300, computedAt: NOW + 3_600_000 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    expect(await t.withIdentity(USER).query(publicFns.listCurrentForUser, {})).toHaveLength(0);
  });

  test("a new window supersedes the prior window's current notice", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200, windowKey: "2026-07-02" }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_500, windowKey: "2026-07-03", computedAt: NOW + 86_400_000 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });

    const rows = await t.run((ctx) => ctx.db.query("apiPlanLimitNotices").collect());
    expect(rows).toHaveLength(2);
    const current = rows.filter((notice) => notice.current);
    expect(current).toHaveLength(1);
    expect(current[0].windowKey).toBe("2026-07-03");

    const visible = await t.withIdentity(USER).query(publicFns.listCurrentForUser, {});
    expect(visible).toHaveLength(1);
  });

  test("stops retrying a failed notice after MAX_EMAIL_ATTEMPTS", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internalFns.recordUsageEvaluation, {
      rollup: rollup({ usage: 1_200 }),
      notice: { state: "over_limit", ctaKind: "billing_portal", upgradeTargetPlanKey: "api_business" },
    });
    await t.mutation(internalFns.markEmailStatus, {
      noticeId: created.noticeId,
      emailStatus: "failed",
      emailAttempts: MAX_EMAIL_ATTEMPTS,
    });

    const due = await t.query(internalFns.listEmailDue, { now: NOW + 60_000 });
    expect(due.map((notice: { _id: unknown }) => String(notice._id)))
      .not.toContain(String(created.noticeId));
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
