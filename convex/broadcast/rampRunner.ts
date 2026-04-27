/**
 * Cron-driven broadcast ramp runner.
 *
 * Replaces the manual three-command ritual (assignAndExportWave →
 * createProLaunchBroadcast → sendProLaunchBroadcast) with a daily
 * cron that:
 *
 *   1. Reads the prior wave's `getBroadcastStats`.
 *   2. Checks bounce / complaint rates against configured thresholds.
 *   3. If thresholds tripped → halts the ramp (sets
 *      `killGateTripped`, never auto-resumes).
 *   4. If clean → advances to the next tier in `rampCurve`, runs
 *      assignAndExportWave + createProLaunchBroadcast +
 *      sendProLaunchBroadcast in one shot.
 *
 * Operator interventions:
 *
 *   npx convex run broadcast/rampRunner:initRamp '{
 *     "rampCurve": [500, 1500, 5000, 15000, 25000],
 *     "waveLabelPrefix": "wave",
 *     "waveLabelOffset": 3,
 *     "seedLastWaveBroadcastId": "<wave-2 broadcastId>",
 *     "seedLastWaveSentAt": <wave-2 sentAt epoch ms>,
 *     "seedLastWaveLabel": "wave-2",
 *     "seedLastWaveSegmentId": "<wave-2 segmentId>",
 *     "seedLastWaveAssigned": 500
 *   }'
 *   # tier 0 -> "wave-3", tier 1 -> "wave-4", etc. The offset lets
 *   # the auto-ramp pick up after manually-sent canary-250 + wave-2.
 *   # Seed args are REQUIRED when waveLabelOffset > 0 — without them
 *   # the first cron tick has no prior broadcastId to read stats from
 *   # and would silently skip the kill-gate.
 *
 *   npx convex run broadcast/rampRunner:pauseRamp '{}'
 *   npx convex run broadcast/rampRunner:resumeRamp '{}'
 *   npx convex run broadcast/rampRunner:clearKillGate '{"reason":"investigated, false alarm"}'
 *   npx convex run broadcast/rampRunner:clearPartialFailure '{"reason":"3 stamp failures retried manually"}'
 *   npx convex run broadcast/rampRunner:getRampStatus '{}'
 *   npx convex run broadcast/rampRunner:abortRamp '{}'  # full stop, sets active=false
 *
 * The cron entry that triggers `runDailyRamp` lives in
 * `convex/crons.ts`.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { WaveExportStats } from "./audienceWaveExport";

const DEFAULT_BOUNCE_KILL_THRESHOLD = 0.04;
const DEFAULT_COMPLAINT_KILL_THRESHOLD = 0.0008;

// Minimum delivered count before we trust the kill-gate stats. With
// fewer deliveries the bounce/complaint rates are too noisy. e.g., 1
// bounce out of 10 delivered = 10% bounce rate which would falsely
// trip — but that's just sample-size noise.
const MIN_DELIVERED_FOR_KILLGATE = 100;

// Minimum hours since the last wave's send before we'll fire the
// next one. Gives bounces / complaints time to flow back via the
// Resend webhook. 18h means we can't accidentally double-send if
// the cron runs more than once a day.
const MIN_HOURS_BETWEEN_WAVES = 18;

// If `assignAndExportWave` returns `assigned < count * UNDERFILL_RATIO`,
// treat the pool as drained and stop the ramp. 0.5 catches the case
// where the curve outpaces the actual remaining audience.
const UNDERFILL_RATIO = 0.5;

const RAMP_KEY = "current";

// Stale lease cutoff: if `pendingRunStartedAt` is older than this, assume the
// previous runner crashed mid-flight and allow override. The lease itself is
// cleared by every terminal outcome path (`_recordWaveSent`,
// `_recordRunOutcome`, `recoverFromPartialFailure`), so we only hit this on a
// genuine crash (e.g. Convex action timeout that kills the process between
// claim and outcome record). 30 minutes is generous — the longest legitimate
// runs (large rampCurve count) finish in seconds; 30min covers any retry
// pattern Convex's runtime would use.
const STALE_LEASE_MS = 30 * 60 * 1000;

/**
 * Doc type derived from the schema. Convex generates this from
 * `convex/schema.ts:broadcastRampConfig` so it stays in sync with
 * any future field changes — no manual mirroring.
 */
