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
 *
 *   # Recovery for `lastRunStatus === "partial-failure"`. PREFER THIS over
 *   # clearPartialFailure when ANY external step ran. Reads persisted pending*
 *   # fields when operator omits broadcastId/segmentId/assigned/waveLabel.
 *   npx convex run broadcast/rampRunner:recoverFromPartialFailure '{
 *     "recovery":"manual-finished",
 *     "reason":"sent wave-N manually after createProLaunchBroadcast threw",
 *     "sentAt": 1700000000000
 *     // broadcastId/segmentId/assigned/waveLabel auto-fill from pending* if absent
 *   }'
 *   # OR for unrecoverable waves (audience stamped but send is genuinely lost):
 *   npx convex run broadcast/rampRunner:recoverFromPartialFailure '{
 *     "recovery":"discard-and-rotate",
 *     "reason":"unrecoverable; rotating waveLabelOffset"
 *   }'
 *
 *   # Last-resort soft-clear (NO export happened — assignAndExportWave threw
 *   # before any contact stamping). Refuses without confirmNoExport=true.
 *   npx convex run broadcast/rampRunner:clearPartialFailure '{"reason":"export threw before any stamping","confirmNoExport":true}'
 *
 *   # Last-resort lease release for a stuck cron run (action wedged for hours
 *   # with no partial-failure recorded — process likely died silently). Sets
 *   # lastRunStatus=partial-failure so the operator can then call
 *   # recoverFromPartialFailure to either advance or rotate.
 *   npx convex run broadcast/rampRunner:forceReleaseLease '{"reason":"cron action wedged 6h, no partial-failure recorded"}'
 *
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

// Lease "age warning" cutoff used only for telemetry on getRampStatus.
// There is NO automatic override — a held lease blocks all further claims
// until it is cleared by the owning runId (terminal outcome path) or by
// the operator calling `forceReleaseLease`. Reasoning: side effects can
// legitimately exceed any wall-clock cutoff (large rampCurve count,
// upstream Resend slowness), and an automatic override has the same
// failure mode the lease exists to prevent — duplicate sends. The
// operator-only release path forces a human decision before unblocking.
const LEASE_AGE_WARN_MS = 30 * 60 * 1000;

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
 * Last-resort soft-clear of a `partial-failure` status. STRONGLY DISPREFERRED;
 * use `recoverFromPartialFailure` instead in nearly every case.
 *
 * Naive clear is RISKY when the export already succeeded. Concrete failure
 * shape: `assignAndExportWave` stamped contacts with `waveLabel` AND created
 * the Resend segment, then `createProLaunchBroadcast` or `sendProLaunchBroadcast`
 * threw. A bare clear lets the next cron retry with the SAME `waveLabel` →
 * `assignAndExportWave` rejects because contacts are already stamped. The cron
 * then thrashes on the same partial-failure indefinitely. Worse: if the
 * broadcast was actually sent (just our recording failed), a clear-then-retry
 * silently double-sends.
 *
 * This mutation now REQUIRES `confirmNoExport: true` AND refuses to run if any
 * `pending*` progress markers are set (which the runner persists as soon as
 * any external step succeeds). Use this ONLY when `assignAndExportWave` itself
 * threw BEFORE stamping any contact, e.g. an upstream Resend timeout that
 * prevented segment creation. The operator MUST verify zero stamps via the
 * audience tables AND verify no broadcast in the Resend dashboard before
 * calling.
 *
 * For ANY case where the export ran (segment created, contacts stamped,
 * broadcast created, or send fired), use `recoverFromPartialFailure` —
 * `manual-finished` if the wave actually went out, `discard-and-rotate` if
 * not.
 */
