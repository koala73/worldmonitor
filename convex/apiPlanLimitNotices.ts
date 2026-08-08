import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
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
// Give up re-sending a `failed` notice after this many attempts so a
// permanently undeliverable recipient (hard bounce, bad address) stops being
// retried on every hourly scan — and stops failing the delivery cron forever.
// The notice stays `failed`, so getEnforcementReadiness still blocks hard
// enforcement for that user (we could not reach them).
export const MAX_EMAIL_ATTEMPTS = 6;

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

  // A non-positive plan limit means the dimension is not part of this plan's
  // allowance at all (e.g. Pro carries apiBurstRequestsPerMinute:0). Resolve it
  // BEFORE the burst-bucket branch: otherwise a 0 limit turns `value > limit`
  // into "any active minute", so a handful of ordinary requests would classify
  // as a phantom sustained_burst. Handling it first makes burst and daily dims
  // agree — any usage is over_limit, none is a no-op.
  if (limit <= 0) {
    return usage > 0 ? "over_limit" : null;
  }

  if (isBurstDimension(dimension)) {
    const buckets = (input.minuteBuckets ?? []).slice(-SUSTAINED_BURST_BUCKETS);
    const overLimit = buckets.filter((value) => value > limit).length;
    return overLimit >= SUSTAINED_BURST_MIN_OVER_LIMIT ? "sustained_burst" : null;
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
  // Coarse, scan-frequency-independent key for NOTICE dedupe (the rollup keeps
  // the fine `windowKey`). Optional so direct-mutation callers/tests that don't
  // set it fall back to `windowKey` (correct for daily dims, where they match).
  noticeWindowKey: v.optional(v.string()),
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
    if (!args.notice) {
      // No threshold notice this scan. Do NOT persist an apiUsageRollups row
      // here: the scanner evaluates EVERY api-access / Pro account each run and
      // the daily meter reads 0 for a missing key, so the no-notice case is the
      // zero-usage majority -- persisting it grew apiUsageRollups by
      // O(accounts)/day and outpaced the daily prune (take(500)/day). Rollups
      // are a write-only history of threshold *events* (nothing reads them for
      // live behaviour), so they are persisted only when a notice fires (below).
      // We still keep any live notice fresh (dead zone, ratio in [0.5, 0.8)) so
      // getEnforcementReadiness doesn't mark it stale_notice_source; a genuine
      // recovery (ratio < 0.5) is handled by the scanner's
      // clearRecoveredCurrentNotices.
      const openNotices = await ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_dimension_current", (q) =>
          q
            .eq("userId", args.rollup.userId)
            .eq("dimension", args.rollup.dimension)
            .eq("current", true),
        )
        .collect();
      for (const open of openNotices) {
        await ctx.db.patch(open._id, {
          lastSeenAt: args.rollup.computedAt,
          usage: args.rollup.usage,
          usageRatio: ratio,
        });
      }
      return { rollupId: null, noticeId: null };
    }

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

    const now = args.rollup.computedAt;
    const noticeWindowKey = args.rollup.noticeWindowKey ?? args.rollup.windowKey;
    const existingNotice = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_notice_dedupe", (q) =>
        q
          .eq("userId", args.rollup.userId)
          .eq("planKey", args.rollup.planKey)
          .eq("dimension", args.rollup.dimension)
          .eq("state", args.notice!.state)
          .eq("windowKey", noticeWindowKey),
      )
      .first();

    // Supersede every OTHER notice that is still `current` for this
    // (user, dimension) — whether it differs by state (severity escalation)
    // or by windowKey (a new day/minute opened). Without the windowKey sweep,
    // a user who stays over the limit accumulates one lingering `current`
    // notice per window (per day for daily dims, per hourly scan for burst
    // dims), and the Settings UI stacks duplicate banners. Only the notice we
    // are about to upsert (same state + window) stays current, so at most one
    // live notice exists per dimension.
    // Query the current-scoped index directly instead of scanning the full
    // per-(user,state) history for all 3 states and filtering `current` in
    // memory -- the table grows without bound as superseded rows accumulate, so
    // the old post-index filter read O(lifetime notices) on this hot path.
    const priorCurrent = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_user_dimension_current", (q) =>
        q
          .eq("userId", args.rollup.userId)
          .eq("dimension", args.rollup.dimension)
          .eq("current", true),
      )
      .collect();
    for (const prior of priorCurrent) {
      if (existingNotice && prior._id === existingNotice._id) continue;
      await ctx.db.patch(prior._id, { current: false, lastSeenAt: now });
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
      // Preserve `acknowledgedAt`: an hourly rescan of the SAME state+window
      // must not silently un-dismiss a notice the user already dismissed —
      // otherwise "Dismiss" lasts under an hour. A genuine escalation lands on
      // a different dedupe key (new state) and inserts a fresh, un-acknowledged
      // notice below, so escalations still re-surface.
      await ctx.db.patch(existingNotice._id, noticePatch);
      return { rollupId, noticeId: existingNotice._id };
    }

    const noticeId = await ctx.db.insert("apiPlanLimitNotices", {
      userId: args.rollup.userId,
      planKey: args.rollup.planKey,
      dimension: args.rollup.dimension,
      state: args.notice.state,
      windowKey: noticeWindowKey,
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
    const notices = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_user_dimension_current", (q) =>
        q.eq("userId", args.userId).eq("dimension", args.dimension).eq("current", true),
      )
      .collect();
    for (const notice of notices) {
      await ctx.db.patch(notice._id, {
        current: false,
        lastSeenAt: args.recoveredAt,
      });
      cleared += 1;
    }
    return { cleared };
  },
});