type RampConfigRow = Doc<"broadcastRampConfig">;

/* ─────────────────────────── admin mutations ─────────────────────────── */

/**
 * One-shot setup. Refuses to overwrite an existing config — operator
 * must `abortRamp` first if reconfiguring mid-launch.
 */
export const initRamp = internalMutation({
  args: {
    rampCurve: v.array(v.number()),
    waveLabelPrefix: v.string(),
    waveLabelOffset: v.optional(v.number()),
    bounceKillThreshold: v.optional(v.number()),
    complaintKillThreshold: v.optional(v.number()),
    // Seed args: pass these when starting the auto-ramp AFTER one or
    // more manually-sent waves so the first cron tick can pull
    // bounce/complaint stats from the prior (manual) wave and apply
    // the kill-gate. Without these, the first tick has no
    // `lastWaveBroadcastId` and silently skips the kill-gate — exactly
    // the failure mode flagged in PR #3473 review.
    //
    // Required as a pair when `waveLabelOffset > 0` (operational
    // signal that the ramp is resuming after manual waves). The very
    // first wave ever (offset=0) is exempt because there is no prior.
    seedLastWaveBroadcastId: v.optional(v.string()),
    seedLastWaveSentAt: v.optional(v.number()),
    seedLastWaveLabel: v.optional(v.string()),
    seedLastWaveSegmentId: v.optional(v.string()),
    seedLastWaveAssigned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.rampCurve.length === 0) {
      throw new Error("[initRamp] rampCurve must be non-empty");
    }
    if (args.rampCurve.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error("[initRamp] rampCurve entries must be positive integers");
    }
    const offset = args.waveLabelOffset ?? 0;
    const hasSeedBroadcast = !!args.seedLastWaveBroadcastId;
    const hasSeedSentAt = typeof args.seedLastWaveSentAt === "number";
    if (hasSeedBroadcast !== hasSeedSentAt) {
      throw new Error(
        "[initRamp] seedLastWaveBroadcastId and seedLastWaveSentAt must be provided together.",
      );
    }
    if (offset > 0 && !hasSeedBroadcast) {
      throw new Error(
        `[initRamp] waveLabelOffset=${offset} signals resumption after manual waves; seedLastWaveBroadcastId + seedLastWaveSentAt are required so the first cron tick can apply the kill-gate against the prior wave. Pass them, or set waveLabelOffset=0 to start a fresh ramp.`,
      );
    }
    const existing = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", RAMP_KEY))
      .first();
    if (existing) {
      throw new Error(
        `[initRamp] ramp already configured (active=${existing.active}, tier=${existing.currentTier}). Run abortRamp first if reconfiguring.`,
      );
    }
    await ctx.db.insert("broadcastRampConfig", {
      key: RAMP_KEY,
      active: true,
      rampCurve: args.rampCurve,
      currentTier: -1,
      waveLabelPrefix: args.waveLabelPrefix,
      waveLabelOffset: offset,
      bounceKillThreshold:
        args.bounceKillThreshold ?? DEFAULT_BOUNCE_KILL_THRESHOLD,
      complaintKillThreshold:
        args.complaintKillThreshold ?? DEFAULT_COMPLAINT_KILL_THRESHOLD,
      killGateTripped: false,
      lastWaveBroadcastId: args.seedLastWaveBroadcastId,
      lastWaveSentAt: args.seedLastWaveSentAt,
      lastWaveLabel: args.seedLastWaveLabel,
      lastWaveSegmentId: args.seedLastWaveSegmentId,
      lastWaveAssigned: args.seedLastWaveAssigned,
    });
    return { ok: true };
  },
});

export const pauseRamp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[pauseRamp] no ramp configured");
    await ctx.db.patch(row._id, { active: false });
    return { ok: true, prevActive: row.active };
  },
});