export const clearPartialFailure = internalMutation({
  args: {
    reason: v.string(),
    // Literal-true forces the operator to actively assert "I have verified no
    // export happened." A future caller can't accidentally pass `false` to
    // bypass this.
    confirmNoExport: v.literal(true),
  },
  handler: async (ctx, { reason }) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[clearPartialFailure] no ramp configured");
    if (row.lastRunStatus !== "partial-failure") {
      return {
        ok: true as const,
        noop: true as const,
        currentStatus: row.lastRunStatus,
      };
    }
    // Fail-closed: if any pending-progress marker exists, the export DID make
    // progress past `assignAndExportWave` — clearing here would mask a stamped
    // / sent wave. Force the operator to use recoverFromPartialFailure.
    if (
      row.pendingWaveLabel ||
      row.pendingSegmentId ||
      row.pendingBroadcastId
    ) {
      throw new Error(
        `[clearPartialFailure] refused: pending progress markers present (waveLabel=${row.pendingWaveLabel ?? "-"}, segmentId=${row.pendingSegmentId ?? "-"}, broadcastId=${row.pendingBroadcastId ?? "-"}). The export DID run; clearing here would mask stamped contacts. Use recoverFromPartialFailure instead.`,
      );
    }
    await ctx.db.patch(row._id, {
      lastRunStatus: `partial-failure-cleared: ${reason.slice(0, 200)}`,
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
    });
    return { ok: true as const };
  },
});

/**
 * Structured recovery for `lastRunStatus === "partial-failure"` that ALSO
 * occurred AFTER `assignAndExportWave` succeeded (or after a forced lease
 * release on a wedged run). Two recovery modes:
 *
 *   manual-finished:
 *     The operator manually completed the wave (e.g. `createProLaunchBroadcast`
 *     ran fine in the Resend dashboard, send was triggered there or via
 *     `npx convex run broadcast/sendBroadcast:sendProLaunchBroadcast`).
 *     `broadcastId` / `segmentId` / `assigned` / `waveLabel` auto-fill from
 *     the persisted `pending*` markers when the operator omits them; pass
 *     them explicitly only when overriding (e.g. broadcast ID changed during
 *     manual completion). `sentAt` is always required from the operator —
 *     when the manual send finished is information no in-flight progress
 *     marker captures.
 *
 *   discard-and-rotate:
 *     The wave is written off. Bumps `waveLabelOffset` by 1 so the next cron
 *     uses a FRESH `waveLabel` — the prior label's stamps remain in the
 *     audience table and exclude those contacts from future picks (lost to
 *     this campaign; operator can manually email them later if desired).
 *     Tier is NOT advanced (no successful send to record).
 *
 * Both modes clear the lease, the partial-failure status, AND all pending*
 * progress markers.
 */
