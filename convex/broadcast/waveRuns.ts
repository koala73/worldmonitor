/**
 * Wave-loading state machine — replaces the monolithic `assignAndExportWave`
 * action (which hits the Convex 10-min runtime budget at ~1500 contacts) with
 * a multi-step pipeline that fits within budget at any wave size.
 *
 * Pipeline:
 *   pickWaveAction → _claimWaveRunLease → reservoir-sample → createSegment
 *                  → _persistPickedBatch (×N, 500 rows each)
 *                  → _markPickComplete → schedule pushBatchAction
 *
 *   pushBatchAction → _resumeBatchInfo (lease guard) → _getPendingBatch
 *                   → upsertContactToSegment (Resend, with 429/5xx backoff)
 *                   → _markContactPushed | _markContactFailed (per-row CAS)
 *                   → schedule next pushBatchAction OR finalizeWaveAction
 *
 *   finalizeWaveAction → createProLaunchBroadcast → _markBroadcastCreated
 *                      → sendProLaunchBroadcast → _finalizeWaveRun
 *                      (atomically advances broadcastRampConfig.lastWave*,
 *                       clears lease, marks waveRuns.status='sent')
 *
 * Function-shape rules (Convex-correct, enforced by review):
 *   - internalAction = external I/O (Resend, fetch); calls runQuery/runMutation
 *   - internalMutation = DB writes only; CANNOT call runMutation (Convex
 *     forbids mutation-to-mutation chaining); registration stamping is
 *     INLINED into `_markContactPushed`
 *   - internalQuery = read-only DB
 *
 * Lease semantics:
 *   - `_claimWaveRunLease` sets `broadcastRampConfig.pendingRunId = runId`
 *     AND inserts the `waveRuns` row in the same mutation. Refuses if a
 *     lease is held OR if any active `waveRuns` row exists.
 *   - Every scheduled action re-validates lease at entry. If
 *     `pendingRunId !== row.runId` it exits without side effects (operator
 *     force-released, or run was discarded).
 *   - Lease is cleared on `_finalizeWaveRun` success or `discardWaveRun`.
 *
 * Recovery routing (operator):
 *   - status='pushing' / 'segment-created' (stale): `resumeStalledWaveRun`
 *   - status='broadcast-created' OR failureSubstatus='send-broadcast-failed':
 *       `resumeFinalizeWaveRun({confirmedNotSent: true})` after Resend-
 *       dashboard verification, OR `markFinalizeRecovered` if Resend shows
 *       already sent
 *   - failureSubstatus='create-broadcast-failed': `resumeFinalizeWaveRun`
 *       (no confirmedNotSent — no broadcast exists yet)
 *   - failureSubstatus='batch-failure-rate-exceeded' / 'segment-create-failed' /
 *       'persist-failed': `discardWaveRun` (transient retry won't help)
 *   - failureSubstatus='empty-pool': terminal no-op; lease auto-cleared
 *
 * See `plans/2026-04-29-post-launch-stabilization.md` for the full
 * architecture decisions, codex-approved through round 6.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import {
  createSegment,
  upsertContactToSegment,
} from "./_resendContacts";

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/** Default per-batch push size. Sized so 250 Resend round-trips at ~400ms each
 *  fit well below the 10-min Convex action runtime budget. */
const DEFAULT_BATCH_SIZE = 250;

/** Max rows persisted per `_persistPickedBatch` call. Convex per-mutation write
 *  limits sit around 8k docs; 500 leaves comfortable headroom for the row
 *  insert + the lease-coordination patches. */
const PERSIST_CHUNK_SIZE = 500;

/** Max rows deleted per `_cleanupDiscardedWavePickedContacts` call. */
const CLEANUP_CHUNK_SIZE = 500;

/** Rolling failure-rate ceiling. If a `pushBatchAction` brings
 *  `failedCount/totalCount` above this fraction, the whole run flips to
 *  `failed/batch-failure-rate-exceeded` — operator must `discardWaveRun`. */
const FAILURE_RATE_THRESHOLD = 0.05;

/** Resend backoff schedule (ms) for 429/5xx. Last entry is jitter base. */
const RESEND_BACKOFF_MS = [250, 500, 1000];
const RESEND_BACKOFF_MAX_RETRIES = 3;

/** Pagination size for `_getRegistrationsPage`. Same value as the legacy
 *  `assignAndExportWave` for consistency. */
const REGISTRATIONS_PAGE_SIZE = 1000;