export const resumeRamp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[resumeRamp] no ramp configured");
    if (row.killGateTripped) {
      throw new Error(
        "[resumeRamp] kill-gate is tripped; clearKillGate first after investigating.",
      );
    }
    await ctx.db.patch(row._id, { active: true });
    return { ok: true };
  },
});

export const clearKillGate = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[clearKillGate] no ramp configured");
    if (!row.killGateTripped) {
      return { ok: true, noop: true };
    }
    await ctx.db.patch(row._id, {
      killGateTripped: false,
      killGateReason: undefined,
      lastRunStatus: `kill-gate-cleared: ${reason.slice(0, 200)}`,
    });
    return { ok: true };
  },
});

/**
 * Clear a `partial-failure` block recorded by `runDailyRamp`.
 *
 * Naive clear is RISKY when the export already succeeded. Concrete failure
 * shape: `assignAndExportWave` stamped contacts with `waveLabel` AND created
 * the Resend segment, then `createProLaunchBroadcast` or `sendProLaunchBroadcast`
 * threw. A bare clear lets the next cron retry with the SAME `waveLabel` →
 * `assignAndExportWave` rejects because contacts are already stamped. The cron
 * then thrashes on the same partial-failure indefinitely.
 *
 * Use `recoverFromPartialFailure` (below) instead — it requires the operator
 * to declare what actually happened (manual send completed vs. discard-and-rotate)
 * so the next cron lands cleanly.
 *
 * Kept as a "soft clear" for failures that DON'T involve a successful export
 * (e.g. `assignAndExportWave` itself threw before any contact was stamped).
 * Operator investigates and confirms zero stamps via the audience tables before
 * calling this; mismatch is the operator's responsibility.
 */
export const clearPartialFailure = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[clearPartialFailure] no ramp configured");
    if (row.lastRunStatus !== "partial-failure") {
      return { ok: true, noop: true, currentStatus: row.lastRunStatus };
    }
    await ctx.db.patch(row._id, {
      lastRunStatus: `partial-failure-cleared: ${reason.slice(0, 200)}`,
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
    });
    return { ok: true };
  },
});

/**
 * Structured recovery for `lastRunStatus === "partial-failure"` that ALSO
 * occurred AFTER `assignAndExportWave` succeeded. Two recovery modes:
 *
 *   manual-finished:
 *     The operator manually completed the wave (e.g. `createProLaunchBroadcast`
 *     ran fine in the Resend dashboard, send was triggered there or via
 *     `npx convex run broadcast/sendBroadcast:sendProLaunchBroadcast`). Pass
 *     the resulting broadcastId/segmentId/sentAt/assigned. Tier advances as
 *     if the cron had succeeded; next kill-gate check uses the new
 *     `lastWaveBroadcastId`.
 *
 *   discard-and-rotate:
 *     The wave is written off (e.g. send is genuinely lost, can't or won't
 *     retry manually). Bumps `waveLabelOffset` by 1 so the next cron uses a
 *     FRESH `waveLabel` — the prior label's stamps remain in the audience
 *     table and exclude those contacts from future picks (lost to this
 *     campaign; operator can manually email them later if desired). Tier is
 *     NOT advanced (no successful send to record).
 *
 * Both modes clear the lease and the partial-failure status.
 */