export const recoverFromPartialFailure = internalMutation({
  args: {
    recovery: v.union(
      v.literal("manual-finished"),
      v.literal("discard-and-rotate"),
    ),
    reason: v.string(),
    // For recovery==='manual-finished'. Fall back to persisted pending*
    // markers when omitted; sentAt is ALWAYS operator-supplied (no progress
    // marker captures send-completion time).
    broadcastId: v.optional(v.string()),
    segmentId: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    assigned: v.optional(v.number()),
    waveLabel: v.optional(v.string()),
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

    const clearPending = {
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
      pendingWaveLabel: undefined,
      pendingSegmentId: undefined,
      pendingAssigned: undefined,
      pendingExportAt: undefined,
      pendingBroadcastId: undefined,
      pendingBroadcastAt: undefined,
    } as const;

    if (args.recovery === "manual-finished") {
      // Resolve each field: operator-supplied wins, persisted pending* is the
      // fallback. sentAt is operator-only (no fallback).
      const broadcastId = args.broadcastId ?? row.pendingBroadcastId;
      const segmentId = args.segmentId ?? row.pendingSegmentId;
      const assigned = args.assigned ?? row.pendingAssigned;
      const nextTier = row.currentTier + 1;
      if (nextTier >= row.rampCurve.length) {
        throw new Error(
          `[recoverFromPartialFailure:manual-finished] currentTier=${row.currentTier} would advance past rampCurve.length=${row.rampCurve.length}. Curve is complete; nothing to recover.`,
        );
      }
      const waveLabel =
        args.waveLabel ??
        row.pendingWaveLabel ??
        `${row.waveLabelPrefix}-${nextTier + row.waveLabelOffset}`;

      const missing: string[] = [];
      if (!broadcastId) missing.push("broadcastId");
      if (!segmentId) missing.push("segmentId");
      if (assigned === undefined) missing.push("assigned");
      if (args.sentAt === undefined) missing.push("sentAt");
      if (missing.length > 0) {
        throw new Error(
          `[recoverFromPartialFailure:manual-finished] missing required field(s): ${missing.join(", ")}. ` +
            `Operator must supply (or rely on persisted pending* state from a prior runner). Persisted state: ` +
            `pendingBroadcastId=${row.pendingBroadcastId ?? "-"}, pendingSegmentId=${row.pendingSegmentId ?? "-"}, ` +
            `pendingAssigned=${row.pendingAssigned ?? "-"}, pendingWaveLabel=${row.pendingWaveLabel ?? "-"}.`,
        );
      }

      await ctx.db.patch(row._id, {
        currentTier: nextTier,
        lastWaveLabel: waveLabel,
        lastWaveBroadcastId: broadcastId,
        lastWaveSegmentId: segmentId,
        lastWaveAssigned: assigned,
        lastWaveSentAt: args.sentAt,
        lastRunStatus: `succeeded-via-manual-recovery: ${args.reason.slice(0, 200)}`,
        lastRunAt: Date.now(),
        lastRunError: undefined,
        ...clearPending,
      });
      return {
        ok: true as const,
        recovery: "manual-finished" as const,
        advancedToTier: nextTier,
        waveLabel,
        broadcastId,
        segmentId,
        assigned,
        usedPersistedFallback: {
          broadcastId: !args.broadcastId && !!row.pendingBroadcastId,
          segmentId: !args.segmentId && !!row.pendingSegmentId,
          assigned:
            args.assigned === undefined && row.pendingAssigned !== undefined,
          waveLabel: !args.waveLabel && !!row.pendingWaveLabel,
        },
      };
    }

    // discard-and-rotate
    await ctx.db.patch(row._id, {
      waveLabelOffset: row.waveLabelOffset + 1,
      lastRunStatus: `partial-failure-discarded-rotated: ${args.reason.slice(0, 200)}`,
      lastRunAt: Date.now(),
      lastRunError: undefined,
      ...clearPending,
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
      // Operator-facing flag: is the lease currently held?
      // (No automatic staleness override — held = held until cleared.)
      leaseHeld: row.pendingRunId !== undefined,
      // Telemetry-only: lets ops see at-a-glance whether a held lease is
      // older than the warn cutoff (potential candidate for forceReleaseLease
      // after a manual investigation). It does NOT affect any code path.
      leaseAgeWarn:
        row.pendingRunId !== undefined &&
        row.pendingRunStartedAt !== undefined &&
        Date.now() - row.pendingRunStartedAt > LEASE_AGE_WARN_MS,
      // Persisted per-step progress so operators can decide between
      // recoverFromPartialFailure(manual-finished) vs (discard-and-rotate).
      pendingWaveLabel: row.pendingWaveLabel,
      pendingSegmentId: row.pendingSegmentId,
      pendingAssigned: row.pendingAssigned,
      pendingExportAt: row.pendingExportAt,
      pendingBroadcastId: row.pendingBroadcastId,
      pendingBroadcastAt: row.pendingBroadcastAt,
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
 * NO automatic staleness override. A held lease blocks until the owning runId
 * clears it (terminal outcome path) or an operator clears it via
 * `forceReleaseLease`. Reasoning: a wall-clock-based override has the same
 * failure mode the lease exists to prevent — the original runner can still be
 * alive (long-running `assignAndExportWave` over a large segment, slow
 * Resend), and overriding while it's mid-flight lets a second run race and
 * duplicate-send. The operator-only release path forces a human decision.
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
    if (row.pendingRunId) {
      return {
        ok: false as const,
        reason: "lease-held" as const,
        heldBy: row.pendingRunId,
        ageMs:
          row.pendingRunStartedAt !== undefined
            ? now - row.pendingRunStartedAt
            : undefined,
      };
    }
    await ctx.db.patch(row._id, {
      pendingRunId: args.runId,
      pendingRunStartedAt: now,
    });
    return { ok: true as const };
  },
});

/**
 * Operator-only last-resort lease release.
 *
 * Use ONLY when a cron action is genuinely wedged (process died silently
 * between claim and any catch block, leaving a held lease with no
 * partial-failure status). Investigate Convex action logs + Resend dashboard
 * BEFORE calling this — the side effects might have actually completed
 * (segment created, broadcast sent) and the right recovery is then
 * `recoverFromPartialFailure({recovery:"manual-finished"})`, not a fresh send.
 *
 * Sets `lastRunStatus = "partial-failure"` so `recoverFromPartialFailure`
 * picks up; preserves any `pending*` progress markers so the operator can
 * decide between manual-finished and discard-and-rotate from persisted state.
 */
export const forceReleaseLease = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[forceReleaseLease] no ramp configured");
    if (!row.pendingRunId) {
      return {
        ok: true as const,
        noop: true as const,
        currentStatus: row.lastRunStatus,
      };
    }
    const releasedRunId = row.pendingRunId;
    const heldForMs =
      row.pendingRunStartedAt !== undefined
        ? Date.now() - row.pendingRunStartedAt
        : undefined;
    await ctx.db.patch(row._id, {
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
      lastRunStatus: "partial-failure",
      lastRunAt: Date.now(),
      lastRunError: `forced-release: ${reason.slice(0, 200)} (was held by ${releasedRunId}${heldForMs !== undefined ? `, age ${Math.round(heldForMs / 1000)}s` : ""})`,
    });
    return {
      ok: true as const,
      releasedRunId,
      heldForMs,
    };
  },
});

