import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";

export const API_PLAN_LIMIT_DIMENSIONS = [
  "api_daily_requests",
  "api_minute_burst",
  "mcp_daily_calls",
  "mcp_minute_burst",
] as const;

export type ApiPlanLimitDimension = (typeof API_PLAN_LIMIT_DIMENSIONS)[number];

export const API_PLAN_LIMIT_NOTICE_STATES = [
  "warning",
  "over_limit",
  "sustained_burst",
] as const;

export type ApiPlanLimitNoticeState = (typeof API_PLAN_LIMIT_NOTICE_STATES)[number];

export type ApiPlanLimitEmailStatus =
  | "pending"
  | "sent"
  | "skipped"
  | "suppressed"
  | "failed";

export type ApiPlanLimitCtaKind =
  | "checkout"
  | "billing_portal"
  | "contact_support"
  | "none";

export type UsageThresholdInput = {
  dimension: ApiPlanLimitDimension;
  usage: number;
  limit: number | null;
  minuteBuckets?: number[];
};

const WARNING_RATIO = 0.8;
const SUSTAINED_BURST_BUCKETS = 5;
const SUSTAINED_BURST_MIN_OVER_LIMIT = 3;
const WARNING_EMAIL_CADENCE_MS = 24 * 60 * 60 * 1000;
const OVER_LIMIT_EMAIL_CADENCE_MS = 24 * 60 * 60 * 1000;
const BURST_EMAIL_CADENCE_MS = 6 * 60 * 60 * 1000;

const dimensionValidator = v.union(
  v.literal("api_daily_requests"),
  v.literal("api_minute_burst"),
  v.literal("mcp_daily_calls"),
  v.literal("mcp_minute_burst"),
);

const noticeStateValidator = v.union(
  v.literal("warning"),
  v.literal("over_limit"),
  v.literal("sustained_burst"),
);

const emailStatusValidator = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("skipped"),
  v.literal("suppressed"),
  v.literal("failed"),
);

const ctaKindValidator = v.union(
  v.literal("checkout"),
  v.literal("billing_portal"),
  v.literal("contact_support"),
  v.literal("none"),
);

function usageRatio(usage: number, limit: number | null): number | null {
  if (limit == null) return null;
  if (limit <= 0) return usage > 0 ? null : 0;
  return usage / limit;
}

function isBurstDimension(dimension: ApiPlanLimitDimension): boolean {
  return dimension === "api_minute_burst" || dimension === "mcp_minute_burst";
}

export function classifyUsageThreshold(
  input: UsageThresholdInput,
): ApiPlanLimitNoticeState | null {
  const { dimension, usage, limit } = input;
  if (limit == null) return null;

  if (isBurstDimension(dimension)) {
    const buckets = (input.minuteBuckets ?? []).slice(-SUSTAINED_BURST_BUCKETS);
    const overLimit = buckets.filter((value) => value > limit).length;
    return overLimit >= SUSTAINED_BURST_MIN_OVER_LIMIT ? "sustained_burst" : null;
  }

  if (limit <= 0) {
    return usage > 0 ? "over_limit" : null;
  }
  if (usage >= limit) return "over_limit";
  if (usage >= limit * WARNING_RATIO) return "warning";
  return null;
}

export function getUsageRatio(usage: number, limit: number | null): number | null {
  return usageRatio(usage, limit);
}

export function getEmailCadenceMs(state: ApiPlanLimitNoticeState): number {
  if (state === "sustained_burst") return BURST_EMAIL_CADENCE_MS;
  if (state === "over_limit") return OVER_LIMIT_EMAIL_CADENCE_MS;
  return WARNING_EMAIL_CADENCE_MS;
}

export function isNoticeEmailDue(args: {
  state: ApiPlanLimitNoticeState;
  lastEmailedAt?: number;
  now: number;
}): boolean {
  if (!args.lastEmailedAt) return true;
  return args.now - args.lastEmailedAt >= getEmailCadenceMs(args.state);
}

export function shouldRecoverNotice(args: {
  dimension: ApiPlanLimitDimension;
  usageRatio: number | null;
  usage: number;
  limit: number | null;
}): boolean {
  if (args.limit == null) return true;
  if (isBurstDimension(args.dimension)) return args.usage <= args.limit;
  return args.usageRatio != null && args.usageRatio < 0.5;
}

function emailStatusAfterRescan(args: {
  currentStatus?: ApiPlanLimitEmailStatus;
  state: ApiPlanLimitNoticeState;
  lastEmailedAt?: number;
  now: number;
}): ApiPlanLimitEmailStatus {
  if (!args.currentStatus || args.currentStatus === "pending") return "pending";
  if (args.currentStatus === "failed") return "failed";
  return isNoticeEmailDue({
    state: args.state,
    lastEmailedAt: args.lastEmailedAt,
    now: args.now,
  })
    ? "pending"
    : args.currentStatus;
}