export const recoverFromPartialFailure = internalMutation({
  args: {
    recovery: v.union(
      v.literal("manual-finished"),
      v.literal("discard-and-rotate"),
    ),
    reason: v.string(),
    // Required for recovery==='manual-finished' — fields that mirror the
    // arguments _recordWaveSent would have used. Validated below.
    broadcastId: v.optional(v.string()),
    segmentId: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    assigned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[recoverFromPartialFailure] no ramp configured");
    if (row.lastRunStatus !== "partial-failure") {
      return {
        ok: true as const,
        noop: true as const,
        currentStatus: row.lastRunStatus,
      };
    }

    if (args.recovery === "manual-finished") {
      if (
        !args.broadcastId ||
        !args.segmentId ||
        args.sentAt === undefined ||
        args.assigned === undefined
      ) {
        throw new Error(
          "[recoverFromPartialFailure:manual-finished] broadcastId, segmentId, sentAt, assigned are all required",
        );
      }
      const nextTier = row.currentTier + 1;
      if (nextTier >= row.rampCurve.length) {
        throw new Error(
          `[recoverFromPartialFailure:manual-finished] currentTier=${row.currentTier} would advance past rampCurve.length=${row.rampCurve.length}. Curve is complete; nothing to recover.`,
        );
      }
      const waveLabel = `${row.waveLabelPrefix}-${nextTier + row.waveLabelOffset}`;
      await ctx.db.patch(row._id, {
        currentTier: nextTier,
        lastWaveLabel: waveLabel,
        lastWaveBroadcastId: args.broadcastId,
        lastWaveSegmentId: args.segmentId,
        lastWaveAssigned: args.assigned,
        lastWaveSentAt: args.sentAt,
        lastRunStatus: `succeeded-via-manual-recovery: ${args.reason.slice(0, 200)}`,
        lastRunAt: Date.now(),
        lastRunError: undefined,
        pendingRunId: undefined,
        pendingRunStartedAt: undefined,
      });
      return {
        ok: true as const,
        recovery: "manual-finished" as const,
        advancedToTier: nextTier,
        waveLabel,
      };
    }

    // discard-and-rotate
    await ctx.db.patch(row._id, {
      waveLabelOffset: row.waveLabelOffset + 1,
      lastRunStatus: `partial-failure-discarded-rotated: ${args.reason.slice(0, 200)}`,
      lastRunAt: Date.now(),
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
    });
    return {
      ok: true as const,
      recovery: "discard-and-rotate" as const,
      newWaveLabelOffset: row.waveLabelOffset + 1,
      nextWaveLabel: `${row.waveLabelPrefix}-${row.currentTier + 1 + row.waveLabelOffset + 1}`,
    };
  },
});

export const abortRamp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await loadConfig(ctx);
    if (!row) return { ok: true, noop: true };
    await ctx.db.delete(row._id);
    return { ok: true };
  },
});

export const getRampStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await loadConfig(ctx);
    if (!row) return { configured: false as const };
    const nextTier = row.currentTier + 1;
    const nextWaveLabel =
      nextTier < row.rampCurve.length
        ? `${row.waveLabelPrefix}-${nextTier + row.waveLabelOffset}`
        : null;
    const nextWaveCount =
      nextTier < row.rampCurve.length ? row.rampCurve[nextTier] : null;
    return {
      configured: true as const,
      active: row.active,
      killGateTripped: row.killGateTripped,
      killGateReason: row.killGateReason,
      currentTier: row.currentTier,
      rampCurve: row.rampCurve,
      nextTier,
      nextWaveLabel,
      nextWaveCount,
      lastWaveLabel: row.lastWaveLabel,
      lastWaveBroadcastId: row.lastWaveBroadcastId,
      lastWaveSentAt: row.lastWaveSentAt,
      lastRunStatus: row.lastRunStatus,
      lastRunAt: row.lastRunAt,
      lastRunError: row.lastRunError,
      pendingRunId: row.pendingRunId,
      pendingRunStartedAt: row.pendingRunStartedAt,
      // Operator-facing flag: is the lease currently held + fresh?
      leaseHeld:
        row.pendingRunId !== undefined &&
        row.pendingRunStartedAt !== undefined &&
        Date.now() - row.pendingRunStartedAt < STALE_LEASE_MS,
    };
  },
});

/* ─────────────────────────── internal helpers ─────────────────────────── */

async function loadConfig(
  ctx: QueryCtx | MutationCtx,
): Promise<RampConfigRow | null> {
  return await ctx.db
    .query("broadcastRampConfig")
    .withIndex("by_key", (q) => q.eq("key", RAMP_KEY))
    .first();
}