/**
 * Persist post-`assignAndExportWave` progress. Called by the runner AFTER
 * `assignAndExportWave` returns successfully. Lets `recoverFromPartialFailure`
 * recover the (segmentId, assigned, waveLabel) without operator-supplied
 * metadata if the action dies between this point and a successful
 * `_recordWaveSent`.
 *
 * Lease-validating: throws if the lease has changed (operator
 * `forceReleaseLease` mid-flight, or a different run claimed). The throw
 * bubbles to Convex auto-Sentry; the runner stops without advancing.
 */
export const _recordPendingExport = internalMutation({
  args: {
    runId: v.string(),
    waveLabel: v.string(),
    segmentId: v.string(),
    assigned: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[_recordPendingExport] no ramp configured");
    if (row.pendingRunId !== args.runId) {
      throw new Error(
        `[_recordPendingExport] lease lost: expected runId=${args.runId}, found ${row.pendingRunId ?? "<cleared>"}. Refusing to persist export progress — operator/another run owns the state.`,
      );
    }
    await ctx.db.patch(row._id, {
      pendingWaveLabel: args.waveLabel,
      pendingSegmentId: args.segmentId,
      pendingAssigned: args.assigned,
      pendingExportAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Persist post-`createProLaunchBroadcast` progress. Called by the runner
 * AFTER `createProLaunchBroadcast` returns successfully. Lets
 * `recoverFromPartialFailure` recover the broadcastId without
 * operator-supplied metadata if the action dies between this point and a
 * successful `_recordWaveSent`.
 *
 * Lease-validating: same semantics as `_recordPendingExport`.
 */
export const _recordPendingBroadcast = internalMutation({
  args: {
    runId: v.string(),
    broadcastId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) throw new Error("[_recordPendingBroadcast] no ramp configured");
    if (row.pendingRunId !== args.runId) {
      throw new Error(
        `[_recordPendingBroadcast] lease lost: expected runId=${args.runId}, found ${row.pendingRunId ?? "<cleared>"}. Refusing to persist broadcast progress — operator/another run owns the state.`,
      );
    }
    await ctx.db.patch(row._id, {
      pendingBroadcastId: args.broadcastId,
      pendingBroadcastAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Internal mutation that the action calls to atomically advance the tier +
 * record a successful wave-send. Validates that the lease still belongs to
 * this runId AND clears all pending-progress markers.
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
      // The lease changed under us — operator force-released it, or
      // recoverFromPartialFailure cleared it. We must NOT advance the tier;
      // bubble to Convex auto-Sentry so ops can investigate.
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
      // Clear all per-step progress markers — this run's state is now in
      // the lastWave* fields and the markers would otherwise leak into the
      // next run's recovery surface.
      pendingWaveLabel: undefined,
      pendingSegmentId: undefined,
      pendingAssigned: undefined,
      pendingExportAt: undefined,
      pendingBroadcastId: undefined,
      pendingBroadcastAt: undefined,
    });
    return { ok: true };
  },
});

/**
 * Mutation that records a non-success outcome of a cron run without advancing
 * the tier. Used for kill-gate trips, drained pool, partial failures, and
 * "wait for prior wave to settle" deferrals.
 *
 * Lease-mismatch policy: when `runId` is provided AND it does not match the
 * currently-held lease (`row.pendingRunId`), this mutation is a HARD NO-OP —
 * no fields are written. This protects the winning run's authoritative
 * outcome from being stomped by a stale or operator-displaced run that lost
 * its lease but still tried to record an outcome (e.g. operator called
 * `forceReleaseLease` mid-flight, then the displaced run's
 * createProLaunchBroadcast catch block ran and tried to write
 * "partial-failure"). Without this guard, the displaced run would overwrite
 * the kill-gate / status / error / active flags that the operator's recovery
 * path just set.
 *
 * Pre-claim deferrals (kill-gate trips before claim, ramp-complete) pass no
 * `runId` — those bypass the ownership check by design.
 */
export const _recordRunOutcome = internalMutation({
  args: {
    runId: v.optional(v.string()), // optional for pre-claim deferrals (kill-gate, ramp-complete)
    status: v.string(),
    error: v.optional(v.string()),
    killGate: v.optional(v.boolean()),
    killGateReason: v.optional(v.string()),
    deactivate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await loadConfig(ctx);
    if (!row) return { ok: false as const, reason: "no-config" as const };

    // P1#2 fix: lease-lost is a hard no-op. Both cases below count as lost:
    //   - row.pendingRunId is some OTHER runId (a new run claimed after our
    //     lease was force-released)
    //   - row.pendingRunId is undefined (operator cleared it via
    //     forceReleaseLease / recoverFromPartialFailure / clearPartialFailure)
    // Either way, the operator/winner owns the outcome state now; writing
    // anything would clobber their decision.
    if (args.runId && row.pendingRunId !== args.runId) {
      console.warn(
        `[_recordRunOutcome] lease lost (expected ${args.runId}, found ${row.pendingRunId ?? "<cleared>"}); refusing to write outcome status=${args.status}.`,
      );
      return {
        ok: false as const,
        reason: "lease-lost" as const,
        expectedRunId: args.runId,
        actualRunId: row.pendingRunId ?? null,
      };
    }

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
    // Clear the lease if it's ours. We only get here when ownership is
    // verified (or no runId was provided — pre-claim deferral path).
    if (args.runId && row.pendingRunId === args.runId) {
      patch.pendingRunId = undefined;
      patch.pendingRunStartedAt = undefined;
    }
    await ctx.db.patch(row._id, patch);
    return { ok: true as const };
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

    // P1#4 (round 2): persist post-export progress IMMEDIATELY after
    // assignAndExportWave returns, BEFORE inspecting failure counters /
    // underfill. The export ran — there's a real `segmentId`, contacts may
    // be stamped, contacts may be in the Resend segment — independent of
    // whether `failed > 0`, `stampFailed > 0`, or `assigned < threshold`.
    // If we deferred persistence past those branches, an operator running
    // `clearPartialFailure({confirmNoExport: true})` would see no
    // `pendingWaveLabel/SegmentId/BroadcastId` and the fail-closed guard
    // would let the clear through — masking stamped contacts and the
    // segment that's already in Resend. Persisting first means every
    // partial-failure path post-export carries the markers, and
    // clearPartialFailure refuses loudly. Lease-validating: throws if the
    // lease was force-released mid-flight, bubbling to Convex auto-Sentry.
    await ctx.runMutation(
      internal.broadcast.rampRunner._recordPendingExport,
      {
        runId,
        waveLabel,
        segmentId: exportResult.segmentId,
        assigned: exportResult.assigned,
      },
    );

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
      // P1 round 4: contacts ARE stamped (excluded from future picks) AND in
      // the Resend segment, but no broadcast was created/sent. Routing
      // through "pool-drained" + deactivate-and-clear-lease would strand
      // them — they'd never receive the email AND `recoverFromPartialFailure`
      // couldn't run because status would be "pool-drained" instead of
      // "partial-failure". Route through the recoverable partial-failure
      // path: persisted pending* markers + lastRunStatus="partial-failure"
      // make recoverFromPartialFailure({recovery:"manual-finished"}) able to
      // pick up exactly where the runner stopped, OR
      // recoverFromPartialFailure({recovery:"discard-and-rotate"}) to
      // explicitly abandon (operator's call, not the runner's). Ramp is
      // still deactivated — pool drained means the curve is done.
      const reason = `pool drained — requested ${count}, got ${exportResult.assigned} stamped + in segment ${exportResult.segmentId} (waveLabel=${waveLabel}). Contacts ARE stamped and excluded from future picks; they will be lost unless this wave is sent. Recovery: pending* state persisted; recoverFromPartialFailure({recovery:"manual-finished", sentAt:<epoch>}) after manually completing the broadcast in Resend, OR recoverFromPartialFailure({recovery:"discard-and-rotate"}) to abandon. Ramp deactivated; resumeRamp if appropriate after recovery.`;
      console.log(`[runDailyRamp] ${reason}`);
      await ctx.runMutation(
        internal.broadcast.rampRunner._recordRunOutcome,
        {
          runId,
          status: "partial-failure",
          deactivate: true,
          error: reason,
        },
      );
      return { status: "pool-drained-partial-failure", detail: reason };
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
          error: `createProLaunchBroadcast: ${msg} (waveLabel=${waveLabel}, segmentId=${exportResult.segmentId}, ${exportResult.assigned} contacts stamped + in segment). Recovery: pending* state persisted; call recoverFromPartialFailure({recovery:"manual-finished", sentAt:<epoch>}) after manually completing send, or recoverFromPartialFailure({recovery:"discard-and-rotate"}) to bump waveLabelOffset.`,
        },
      );
      throw err;
    }

    // P1#4: persist post-broadcast-create progress before the send. Lease-
    // validating: throws if the lease was force-released mid-flight.
    await ctx.runMutation(
      internal.broadcast.rampRunner._recordPendingBroadcast,
      { runId, broadcastId },
    );

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
          error: `sendProLaunchBroadcast: ${msg} (waveLabel=${waveLabel}, segmentId=${exportResult.segmentId}, broadcastId=${broadcastId}, assigned=${exportResult.assigned}). Recovery: pending* state persisted; preview in Resend dashboard, then recoverFromPartialFailure({recovery:"manual-finished", sentAt:<epoch>}) (broadcastId/segmentId/assigned/waveLabel auto-fill from persisted state). If unrecoverable, recoverFromPartialFailure({recovery:"discard-and-rotate"}) bumps waveLabelOffset.`,
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