// ───────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ───────────────────────────────────────────────────────────────────────────

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}${domain}`;
}

class Reservoir<T> {
  private readonly size: number;
  private readonly buf: T[] = [];
  private seen = 0;
  constructor(size: number) { this.size = size; }
  offer(item: T): void {
    this.seen++;
    if (this.buf.length < this.size) {
      this.buf.push(item);
    } else {
      const j = Math.floor(Math.random() * this.seen);
      if (j < this.size) this.buf[j] = item;
    }
  }
  values(): T[] { return this.buf; }
  totalSeen(): number { return this.seen; }
}

/**
 * Wraps an upstream Resend call with exponential backoff on 429/5xx-like
 * outcomes. The push helper returns `{kind:'failed', reason}` rather than
 * throwing, so we re-classify the reason string.
 */
async function pushWithBackoff(
  apiKey: string,
  email: string,
  segmentId: string,
): Promise<Awaited<ReturnType<typeof upsertContactToSegment>>> {
  let lastResult: Awaited<ReturnType<typeof upsertContactToSegment>> | undefined;
  for (let attempt = 0; attempt < RESEND_BACKOFF_MAX_RETRIES; attempt++) {
    const result = await upsertContactToSegment(apiKey, email, segmentId);
    if (result.kind !== "failed") return result;
    lastResult = result;
    // Re-classify: only retry transient (429, 5xx). 4xx other than 429
    // (e.g. 400/403/404) is permanent — abort early.
    const transient = /\b(429|5\d\d)\b/.test(result.reason);
    if (!transient || attempt === RESEND_BACKOFF_MAX_RETRIES - 1) {
      return result;
    }
    // The fallback chain ends at the last entry of RESEND_BACKOFF_MS, which
    // is statically non-empty — but `noUncheckedIndexedAccess` doesn't know
    // that. Coerce to number (last entry guaranteed defined; default 1000ms
    // if the array were ever emptied — fail-safe).
    const base =
      RESEND_BACKOFF_MS[attempt] ??
      RESEND_BACKOFF_MS[RESEND_BACKOFF_MS.length - 1] ??
      1000;
    // ±20% jitter
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const sleepMs = Math.max(0, base + jitter);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  return lastResult ?? { kind: "failed", reason: "[pushWithBackoff] exhausted with no result" };
}

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type WaveRunStatus =
  | "picking"
  | "segment-created"
  | "pushing"
  | "broadcast-created"
  | "sent"
  | "failed";

export type WaveFailureSubstatus =
  | "empty-pool"
  | "segment-create-failed"
  | "persist-failed"
  | "batch-failure-rate-exceeded"
  | "create-broadcast-failed"
  | "send-broadcast-failed"
  | "discarded-by-operator";

export type ClaimLeaseResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "lease-held" | "no-config" | "label-collides"; current?: string };

// ───────────────────────────────────────────────────────────────────────────
// Pre-flight queries (re-used from audienceWaveExport via direct query —
// kept here as proxies so this module's runQuery calls don't reach across
// sibling modules unnecessarily)
// ───────────────────────────────────────────────────────────────────────────

export const _hasWaveLabel = internalQuery({
  args: { waveLabel: v.string() },
  handler: async (ctx, { waveLabel }) => {
    const existing = await ctx.db
      .query("registrations")
      .withIndex("by_proLaunchWave", (q) => q.eq("proLaunchWave", waveLabel))
      .first();
    return existing !== null;
  },
});

export const _getSuppressedEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("emailSuppressions").collect();
    return all
      .map((row) => row.normalizedEmail)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  },
});

export const _getPaidEmails = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("customers").collect();
    return all
      .map((row) => {
        const stored = row.normalizedEmail;
        if (stored && stored.length > 0) return stored;
        return (row.email ?? "").trim().toLowerCase();
      })
      .filter((e): e is string => typeof e === "string" && e.length > 0);
  },
});

export const _getRegistrationsPage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { cursor, numItems }) => {
    return await ctx.db
      .query("registrations")
      .paginate({ cursor, numItems });
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Pick phase
// ───────────────────────────────────────────────────────────────────────────

/**
 * Acquire the wave-run lease atomically. Refuses if:
 *   - no `broadcastRampConfig` row (config was aborted)
 *   - `pendingRunId` is already set on the config (another run holds the lease)
 *   - any active `waveRuns` row exists with status in
 *     {picking, segment-created, pushing, broadcast-created} — defensive belt
 *     in case the ramp lease was force-cleared but a `waveRuns` row survives
 *
 * On success: sets `pendingRunId` on the config + inserts the `waveRuns` row
 * in `picking` status. Both writes are in this single mutation so there's
 * no window where one is set without the other.
 */
export const _claimWaveRunLease = internalMutation({
  args: {
    waveLabel: v.string(),
    runId: v.string(),
    requestedCount: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, args): Promise<ClaimLeaseResult> => {
    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!config) return { ok: false, reason: "no-config" };
    if (config.pendingRunId) {
      return { ok: false, reason: "lease-held", current: config.pendingRunId };
    }
    // Defensive: even if the ramp lease was force-cleared, refuse if any
    // active waveRuns row exists (would otherwise allow a parallel run that
    // collides on the segment + registration stamps). Iterate over each
    // active status so we use the by_status index instead of a full scan.
    for (const status of ACTIVE_STATUSES) {
      const existing = await ctx.db
        .query("waveRuns")
        .withIndex("by_status", (q) => q.eq("status", status))
        .first();
      if (existing) {
        return { ok: false, reason: "lease-held", current: existing.runId };
      }
    }
    const collides = await ctx.db
      .query("registrations")
      .withIndex("by_proLaunchWave", (q) => q.eq("proLaunchWave", args.waveLabel))
      .first();
    if (collides) return { ok: false, reason: "label-collides" };

    const now = Date.now();
    await ctx.db.patch(config._id, {
      pendingRunId: args.runId,
      pendingRunStartedAt: now,
      pendingWaveLabel: args.waveLabel,
    });
    await ctx.db.insert("waveRuns", {
      runId: args.runId,
      waveLabel: args.waveLabel,
      status: "picking",
      requestedCount: args.requestedCount,
      totalCount: 0,
      underfilled: false,
      pushedCount: 0,
      failedCount: 0,
      batchSize: args.batchSize,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, runId: args.runId };
  },
});

/**
 * Insert a chunk of picked-contact rows. Called repeatedly from
 * `pickWaveAction` to stay under Convex per-mutation write limits.
 */
export const _persistPickedBatch = internalMutation({
  args: {
    runId: v.string(),
    contacts: v.array(v.string()), // normalizedEmails
  },
  handler: async (ctx, { runId, contacts }) => {
    if (contacts.length > PERSIST_CHUNK_SIZE) {
      throw new Error(
        `[_persistPickedBatch] chunk too large: ${contacts.length} > ${PERSIST_CHUNK_SIZE}`,
      );
    }
    const now = Date.now();
    for (const email of contacts) {
      await ctx.db.insert("wavePickedContacts", {
        runId,
        normalizedEmail: email,
        status: "pending",
      });
    }
    // Bump updatedAt so the in-flight guard's lastActivityAt fallback sees fresh activity.
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (run) await ctx.db.patch(run._id, { updatedAt: now });
    return { inserted: contacts.length };
  },
});

/**
 * Transition a `picking`-status run to `segment-created` after pickWaveAction
 * has finished sampling, persisting, and creating the Resend segment.
 */
export const _markPickComplete = internalMutation({
  args: {
    runId: v.string(),
    segmentId: v.string(),
    totalCount: v.number(),
    underfilled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run) throw new Error(`[_markPickComplete] no run ${args.runId}`);
    if (run.status !== "picking") {
      throw new Error(
        `[_markPickComplete] run ${args.runId} is ${run.status}, expected picking`,
      );
    }
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "segment-created",
      segmentId: args.segmentId,
      totalCount: args.totalCount,
      underfilled: args.underfilled,
      updatedAt: now,
    });
    return { ok: true };
  },
});

/**
 * Record a pick-phase failure. Lease policy depends on substatus:
 *   - 'empty-pool' clears the lease (terminal no-op; operator may retry next cycle)
 *   - 'segment-create-failed' / 'persist-failed' KEEP the lease (operator must
 *     `discardWaveRun` to clear, after inspecting Resend dashboard)
 */
export const _markPickFailed = internalMutation({
  args: {
    runId: v.string(),
    substatus: v.union(
      v.literal("empty-pool"),
      v.literal("segment-create-failed"),
      v.literal("persist-failed"),
    ),
    error: v.string(),
  },
  handler: async (ctx, { runId, substatus, error }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return { ok: false as const, reason: "no-run" as const };
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "failed",
      failureSubstatus: substatus,
      error: error.slice(0, 500),
      updatedAt: now,
    });

    if (substatus === "empty-pool") {
      const config = await ctx.db
        .query("broadcastRampConfig")
        .withIndex("by_key", (q) => q.eq("key", "current"))
        .unique();
      if (config && config.pendingRunId === runId) {
        await ctx.db.patch(config._id, {
          pendingRunId: undefined,
          pendingRunStartedAt: undefined,
          pendingWaveLabel: undefined,
          lastRunStatus: "no-op-empty-pool",
          lastRunAt: now,
        });
      }
    }
    return { ok: true as const };
  },
});

export const pickWaveAction = internalAction({
  args: {
    waveLabel: v.string(),
    runId: v.string(),
    requestedCount: v.number(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("[pickWaveAction] RESEND_API_KEY not set");
    }
    if (!Number.isFinite(args.requestedCount) || args.requestedCount <= 0) {
      throw new Error(
        `[pickWaveAction] requestedCount must be a positive integer; got ${args.requestedCount}`,
      );
    }
    if (args.waveLabel.length === 0 || args.waveLabel.length > 64) {
      throw new Error("[pickWaveAction] waveLabel must be 1-64 chars");
    }
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

    // Step 1: claim lease + insert waveRuns row.
    const claim: ClaimLeaseResult = await ctx.runMutation(
      internal.broadcast.waveRuns._claimWaveRunLease,
      {
        waveLabel: args.waveLabel,
        runId: args.runId,
        requestedCount: args.requestedCount,
        batchSize,
      },
    );
    if (!claim.ok) {
      throw new Error(
        `[pickWaveAction] could not claim lease: ${claim.reason}` +
        (claim.current ? ` (current: ${claim.current})` : ""),
      );
    }

    try {
      // Step 2: stream registrations + reservoir-sample.
      const [suppressed, paid] = await Promise.all([
        ctx.runQuery(internal.broadcast.waveRuns._getSuppressedEmails, {}),
        ctx.runQuery(internal.broadcast.waveRuns._getPaidEmails, {}),
      ]);
      const suppressedSet = new Set(suppressed);
      const paidSet = new Set(paid);

      const reservoir = new Reservoir<string>(args.requestedCount);
      let cursor: string | null = null;
      while (true) {
        const page: {
          page: Array<{ normalizedEmail: string; proLaunchWave?: string }>;
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(
          internal.broadcast.waveRuns._getRegistrationsPage,
          { cursor, numItems: REGISTRATIONS_PAGE_SIZE },
        );
        for (const row of page.page) {
          const email = row.normalizedEmail;
          if (!email || email.length === 0) continue;
          if (suppressedSet.has(email)) continue;
          if (paidSet.has(email)) continue;
          if (row.proLaunchWave) continue;
          reservoir.offer(email);
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }

      const picked = reservoir.values();

      // Empty-pool guard. Clears the lease via _markPickFailed.
      if (picked.length === 0) {
        await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
          runId: args.runId,
          substatus: "empty-pool",
          error: "no unstamped registrations",
        });
        return { ok: false, reason: "empty-pool" };
      }

      // Step 3: create the Resend segment.
      const segmentName = `pro-launch-${args.waveLabel}`;
      let segmentId: string;
      try {
        segmentId = await createSegment(apiKey, segmentName);
      } catch (err) {
        await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
          runId: args.runId,
          substatus: "segment-create-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Step 4: chunk-persist picked rows. Each chunk is its own mutation so
      // we stay under Convex per-mutation write limits at any wave size.
      try {
        for (let i = 0; i < picked.length; i += PERSIST_CHUNK_SIZE) {
          const chunk = picked.slice(i, i + PERSIST_CHUNK_SIZE);
          await ctx.runMutation(internal.broadcast.waveRuns._persistPickedBatch, {
            runId: args.runId,
            contacts: chunk,
          });
        }
      } catch (err) {
        await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
          runId: args.runId,
          substatus: "persist-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Step 5: mark pick complete + schedule first push batch.
      await ctx.runMutation(internal.broadcast.waveRuns._markPickComplete, {
        runId: args.runId,
        segmentId,
        totalCount: picked.length,
        underfilled: picked.length < args.requestedCount,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.broadcast.waveRuns.pushBatchAction,
        { runId: args.runId, batchN: 0 },
      );

      console.log(
        `[pickWaveAction] complete: runId=${args.runId} waveLabel=${args.waveLabel} ` +
        `picked=${picked.length} requested=${args.requestedCount} underfilled=${picked.length < args.requestedCount}`,
      );
      return { ok: true };
    } catch (err) {
      // If we got here without _markPickFailed having run, surface the error
      // — but DON'T clear the lease (keeps the run in failed state for
      // operator inspection).
      console.error(
        `[pickWaveAction] runId=${args.runId} unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Push phase
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lightweight read for a `pushBatchAction` to validate state on entry +
 * decide whether to schedule the next batch or finalize.
 */