/**
 * Atomically claim the lease before external side effects.
 *
 * Two concurrent cron runs (or a cron + a manually-triggered run, or a Convex
 * runtime retry firing the action again) would both read the same `currentTier`,
 * both proceed through `assignAndExportWave` + `createProLaunchBroadcast` +
 * `sendProLaunchBroadcast` (DUPLICATE EMAILS), and only collide at
 * `_recordWaveSent`. The tier check there is post-hoc; the emails have already
 * gone out. This claim is the pre-side-effect lock.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` for the runner
 * to log and exit cleanly without side effects.
 *
 * Idempotency / staleness: a lease older than `STALE_LEASE_MS` is treated as
 * abandoned (previous runner crashed) and overridable; a fresh lease blocks
 * further claims. The new lease records `pendingRunId` and
 * `pendingRunStartedAt` so the matching `_recordWaveSent` /
 * `_recordRunOutcome` calls can validate they hold the lease they think they do.
 */
export const _claimTierForRun = internalMutation({
  args: {
    runId: v.string(),
    expectedCurrentTier: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) {
      return { ok: false as const, reason: "no-config" as const };
    }
    if (row.currentTier !== args.expectedCurrentTier) {
      return {
        ok: false as const,
        reason: "tier-moved" as const,
        actualTier: row.currentTier,
      };
    }
    const now = Date.now();
    if (
      row.pendingRunId &&
      row.pendingRunStartedAt &&
      now - row.pendingRunStartedAt < STALE_LEASE_MS
    ) {
      return {
        ok: false as const,
        reason: "lease-held" as const,
        heldBy: row.pendingRunId,
        ageMs: now - row.pendingRunStartedAt,
      };
    }
    if (row.pendingRunId && row.pendingRunStartedAt) {
      console.warn(
        `[_claimTierForRun] overriding stale lease ${row.pendingRunId} ` +
          `(age ${Math.round((now - row.pendingRunStartedAt) / 1000)}s > ${STALE_LEASE_MS / 1000}s) ` +
          `— previous runner likely crashed mid-flight without releasing.`,
      );
    }
    await ctx.db.patch(row._id, {
      pendingRunId: args.runId,
      pendingRunStartedAt: now,
    });
    return { ok: true as const };
  },
});

/**
 * Internal mutation that the action calls to atomically advance the tier +
 * record a successful wave-send. Validates that the lease still belongs to
 * this runId — protects against the (extremely unlikely) case where the
 * lease was overridden as stale by another run while we were still working.
 */
export const _recordWaveSent = internalMutation({
  args: {
    runId: v.string(),
    expectedCurrentTier: v.number(),
    newTier: v.number(),
    waveLabel: v.string(),
    broadcastId: v.string(),
    segmentId: v.string(),
    assigned: v.number(),
    sentAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[_recordWaveSent] no ramp configured");
    if (row.currentTier !== args.expectedCurrentTier) {
      throw new Error(
        `[_recordWaveSent] tier moved underneath us: expected ${args.expectedCurrentTier}, found ${row.currentTier}. Refusing to overwrite.`,
      );
    }
    if (row.pendingRunId !== args.runId) {
      // The lease changed under us. Either:
      //   (a) our lease was overridden as stale by another run while we were
      //       still in flight, OR
      //   (b) the lease was cleared by an operator action (recoverFromPartialFailure).
      // Either way, we must NOT advance the tier — another run may be in flight
      // and would conflict, or the operator has taken control. Fall through to
      // an error so Convex auto-Sentry captures and ops can investigate.
      throw new Error(
        `[_recordWaveSent] lease lost: expected runId=${args.runId}, found ${row.pendingRunId ?? "<cleared>"}. Refusing to advance tier — investigate what cleared the lease.`,
      );
    }
    await ctx.db.patch(row._id, {
      currentTier: args.newTier,
      lastWaveLabel: args.waveLabel,
      lastWaveBroadcastId: args.broadcastId,
      lastWaveSegmentId: args.segmentId,
      lastWaveAssigned: args.assigned,
      lastWaveSentAt: args.sentAt,
      lastRunStatus: "succeeded",
      lastRunAt: Date.now(),
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
    });
    return { ok: true };
  },
});

/**
 * Mutation that records a non-success outcome of a cron run without advancing
 * the tier. Used for kill-gate trips, drained pool, partial failures, and
 * "wait for prior wave to settle" deferrals.
 *
 * Always clears the lease (if held by this runId). The lease must not outlive
 * the run, otherwise the next cron run sees `lease-held` and skips, and
 * eventually expires via STALE_LEASE_MS — bigger lockout window than necessary.
 */