const rollupValidator = v.object({
  userId: v.string(),
  planKey: v.string(),
  dimension: dimensionValidator,
  windowKey: v.string(),
  windowStart: v.number(),
  windowEnd: v.number(),
  limit: v.union(v.number(), v.null()),
  usage: v.number(),
  source: v.string(),
  sourceFreshAt: v.number(),
  computedAt: v.number(),
});

const noticeInputValidator = v.object({
  state: noticeStateValidator,
  upgradeTargetPlanKey: v.optional(v.string()),
  ctaKind: ctaKindValidator,
  blockedReason: v.optional(v.string()),
});

export const recordUsageEvaluation = internalMutation({
  args: {
    rollup: rollupValidator,
    notice: v.optional(noticeInputValidator),
  },
  handler: async (ctx, args) => {
    const ratio = usageRatio(args.rollup.usage, args.rollup.limit);
    const existingRollups = await ctx.db
      .query("apiUsageRollups")
      .withIndex("by_user_window", (q) =>
        q.eq("userId", args.rollup.userId).eq("windowKey", args.rollup.windowKey),
      )
      .filter((q) => q.eq(q.field("dimension"), args.rollup.dimension))
      .collect();

    const rollupPatch = {
      planKey: args.rollup.planKey,
      windowStart: args.rollup.windowStart,
      windowEnd: args.rollup.windowEnd,
      limit: args.rollup.limit,
      usage: args.rollup.usage,
      usageRatio: ratio,
      source: args.rollup.source,
      sourceFreshAt: args.rollup.sourceFreshAt,
      computedAt: args.rollup.computedAt,
    };

    let rollupId = existingRollups[0]?._id;
    if (rollupId) {
      await ctx.db.patch(rollupId, rollupPatch);
    } else {
      rollupId = await ctx.db.insert("apiUsageRollups", {
        userId: args.rollup.userId,
        dimension: args.rollup.dimension,
        windowKey: args.rollup.windowKey,
        ...rollupPatch,
      });
    }

    if (!args.notice) {
      return { rollupId, noticeId: null };
    }

    const now = args.rollup.computedAt;
    const existingNotice = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_notice_dedupe", (q) =>
        q
          .eq("userId", args.rollup.userId)
          .eq("planKey", args.rollup.planKey)
          .eq("dimension", args.rollup.dimension)
          .eq("state", args.notice!.state)
          .eq("windowKey", args.rollup.windowKey),
      )
      .first();

    for (const state of API_PLAN_LIMIT_NOTICE_STATES) {
      if (state === args.notice.state) continue;
      const superseded = await ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_notice_dedupe", (q) =>
          q
            .eq("userId", args.rollup.userId)
            .eq("planKey", args.rollup.planKey)
            .eq("dimension", args.rollup.dimension)
            .eq("state", state)
            .eq("windowKey", args.rollup.windowKey),
        )
        .first();
      if (superseded?.current) {
        await ctx.db.patch(superseded._id, {
          current: false,
          lastSeenAt: now,
        });
      }
    }

    const noticePatch = {
      usage: args.rollup.usage,
      limit: args.rollup.limit,
      usageRatio: ratio,
      current: true,
      lastSeenAt: now,
      emailStatus: emailStatusAfterRescan({
        currentStatus: existingNotice?.emailStatus,
        state: args.notice.state,
        lastEmailedAt: existingNotice?.lastEmailedAt,
        now,
      }),
      upgradeTargetPlanKey: args.notice.upgradeTargetPlanKey,
      ctaKind: args.notice.ctaKind,
      blockedReason: args.notice.blockedReason,
    };

    if (existingNotice) {
      await ctx.db.patch(existingNotice._id, {
        ...noticePatch,
        acknowledgedAt: undefined,
      });
      return { rollupId, noticeId: existingNotice._id };
    }

    const noticeId = await ctx.db.insert("apiPlanLimitNotices", {
      userId: args.rollup.userId,
      planKey: args.rollup.planKey,
      dimension: args.rollup.dimension,
      state: args.notice.state,
      windowKey: args.rollup.windowKey,
      firstSeenAt: now,
      ...noticePatch,
    });

    return { rollupId, noticeId };
  },
});