export const _resumeBatchInfo = internalQuery({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return null;
    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    const pending = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId_status", (q) => q.eq("runId", runId).eq("status", "pending"))
      .take(1);
    return {
      run: {
        runId: run.runId,
        waveLabel: run.waveLabel,
        status: run.status,
        segmentId: run.segmentId,
        totalCount: run.totalCount,
        pushedCount: run.pushedCount,
        failedCount: run.failedCount,
        batchSize: run.batchSize,
        broadcastId: run.broadcastId,
      },
      configHoldsLease: config?.pendingRunId === runId,
      hasPending: pending.length > 0,
    };
  },
});

/**
 * Return up to `limit` `pending`-status contacts for a run. Sorted by
 * `_creationTime` (default Convex order) so the same prefix is returned to
 * a resume call as to the original action — gives idempotent batching.
 */
export const _getPendingBatch = internalQuery({
  args: {
    runId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { runId, limit }) => {
    return await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId_status", (q) =>
        q.eq("runId", runId).eq("status", "pending"),
      )
      .take(limit);
  },
});

export const _markPushingStarted = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return { ok: false as const, reason: "no-run" as const };
    if (run.status === "pushing") return { ok: true as const, alreadyPushing: true as const };
    if (run.status !== "segment-created") {
      return { ok: false as const, reason: `wrong-status-${run.status}` as const };
    }
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "pushing", lastBatchAt: now, updatedAt: now });
    return { ok: true as const, alreadyPushing: false as const };
  },
});