export const _recordRunOutcome = internalMutation({
  args: {
    runId: v.optional(v.string()), // optional for backwards-compat with pre-claim deferrals
    status: v.string(),
    error: v.optional(v.string()),
    killGate: v.optional(v.boolean()),
    killGateReason: v.optional(v.string()),
    deactivate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) return;
    const patch: Record<string, unknown> = {
      lastRunStatus: args.status,
      lastRunAt: Date.now(),
      lastRunError: args.error,
    };
    if (args.killGate) {
      patch.killGateTripped = true;
      patch.killGateReason = args.killGateReason;
    }
    if (args.deactivate) {
      patch.active = false;
    }
    // Clear the lease if it's ours. Avoids stomping a lease that some other
    // run claimed after we lost ours (e.g. our lease was overridden as stale).
    if (args.runId && row.pendingRunId === args.runId) {
      patch.pendingRunId = undefined;
      patch.pendingRunStartedAt = undefined;
    }
    await ctx.db.patch(row._id, patch);
  },
});

/* ─────────────────────────── the cron entry point ─────────────────────────── */

/**
 * Cron handler. Idempotent on no-op paths: if the config is missing,
 * inactive, or kill-gated, the action exits without side effects.
 *
 * Recovery path on partial failure (e.g., assignAndExportWave throws
 * mid-flight): `_recordRunOutcome("partial-failure", ...)` records the
 * state so the operator can investigate. The next cron run will see
 * `lastRunStatus === "partial-failure"` and refuse to advance until
 * cleared via `clearKillGate` or manual config patch.
 */