export const clearRecoveredCurrentNotices = internalMutation({
  args: {
    userId: v.string(),
    dimension: dimensionValidator,
    recoveredAt: v.number(),
  },
  handler: async (ctx, args) => {
    let cleared = 0;
    for (const state of API_PLAN_LIMIT_NOTICE_STATES) {
      const notices = await ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_state", (q) => q.eq("userId", args.userId).eq("state", state))
        .filter((q) =>
          q.and(
            q.eq(q.field("dimension"), args.dimension),
            q.eq(q.field("current"), true),
          ),
        )
        .collect();
      for (const notice of notices) {
        await ctx.db.patch(notice._id, {
          current: false,
          lastSeenAt: args.recoveredAt,
        });
        cleared += 1;
      }
    }
    return { cleared };
  },
});

export const listCurrentForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const notices = [];
    for (const state of API_PLAN_LIMIT_NOTICE_STATES) {
      const rows = await ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_state", (q) => q.eq("userId", userId).eq("state", state))
        .filter((q) =>
          q.eq(q.field("current"), true),
        )
        .collect();
      notices.push(...rows.filter((notice) => notice.acknowledgedAt === undefined));
    }
    return notices.sort((a, b) => {
      const severity = (state: ApiPlanLimitNoticeState) =>
        state === "over_limit" ? 3 : state === "sustained_burst" ? 2 : 1;
      const severityDiff = severity(b.state) - severity(a.state);
      return severityDiff || b.lastSeenAt - a.lastSeenAt;
    });
  },
});

export const acknowledgeNotice = mutation({
  args: { noticeId: v.id("apiPlanLimitNotices") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const notice = await ctx.db.get(args.noticeId);
    if (!notice || notice.userId !== userId) {
      throw new ConvexError("NOTICE_NOT_FOUND");
    }
    await ctx.db.patch(args.noticeId, { acknowledgedAt: Date.now() });
    return { ok: true };
  },
});

export const listEmailDue = internalQuery({
  args: {
    now: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const max = args.limit ?? 100;
    const pending = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_email_due", (q) => q.eq("emailStatus", "pending"))
      .take(max * 3);
    const failed = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_email_due", (q) => q.eq("emailStatus", "failed"))
      .take(max);
    const candidates = [...pending, ...failed];
    return candidates
      .filter((notice) =>
        notice.current &&
        isNoticeEmailDue({
          state: notice.state,
          lastEmailedAt: notice.lastEmailedAt,
          now: args.now,
        }),
      )
      .slice(0, max);
  },
});

export const markEmailStatus = internalMutation({
  args: {
    noticeId: v.id("apiPlanLimitNotices"),
    emailStatus: emailStatusValidator,
    emailedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const notice = await ctx.db.get(args.noticeId);
    if (!notice) return { ok: false };
    await ctx.db.patch(args.noticeId, {
      emailStatus: args.emailStatus,
      lastEmailedAt: args.emailedAt ?? notice.lastEmailedAt,
    });
    return { ok: true };
  },
});

export const getEnforcementReadiness = internalQuery({
  args: {
    now: v.optional(v.number()),
    staleAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const staleAfterMs = args.staleAfterMs ?? 2 * 60 * 60 * 1000;
    const notices = await ctx.db.query("apiPlanLimitNotices").collect();
    const current = notices.filter((notice) => notice.current);
    const summary = {
      generatedAt: now,
      totalCurrent: current.length,
      notified: [] as Array<Record<string, unknown>>,
      skipped: [] as Array<Record<string, unknown>>,
      blocked: [] as Array<Record<string, unknown>>,
      unknown: [] as Array<Record<string, unknown>>,
      ready: false,
    };

    for (const notice of current) {
      const row = {
        noticeId: notice._id,
        userId: notice.userId,
        planKey: notice.planKey,
        dimension: notice.dimension,
        state: notice.state,
        windowKey: notice.windowKey,
        emailStatus: notice.emailStatus,
        blockedReason: notice.blockedReason,
        lastSeenAt: notice.lastSeenAt,
      };
      if (now - notice.lastSeenAt > staleAfterMs) {
        summary.blocked.push({ ...row, readinessReason: "stale_notice_source" });
      } else if (notice.blockedReason) {
        summary.blocked.push({ ...row, readinessReason: notice.blockedReason });
      } else if (notice.emailStatus === "sent") {
        summary.notified.push(row);
      } else if (notice.emailStatus === "skipped" || notice.emailStatus === "suppressed") {
        summary.skipped.push(row);
      } else if (notice.emailStatus === "failed") {
        summary.blocked.push({ ...row, readinessReason: "email_failed" });
      } else {
        summary.unknown.push({ ...row, readinessReason: "email_pending" });
      }
    }

    summary.ready = summary.blocked.length === 0 && summary.unknown.length === 0;
    return summary;
  },
});