/**
 * Mark a per-contact row as pushed. CAS guard: no-op unless current
 * status is 'pending'. Atomic with: pushedCount++, lastBatchAt update,
 * AND inline-stamp the matching `registrations` row (mutations cannot
 * call other mutations via runMutation, so the stamp logic from
 * `_stampWaveByNormalizedEmail` is duplicated here).
 */
export const _markContactPushed = internalMutation({
  args: {
    runId: v.string(),
    normalizedEmail: v.string(),
    waveLabel: v.string(),
  },
  handler: async (ctx, { runId, normalizedEmail, waveLabel }) => {
    const contact = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId_status", (q) =>
        q.eq("runId", runId).eq("status", "pending"),
      )
      .filter((q) => q.eq(q.field("normalizedEmail"), normalizedEmail))
      .unique();
    if (!contact) {
      // Either already-pushed or already-failed (CAS no-op) OR nonexistent.
      return { ok: false as const, reason: "not-pending" as const };
    }
    const now = Date.now();
    await ctx.db.patch(contact._id, { status: "pushed", pushedAt: now });

    // Inline registration stamp (cannot delegate to _stampWaveByNormalizedEmail
    // because Convex mutations cannot call other mutations).
    const reg = await ctx.db
      .query("registrations")
      .withIndex("by_normalized_email", (q) =>
        q.eq("normalizedEmail", normalizedEmail),
      )
      .first();
    let stampResult: "stamped" | "alreadyStamped" | "notFound";
    if (!reg) {
      stampResult = "notFound";
    } else if (reg.proLaunchWave === waveLabel) {
      stampResult = "alreadyStamped";
    } else {
      await ctx.db.patch(reg._id, {
        proLaunchWave: waveLabel,
        proLaunchWaveAssignedAt: now,
      });
      stampResult = "stamped";
    }

    // Bump waveRuns.pushedCount + lastBatchAt atomically with the row patch.
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (run) {
      await ctx.db.patch(run._id, {
        pushedCount: run.pushedCount + 1,
        lastBatchAt: now,
        updatedAt: now,
      });
    }
    return { ok: true as const, stampResult };
  },
});