/**
 * Distinct (userId, dimension) pairs that still have a `current` notice.
 *
 * Used by the usage scanner's stale-notice recovery sweep: burst notices (and
 * any notice for a user who has gone idle) never appear in a later scan's
 * usage rows, so the per-row recovery path never fires for them. The scanner
 * diffs this set against the users it actually evaluated and clears the ones
 * whose source is healthy but produced no usage — i.e. they have recovered.
 *
 * Reads through the `by_current` index so it scans only live notices, not the
 * whole historical table.
 */
export const listCurrentNoticeKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const current = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_current", (q) => q.eq("current", true))
      .collect();
    const seen = new Map<string, { userId: string; dimension: ApiPlanLimitDimension }>();
    for (const notice of current) {
      seen.set(`${notice.userId}::${notice.dimension}`, {
        userId: notice.userId,
        dimension: notice.dimension,
      });
    }
    return [...seen.values()];
  },
});

export const listCurrentForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const notices = [];
    // One indexed query per dimension returns only that dimension's live
    // notice(s) -- at most one after supersession -- instead of scanning the
    // user's full per-state history and filtering `current` in memory.
    for (const dimension of API_PLAN_LIMIT_DIMENSIONS) {
      const rows = await ctx.db
        .query("apiPlanLimitNotices")
        .withIndex("by_user_dimension_current", (q) =>
          q.eq("userId", userId).eq("dimension", dimension).eq("current", true),
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
    // Scope to `current` in the INDEX so a backlog of superseded (current:false)
    // pending/failed rows -- which sort first by oldest lastSeenAt -- can never
    // consume the take() budget and starve genuinely-due live notices.
    const pending = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_email_due", (q) => q.eq("current", true).eq("emailStatus", "pending"))
      .take(max * 3);
    const failed = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_email_due", (q) => q.eq("current", true).eq("emailStatus", "failed"))
      .take(max);
    const candidates = [...pending, ...failed];
    return candidates
      .filter((notice) => {
        if (!notice.current) return false;
        // A `failed` notice is retried until MAX_EMAIL_ATTEMPTS, then dropped
        // from the due set for good. It stays `failed` in the table so the
        // readiness gate keeps enforcement blocked — but it no longer gets
        // re-sent every scan or keeps the delivery cron throwing forever.
        if (notice.emailStatus === "failed") {
          return (notice.emailAttempts ?? 0) < MAX_EMAIL_ATTEMPTS;
        }
        return isNoticeEmailDue({
          state: notice.state,
          lastEmailedAt: notice.lastEmailedAt,
          now: args.now,
        });
      })
      .slice(0, max);
  },
});