export const runDailyRamp = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: string; detail?: string }> => {
    const row: RampConfigRow | null = await ctx.runQuery(
      internal.broadcast.rampRunner._loadConfigForRunner,
      {},
    );
    if (!row) {
      console.log("[runDailyRamp] no ramp configured — skip");
      return { status: "no-config" };
    }
    if (!row.active) {
      console.log("[runDailyRamp] ramp inactive — skip");
      return { status: "inactive" };
    }
    if (row.killGateTripped) {
      console.log(
        `[runDailyRamp] kill-gate tripped (${row.killGateReason ?? "<no reason>"}) — skip`,
      );
      return { status: "kill-gate-tripped" };
    }
    if (row.lastRunStatus === "partial-failure") {
      console.log(
        "[runDailyRamp] last run was a partial failure — skip until operator clears.",
      );
      return { status: "blocked-on-partial-failure" };
    }

    // ──── Step 1: kill-gate check on the prior wave (if any) ────
    if (row.lastWaveBroadcastId) {
      // Settle window — bounces and complaints take a few hours to
      // accumulate via the Resend webhook. Skip for this tick.
      const hoursSince =
        (Date.now() - (row.lastWaveSentAt ?? 0)) / (1000 * 60 * 60);
      if (hoursSince < MIN_HOURS_BETWEEN_WAVES) {
        console.log(
          `[runDailyRamp] only ${hoursSince.toFixed(1)}h since last wave (need ${MIN_HOURS_BETWEEN_WAVES}h) — skip`,
        );
        await ctx.runMutation(
          internal.broadcast.rampRunner._recordRunOutcome,
          { status: "awaiting-prior-stats" },
        );
        return { status: "awaiting-prior-stats" };
      }

      const stats: {
        counts: Record<string, number>;
        bounceRate: number | null;
        complaintRate: number | null;
      } = await ctx.runAction(
        internal.broadcast.metrics.getBroadcastStats,
        { broadcastId: row.lastWaveBroadcastId },
      );
      const delivered = stats.counts["email.delivered"] ?? 0;

      if (delivered < MIN_DELIVERED_FOR_KILLGATE) {
        console.log(
          `[runDailyRamp] prior wave only ${delivered} delivered (need ${MIN_DELIVERED_FOR_KILLGATE}) — skip`,
        );
        await ctx.runMutation(
          internal.broadcast.rampRunner._recordRunOutcome,
          { status: "awaiting-prior-stats" },
        );
        return { status: "awaiting-prior-stats" };
      }

      if (
        stats.bounceRate !== null &&
        stats.bounceRate > row.bounceKillThreshold
      ) {
        const reason = `bounce rate ${(stats.bounceRate * 100).toFixed(2)}% > threshold ${(row.bounceKillThreshold * 100).toFixed(2)}% on ${row.lastWaveLabel}`;
        console.error(`[runDailyRamp] KILL-GATE TRIPPED: ${reason}`);
        await ctx.runMutation(
          internal.broadcast.rampRunner._recordRunOutcome,
          {
            status: "kill-gate-tripped",
            killGate: true,
            killGateReason: reason,
            deactivate: true,
          },
        );
        return { status: "kill-gate-tripped", detail: reason };
      }
      if (
        stats.complaintRate !== null &&
        stats.complaintRate > row.complaintKillThreshold
      ) {
        const reason = `complaint rate ${(stats.complaintRate * 100).toFixed(3)}% > threshold ${(row.complaintKillThreshold * 100).toFixed(3)}% on ${row.lastWaveLabel}`;
        console.error(`[runDailyRamp] KILL-GATE TRIPPED: ${reason}`);
        await ctx.runMutation(
          internal.broadcast.rampRunner._recordRunOutcome,
          {
            status: "kill-gate-tripped",
            killGate: true,
            killGateReason: reason,
            deactivate: true,
          },
        );
        return { status: "kill-gate-tripped", detail: reason };
      }
    }

    // ──── Step 2: figure out which tier to send next ────
    const nextTier = row.currentTier + 1;
    if (nextTier >= row.rampCurve.length) {
      console.log("[runDailyRamp] ramp curve complete — deactivating");
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        { status: "ramp-complete", deactivate: true },
      );
      return { status: "ramp-complete" };
    }
    // Bounds-checked above; explicit guard quiets noUncheckedIndexedAccess
    // and protects against a future code change that breaks the
    // bounds check above without realising this index is now unsafe.
    const count = row.rampCurve[nextTier];
    if (count === undefined) {
      throw new Error(
        `[runDailyRamp] rampCurve[${nextTier}] is undefined despite bounds check — config corruption?`,
      );
    }
    const waveLabel = `${row.waveLabelPrefix}-${nextTier + row.waveLabelOffset}`;

    // ──── Step 3a: ATOMICALLY CLAIM THE LEASE before any external side effect ────
    // Two concurrent runs (cron + manual trigger, Convex retry, misconfigured
    // schedule) both pass kill-gate / tier-bounds checks above before anything
    // mutates state. Without this claim, both would proceed through
    // assignAndExportWave + createProLaunchBroadcast + sendProLaunchBroadcast,
    // duplicate-emailing every recipient, and only collide at _recordWaveSent.
    // Claim the lease BEFORE any external side effect so the loser exits clean.
    const runId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const claim: { ok: boolean; reason?: string; actualTier?: number; heldBy?: string; ageMs?: number } =
      await ctx.runMutation(internal.broadcast.rampRunner._claimTierForRun, {
        runId,
        expectedCurrentTier: row.currentTier,
      });
    if (!claim.ok) {
      console.log(
        `[runDailyRamp] claim rejected (${claim.reason}${
          claim.heldBy ? `, heldBy=${claim.heldBy}, ageMs=${claim.ageMs}` : ""
        }${claim.actualTier !== undefined ? `, actualTier=${claim.actualTier}` : ""}) — skip`,
      );
      // Don't record an outcome here — the other holder will record theirs;
      // recording ours would stomp their lease/status. Just exit.
      return { status: `claim-rejected-${claim.reason}` };
    }

    // ──── Step 3b: pick + stamp + create segment + push ────
    let exportResult: WaveExportStats;
    try {
      exportResult = await ctx.runAction(
        internal.broadcast.audienceWaveExport.assignAndExportWave,
        { waveLabel, count },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        { runId, status: "partial-failure", error: msg },
      );
      throw err; // bubble so Convex auto-Sentry captures
    }

    // Treat any non-zero export failure counter as a partial-failure
    // and refuse to send. Without this, a wave that requested 500 and
    // got 250 push failures + 250 successes would still proceed to
    // create + send the broadcast — the cron would record the wave as
    // a clean tier advance even though half the audience was dropped
    // and `stampFailed > 0` would silently leak duplicate-email risk
    // into the next pick (pushed but unstamped → re-eligible).
    // Operator clears via the same `lastRunStatus === partial-failure`
    // gate that handles other partial-failure paths.
    if (exportResult.failed > 0 || exportResult.stampFailed > 0) {
      const reason = `assignAndExportWave partial: failed=${exportResult.failed}, stampFailed=${exportResult.stampFailed} (segment=${exportResult.segmentId}, assigned=${exportResult.assigned}, requested=${count}, waveLabel=${waveLabel}). Investigate Resend logs + Convex stamp errors before resuming; stampFailed contacts are in the segment but unstamped (duplicate-email risk).`;
      console.error(`[runDailyRamp] ${reason}`);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        { runId, status: "partial-failure", error: reason },
      );
      return { status: "partial-failure", detail: reason };
    }

    if (
      exportResult.underfilled &&
      exportResult.assigned < count * UNDERFILL_RATIO
    ) {
      const reason = `pool drained — requested ${count}, got ${exportResult.assigned}`;
      console.log(`[runDailyRamp] ${reason} — deactivating`);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        { runId, status: "pool-drained", deactivate: true, error: reason },
      );
      return { status: "pool-drained", detail: reason };
    }

    // ──── Step 4: create + send the broadcast ────
    let broadcastId: string;
    try {
      const created: { broadcastId: string } = await ctx.runAction(
        internal.broadcast.sendBroadcast.createProLaunchBroadcast,
        { segmentId: exportResult.segmentId, nameSuffix: waveLabel },
      );
      broadcastId = created.broadcastId;
    } catch (err) {
      // sentry-coverage-ok: status recorded into config; Convex
      // auto-Sentry catches the throw via the re-raise below.
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        {
          runId,
          status: "partial-failure",
          error: `createProLaunchBroadcast: ${msg} (waveLabel=${waveLabel}, segmentId=${exportResult.segmentId}, ${exportResult.assigned} contacts stamped + in segment). Recovery: see recoverFromPartialFailure(${JSON.stringify({ recovery: "manual-finished" })}) or recoverFromPartialFailure(${JSON.stringify({ recovery: "discard-and-rotate" })}).`,
        },
      );
      throw err;
    }

    try {
      await ctx.runAction(
        internal.broadcast.sendBroadcast.sendProLaunchBroadcast,
        { broadcastId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        {
          runId,
          status: "partial-failure",
          error: `sendProLaunchBroadcast: ${msg} (waveLabel=${waveLabel}, segmentId=${exportResult.segmentId}, broadcastId=${broadcastId}, assigned=${exportResult.assigned}). Recovery: preview in Resend dashboard; if it sent fine, recoverFromPartialFailure({recovery:'manual-finished', broadcastId, ...}). If it didn't, send manually then call manual-finished, OR call recoverFromPartialFailure({recovery:'discard-and-rotate'}) to bump waveLabelOffset and let next cron retry with a fresh label.`,
        },
      );
      throw err;
    }

    // ──── Step 5: record success ────
    await ctx.runMutation(internal.broadcast.rampRunner._recordWaveSent, {
      runId,
      expectedCurrentTier: row.currentTier,
      newTier: nextTier,
      waveLabel,
      broadcastId,
      segmentId: exportResult.segmentId,
      assigned: exportResult.assigned,
      sentAt: Date.now(),
    });

    console.log(
      `[runDailyRamp] sent ${waveLabel} (tier ${nextTier}, count ${exportResult.assigned}, broadcast ${broadcastId})`,
    );
    return {
      status: "sent",
      detail: `${waveLabel} → ${exportResult.assigned} contacts`,
    };
  },
});

/**
 * Internal helper for `runDailyRamp` to read the config inside a query
 * context (the runner action can't read the DB directly).
 */
export const _loadConfigForRunner = internalQuery({
  args: {},
  handler: async (ctx) => {
    return (await loadConfig(ctx)) as RampConfigRow | null;
  },
});