/**
 * Mark a per-contact row as failed. CAS guard: no-op unless current
 * status is 'pending'. Increments failedCount. If the new failure rate
 * exceeds FAILURE_RATE_THRESHOLD, ALSO atomically flips the whole run
 * to status='failed' with failureSubstatus='batch-failure-rate-exceeded'.
 */
export const _markContactFailed = internalMutation({
  args: {
    runId: v.string(),
    normalizedEmail: v.string(),
    failedReason: v.string(),
  },
  handler: async (ctx, { runId, normalizedEmail, failedReason }) => {
    const contact = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId_status", (q) =>
        q.eq("runId", runId).eq("status", "pending"),
      )
      .filter((q) => q.eq(q.field("normalizedEmail"), normalizedEmail))
      .unique();
    if (!contact) {
      return { ok: false as const, reason: "not-pending" as const };
    }
    const now = Date.now();
    await ctx.db.patch(contact._id, {
      status: "failed",
      failedAt: now,
      failedReason: failedReason.slice(0, 500),
    });

    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return { ok: true as const, runFailed: false as const };

    const newFailedCount = run.failedCount + 1;
    const failureRate = run.totalCount > 0 ? newFailedCount / run.totalCount : 0;
    const exceeded = failureRate > FAILURE_RATE_THRESHOLD;
    await ctx.db.patch(run._id, {
      failedCount: newFailedCount,
      lastBatchAt: now,
      updatedAt: now,
      ...(exceeded
        ? {
            status: "failed" as const,
            failureSubstatus: "batch-failure-rate-exceeded",
            error: `failure rate ${(failureRate * 100).toFixed(2)}% exceeds ${(FAILURE_RATE_THRESHOLD * 100).toFixed(0)}% threshold`,
          }
        : {}),
    });
    return { ok: true as const, runFailed: exceeded };
  },
});