export const markEmailStatus = internalMutation({
  args: {
    noticeId: v.id("apiPlanLimitNotices"),
    emailStatus: emailStatusValidator,
    emailedAt: v.optional(v.number()),
    emailAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const notice = await ctx.db.get(args.noticeId);
    if (!notice) return { ok: false };
    await ctx.db.patch(args.noticeId, {
      emailStatus: args.emailStatus,
      lastEmailedAt: args.emailedAt ?? notice.lastEmailedAt,
      ...(args.emailAttempts !== undefined ? { emailAttempts: args.emailAttempts } : {}),
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
    // Scan only live notices through `by_current` — the table grows without
    // bound as historical (non-current) notices pile up, so a full `.collect()`
    // would eventually blow past Convex's per-query scan limit and make the
    // readiness gate throw instead of answering.
    const current = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_current", (q) => q.eq("current", true))
      .collect();
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

// Retention for the plan-limit tables. Both grow continuously -- apiUsageRollups
// gains one row per user per hourly scan (burst windows are minute-grained) and
// apiPlanLimitNotices accumulates superseded (current:false) rows forever, and
// neither has a native TTL. 90 days keeps a comfortable audit window.
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Per-run, per-table delete cap so one invocation stays under Convex's
// per-mutation write limit; a larger backlog drains over subsequent daily runs.
const PRUNE_BATCH = 500;

export const pruneApiPlanLimitData = internalMutation({
  args: {
    now: v.optional(v.number()),
    retentionMs: v.optional(v.number()),
    // Per-run, per-table delete cap. Optional so tests can drive the drain-over-
    // multiple-runs behavior without seeding PRUNE_BATCH rows.
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const cutoff = now - (args.retentionMs ?? RETENTION_MS);
    const batch = args.limit ?? PRUNE_BATCH;

    // Superseded notices older than the retention window. The by_current index
    // scopes the scan to current:false, so an active notice is never read or
    // deleted regardless of its age.
    const staleNotices = await ctx.db
      .query("apiPlanLimitNotices")
      .withIndex("by_current", (q) => q.eq("current", false).lt("lastSeenAt", cutoff))
      .take(batch);
    for (const notice of staleNotices) {
      await ctx.db.delete(notice._id);
    }

    // Rollups older than the retention window (audit records with no live reader).
    const staleRollups = await ctx.db
      .query("apiUsageRollups")
      .withIndex("by_computedAt", (q) => q.lt("computedAt", cutoff))
      .take(batch);
    for (const rollup of staleRollups) {
      await ctx.db.delete(rollup._id);
    }

    // Self-drain: a full batch on either table means more aged rows remain past
    // the cutoff. Reschedule immediately (carrying the SAME resolved `now` so
    // the cutoff stays fixed across the chain) until both tables drain below the
    // batch size. Without this, one daily run deletes at most `batch` rows per
    // table, so a backlog larger than `batch` (e.g. a mass-supersede event, or
    // the first prune 90 days after launch) would take many days to clear and
    // the tables could stay above their intended bound between runs.
    const rescheduled = staleNotices.length >= batch || staleRollups.length >= batch;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.apiPlanLimitNotices.pruneApiPlanLimitData, {
        now,
        retentionMs: args.retentionMs,
        limit: batch,
      });
    }

    return {
      noticesDeleted: staleNotices.length,
      rollupsDeleted: staleRollups.length,
      rescheduled,
    };
  },
});