export const pushBatchAction = internalAction({
  args: {
    runId: v.string(),
    batchN: v.number(),
  },
  handler: async (
    ctx,
    { runId, batchN },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("[pushBatchAction] RESEND_API_KEY not set");

    // Lease + state revalidation.
    const info = await ctx.runQuery(
      internal.broadcast.waveRuns._resumeBatchInfo,
      { runId },
    );
    if (!info) {
      console.warn(`[pushBatchAction] runId=${runId} not found; exiting`);
      return { ok: false, reason: "no-run" };
    }
    if (!info.configHoldsLease) {
      console.warn(`[pushBatchAction] runId=${runId} lost lease; exiting`);
      return { ok: false, reason: "lost-lease" };
    }
    const allowedStatuses: WaveRunStatus[] = ["segment-created", "pushing"];
    if (!allowedStatuses.includes(info.run.status)) {
      console.warn(
        `[pushBatchAction] runId=${runId} status=${info.run.status} not pushable; exiting`,
      );
      return { ok: false, reason: `wrong-status-${info.run.status}` };
    }
    if (!info.run.segmentId) {
      throw new Error(`[pushBatchAction] runId=${runId} has no segmentId`);
    }

    // First-batch transition picking → pushing (idempotent).
    if (info.run.status === "segment-created") {
      await ctx.runMutation(
        internal.broadcast.waveRuns._markPushingStarted,
        { runId },
      );
    }

    // Pull this batch's pending contacts.
    const batch = await ctx.runQuery(
      internal.broadcast.waveRuns._getPendingBatch,
      { runId, limit: info.run.batchSize },
    );
    if (batch.length === 0) {
      // Nothing pending — schedule finalize.
      await ctx.scheduler.runAfter(
        0,
        internal.broadcast.waveRuns.finalizeWaveAction,
        { runId },
      );
      return { ok: true, reason: "no-pending-finalize-scheduled" };
    }

    // Push each row with backoff. CAS-guarded mark mutations make the loop
    // safe under overlapping pushBatchAction invocations.
    let runFailed = false;
    for (const contact of batch) {
      const result = await pushWithBackoff(apiKey, contact.normalizedEmail, info.run.segmentId);
      if (result.kind === "failed") {
        const failResult = await ctx.runMutation(
          internal.broadcast.waveRuns._markContactFailed,
          {
            runId,
            normalizedEmail: contact.normalizedEmail,
            failedReason: result.reason,
          },
        );
        if (failResult.ok && failResult.runFailed) {
          runFailed = true;
          console.error(
            `[pushBatchAction] runId=${runId} batch=${batchN} failure-rate threshold tripped`,
          );
          break;
        }
        console.error(
          `[pushBatchAction] push failed for ${maskEmail(contact.normalizedEmail)}: ${result.reason}`,
        );
        continue;
      }
      // Outcomes: created | linkedExisting | alreadyInSegment — all valid.
      await ctx.runMutation(
        internal.broadcast.waveRuns._markContactPushed,
        {
          runId,
          normalizedEmail: contact.normalizedEmail,
          waveLabel: info.run.waveLabel,
        },
      );
    }

    if (runFailed) return { ok: false, reason: "batch-failure-rate-exceeded" };

    // Decide next step from fresh state.
    const after = await ctx.runQuery(
      internal.broadcast.waveRuns._resumeBatchInfo,
      { runId },
    );
    if (!after || after.run.status === "failed") {
      return { ok: false, reason: `terminal-status-${after?.run.status ?? "<missing>"}` };
    }
    if (after.hasPending) {
      await ctx.scheduler.runAfter(
        0,
        internal.broadcast.waveRuns.pushBatchAction,
        { runId, batchN: batchN + 1 },
      );
      return { ok: true, reason: "next-batch-scheduled" };
    }
    await ctx.scheduler.runAfter(
      0,
      internal.broadcast.waveRuns.finalizeWaveAction,
      { runId },
    );
    return { ok: true, reason: "finalize-scheduled" };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Finalize phase
// ───────────────────────────────────────────────────────────────────────────

export const _markBroadcastCreated = internalMutation({
  args: {
    runId: v.string(),
    broadcastId: v.string(),
  },
  handler: async (ctx, { runId, broadcastId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[_markBroadcastCreated] no run ${runId}`);
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "broadcast-created",
      broadcastId,
      lastBatchAt: now, // re-arm in-flight guard for the send phase
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

export const _markFinalizeFailed = internalMutation({
  args: {
    runId: v.string(),
    substatus: v.union(
      v.literal("create-broadcast-failed"),
      v.literal("send-broadcast-failed"),
    ),
    error: v.string(),
  },
  handler: async (ctx, { runId, substatus, error }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[_markFinalizeFailed] no run ${runId}`);
    const now = Date.now();
    // For send-broadcast-failed we keep status='broadcast-created' so the
    // discriminator is the substatus, not the status — clearer for operator
    // tooling, and matches the "broadcast object exists in Resend; only the
    // send call failed" invariant. For create-broadcast-failed we flip to
    // status='failed' since no broadcast object was created.
    const statusPatch =
      substatus === "create-broadcast-failed"
        ? { status: "failed" as const }
        : {};
    await ctx.db.patch(run._id, {
      ...statusPatch,
      failureSubstatus: substatus,
      error: error.slice(0, 500),
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

/**
 * Atomic success commit. Advances `broadcastRampConfig.currentTier`, sets
 * `lastWave*` fields, clears the lease, AND marks `waveRuns.status='sent'`
 * — all in one transaction. The only path that reconciles the run with
 * the long-term ramp state.
 */
export const _finalizeWaveRun = internalMutation({
  args: {
    runId: v.string(),
    sentAt: v.number(),
  },
  handler: async (ctx, { runId, sentAt }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[_finalizeWaveRun] no run ${runId}`);
    if (!run.broadcastId || !run.segmentId) {
      throw new Error(
        `[_finalizeWaveRun] run ${runId} missing broadcastId/segmentId`,
      );
    }

    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!config) throw new Error("[_finalizeWaveRun] no broadcastRampConfig");

    const now = Date.now();
    const nextTier = config.currentTier + 1;

    await ctx.db.patch(config._id, {
      currentTier: nextTier,
      lastWaveLabel: run.waveLabel,
      lastWaveBroadcastId: run.broadcastId,
      lastWaveSegmentId: run.segmentId,
      lastWaveAssigned: run.pushedCount,
      lastWaveSentAt: sentAt,
      lastRunStatus: "succeeded",
      lastRunAt: now,
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
      pendingWaveLabel: undefined,
      pendingSegmentId: undefined,
      pendingAssigned: undefined,
      pendingExportAt: undefined,
      pendingBroadcastId: undefined,
      pendingBroadcastAt: undefined,
    });
    await ctx.db.patch(run._id, {
      status: "sent",
      updatedAt: now,
    });
    return { ok: true as const, advancedToTier: nextTier };
  },
});

export const finalizeWaveAction = internalAction({
  args: { runId: v.string() },
  handler: async (
    ctx,
    { runId },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const info = await ctx.runQuery(
      internal.broadcast.waveRuns._resumeBatchInfo,
      { runId },
    );
    if (!info) return { ok: false, reason: "no-run" };
    if (!info.configHoldsLease) return { ok: false, reason: "lost-lease" };
    if (!info.run.segmentId) {
      throw new Error(`[finalizeWaveAction] runId=${runId} missing segmentId`);
    }

    // Path 1: run is in 'pushing' (or 'segment-created' as a defensive case)
    // → create the broadcast first via ctx.runAction (Convex pattern for
    // action→action invocation, mirrors rampRunner.ts:886).
    if (info.run.status === "pushing" || info.run.status === "segment-created") {
      let createResult: { broadcastId: string; segmentId: string; subject: string; name: string };
      try {
        createResult = await ctx.runAction(
          internal.broadcast.sendBroadcast.createProLaunchBroadcast,
          {
            segmentId: info.run.segmentId,
            nameSuffix: info.run.waveLabel,
          },
        );
      } catch (err) {
        await ctx.runMutation(
          internal.broadcast.waveRuns._markFinalizeFailed,
          {
            runId,
            substatus: "create-broadcast-failed",
            error: err instanceof Error ? err.message : String(err),
          },
        );
        throw err;
      }
      await ctx.runMutation(
        internal.broadcast.waveRuns._markBroadcastCreated,
        { runId, broadcastId: createResult.broadcastId },
      );
    } else if (info.run.status !== "broadcast-created") {
      return { ok: false, reason: `wrong-status-${info.run.status}` };
    }

    // Path 2 (and continuation of Path 1): broadcast exists in Resend; send it.
    const after = await ctx.runQuery(
      internal.broadcast.waveRuns._resumeBatchInfo,
      { runId },
    );
    if (!after?.run.broadcastId) {
      throw new Error(`[finalizeWaveAction] runId=${runId} missing broadcastId post-create`);
    }
    try {
      await ctx.runAction(
        internal.broadcast.sendBroadcast.sendProLaunchBroadcast,
        { broadcastId: after.run.broadcastId },
      );
    } catch (err) {
      await ctx.runMutation(
        internal.broadcast.waveRuns._markFinalizeFailed,
        {
          runId,
          substatus: "send-broadcast-failed",
          error: err instanceof Error ? err.message : String(err),
        },
      );
      throw err;
    }

    // Success — atomic finalize.
    await ctx.runMutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId,
      sentAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Operator one-shot: when `failureSubstatus='send-broadcast-failed'` BUT
 * Resend dashboard shows the broadcast was actually queued/sent, finalize
 * directly without retrying the send. Required arg `sentAt` from the
 * operator's observation (Resend dashboard shows the timestamp).
 */
export const markFinalizeRecovered = internalMutation({
  args: {
    runId: v.string(),
    sentAt: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, { runId, sentAt, reason }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[markFinalizeRecovered] no run ${runId}`);
    if (run.failureSubstatus !== "send-broadcast-failed" && run.status !== "broadcast-created") {
      throw new Error(
        `[markFinalizeRecovered] run ${runId} not in send-failure state (status=${run.status}, substatus=${run.failureSubstatus ?? "<none>"})`,
      );
    }
    if (!run.broadcastId || !run.segmentId) {
      throw new Error(`[markFinalizeRecovered] run ${runId} missing broadcastId/segmentId`);
    }
    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!config) throw new Error("[markFinalizeRecovered] no broadcastRampConfig");

    const now = Date.now();
    const nextTier = config.currentTier + 1;
    await ctx.db.patch(config._id, {
      currentTier: nextTier,
      lastWaveLabel: run.waveLabel,
      lastWaveBroadcastId: run.broadcastId,
      lastWaveSegmentId: run.segmentId,
      lastWaveAssigned: run.pushedCount,
      lastWaveSentAt: sentAt,
      lastRunStatus: `succeeded-via-finalize-recovered: ${reason.slice(0, 200)}`,
      lastRunAt: now,
      lastRunError: undefined,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
      pendingWaveLabel: undefined,
      pendingSegmentId: undefined,
      pendingAssigned: undefined,
      pendingExportAt: undefined,
      pendingBroadcastId: undefined,
      pendingBroadcastAt: undefined,
    });
    await ctx.db.patch(run._id, {
      status: "sent",
      updatedAt: now,
      error: undefined,
      failureSubstatus: undefined,
    });
    return { ok: true as const, advancedToTier: nextTier };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Operator recovery
// ───────────────────────────────────────────────────────────────────────────

/**
 * Soft-discard. Marks the run failed and rotates `waveLabelOffset` so the
 * NEXT wave doesn't reuse the discarded label. Does NOT physically delete
 * `wavePickedContacts` rows — the daily cleanup cron does that in chunks.
 *
 * Operator must inspect Resend dashboard separately for the segment +
 * any partially-created broadcast.
 */
export const discardWaveRun = internalMutation({
  args: {
    runId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, { runId, reason }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[discardWaveRun] no run ${runId}`);
    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!config) throw new Error("[discardWaveRun] no broadcastRampConfig");

    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "failed",
      failureSubstatus: "discarded-by-operator",
      error: reason.slice(0, 500),
      updatedAt: now,
    });
    await ctx.db.patch(config._id, {
      waveLabelOffset: config.waveLabelOffset + 1,
      lastRunStatus: `discarded-by-operator: ${reason.slice(0, 200)}`,
      lastRunAt: now,
      pendingRunId: undefined,
      pendingRunStartedAt: undefined,
      pendingWaveLabel: undefined,
      pendingSegmentId: undefined,
      pendingAssigned: undefined,
      pendingExportAt: undefined,
      pendingBroadcastId: undefined,
      pendingBroadcastAt: undefined,
    });
    return {
      ok: true as const,
      newWaveLabelOffset: config.waveLabelOffset + 1,
    };
  },
});

/**
 * Push-phase recovery only. Refuses for finalize-phase failures (route to
 * `resumeFinalizeWaveRun`) and for terminal-success.
 */
export const resumeStalledWaveRun = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[resumeStalledWaveRun] no run ${runId}`);
    if (run.status === "broadcast-created") {
      throw new Error(
        `[resumeStalledWaveRun] runId=${runId} is in broadcast-created — use resumeFinalizeWaveRun({confirmedNotSent: true}) after Resend-dashboard verification, OR markFinalizeRecovered if the broadcast was actually sent.`,
      );
    }
    if (run.status === "failed") {
      throw new Error(
        `[resumeStalledWaveRun] runId=${runId} is in failed (substatus=${run.failureSubstatus ?? "<none>"}) — use resumeFinalizeWaveRun (for create/send substatuses) or discardWaveRun (for batch-failure-rate-exceeded / pick-phase substatuses).`,
      );
    }
    if (run.status === "sent") {
      throw new Error(`[resumeStalledWaveRun] runId=${runId} is already sent`);
    }

    const now = Date.now();
    await ctx.db.patch(run._id, { lastBatchAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(
      0,
      internal.broadcast.waveRuns.pushBatchAction,
      { runId, batchN: 0 },
    );
    return { ok: true as const, scheduled: "pushBatchAction" as const };
  },
});

/**
 * Finalize-phase recovery. Requires `confirmedNotSent: true` for the
 * send-failure case (operator MUST verify in Resend dashboard before
 * invoking — Resend may have queued the send despite the action seeing
 * an error response).
 */
export const resumeFinalizeWaveRun = internalMutation({
  args: {
    runId: v.string(),
    confirmedNotSent: v.optional(v.boolean()),
  },
  handler: async (ctx, { runId, confirmedNotSent }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) throw new Error(`[resumeFinalizeWaveRun] no run ${runId}`);

    const isSendFailureCase =
      run.status === "broadcast-created" ||
      run.failureSubstatus === "send-broadcast-failed";
    const isCreateFailureCase =
      run.status === "failed" &&
      run.failureSubstatus === "create-broadcast-failed";

    if (isSendFailureCase) {
      if (confirmedNotSent !== true) {
        throw new Error(
          `[resumeFinalizeWaveRun] runId=${runId} is in send-failure state. ` +
          `BEFORE retrying, verify in the Resend dashboard whether the broadcast for ` +
          `broadcastId=${run.broadcastId ?? "<unknown>"} was actually queued or sent ` +
          `(Resend may accept a send despite the action seeing a network/timeout error). ` +
          `If confirmed NOT sent, re-run with {confirmedNotSent: true}. ` +
          `If Resend shows the broadcast as already sent, use markFinalizeRecovered({runId, sentAt}) instead.`,
        );
      }
      // Reset to broadcast-created so finalizeWaveAction skips create + retries send.
      const now = Date.now();
      await ctx.db.patch(run._id, {
        status: "broadcast-created",
        failureSubstatus: undefined,
        error: undefined,
        lastBatchAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.broadcast.waveRuns.finalizeWaveAction,
        { runId },
      );
      return { ok: true as const, scheduled: "finalizeWaveAction-send-only" as const };
    }

    if (isCreateFailureCase) {
      // No broadcast exists yet — patch back to pushing so finalizeWaveAction
      // re-enters via the create-broadcast path. Operator should verify in
      // Resend dashboard that the SEGMENT still exists before resuming.
      const now = Date.now();
      await ctx.db.patch(run._id, {
        status: "pushing",
        failureSubstatus: undefined,
        error: undefined,
        lastBatchAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.broadcast.waveRuns.finalizeWaveAction,
        { runId },
      );
      return { ok: true as const, scheduled: "finalizeWaveAction-create-and-send" as const };
    }

    throw new Error(
      `[resumeFinalizeWaveRun] runId=${runId} is in status=${run.status} substatus=${run.failureSubstatus ?? "<none>"} — ` +
      `not a finalize-phase failure. Use resumeStalledWaveRun (for pushing/segment-created) or discardWaveRun (for batch-failure / pick-phase failures).`,
    );
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Cleanup
// ───────────────────────────────────────────────────────────────────────────

export const _cleanupDiscardedWavePickedContacts = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const rows = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .take(CLEANUP_CHUNK_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === CLEANUP_CHUNK_SIZE };
  },
});

/**
 * Cron-scheduled action that finds discarded/failed `waveRuns` rows older
 * than 24h and chunked-deletes their `wavePickedContacts`. Self-schedules
 * the next chunk if any rows remain.
 */
export const cleanupDiscardedWavePickedContactsAction = internalAction({
  args: {
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ deleted: number; hasMore: boolean }> => {
    if (args.runId) {
      const result = await ctx.runMutation(
        internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
        { runId: args.runId },
      );
      if (result.hasMore) {
        await ctx.scheduler.runAfter(
          0,
          internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
          { runId: args.runId },
        );
      }
      return result;
    }

    // No specific runId — scan failed runs >24h old.
    const candidates = await ctx.runQuery(
      internal.broadcast.waveRuns._listFailedWaveRunsForCleanup,
      {},
    );
    let totalDeleted = 0;
    for (const runId of candidates) {
      const result = await ctx.runMutation(
        internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
        { runId },
      );
      totalDeleted += result.deleted;
      if (result.hasMore) {
        await ctx.scheduler.runAfter(
          0,
          internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
          { runId },
        );
      }
    }
    return { deleted: totalDeleted, hasMore: false };
  },
});

export const _listFailedWaveRunsForCleanup = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const failed = await ctx.db
      .query("waveRuns")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();
    return failed.filter((r) => r.updatedAt < cutoff).map((r) => r.runId);
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Status surface (for runDailyRamp guard + getRampStatus)
// ───────────────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES: WaveRunStatus[] = [
  "picking",
  "segment-created",
  "pushing",
  "broadcast-created",
];

export const _listInFlightWaveRuns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows: Array<{
      runId: string;
      status: WaveRunStatus;
      lastActivityAt: number;
    }> = [];
    for (const status of ACTIVE_STATUSES) {
      const found = await ctx.db
        .query("waveRuns")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const r of found) {
        rows.push({
          runId: r.runId,
          status: r.status,
          lastActivityAt: r.lastBatchAt ?? r.updatedAt ?? r.createdAt,
        });
      }
    }
    return rows;
  },
});

export const getWaveRunStatus = internalQuery({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return null;
    const pending = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId_status", (q) =>
        q.eq("runId", runId).eq("status", "pending"),
      )
      .take(1);
    return {
      runId: run.runId,
      waveLabel: run.waveLabel,
      status: run.status,
      failureSubstatus: run.failureSubstatus,
      error: run.error,
      segmentId: run.segmentId,
      broadcastId: run.broadcastId,
      requestedCount: run.requestedCount,
      totalCount: run.totalCount,
      pushedCount: run.pushedCount,
      failedCount: run.failedCount,
      underfilled: run.underfilled,
      hasPendingContacts: pending.length > 0,
      lastActivityAt: run.lastBatchAt ?? run.updatedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  },
});
