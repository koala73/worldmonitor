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
import { filterPageForEligibility } from "./_poolSelection";

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

/** Resend backoff schedule (ms) for 429/5xx. The loop runs for
 *  attempts 0..MAX-1; the final attempt's outcome is returned without
 *  sleeping further. So we need MAX-1 sleep slots, not MAX. */
const RESEND_BACKOFF_MS = [250, 500];
const RESEND_BACKOFF_MAX_RETRIES = 3;

/** Pagination size for `_getRegistrationsPage`. Same value as the legacy
 *  `assignAndExportWave` for consistency. */
const REGISTRATIONS_PAGE_SIZE = 1000;

/** Minimum picked count for a wave to be useful. Tied to
 *  `MIN_DELIVERED_FOR_KILLGATE = 100` (rampRunner.ts) — if fewer than this
 *  many contacts are picked, the wave's delivered count will never reach
 *  the threshold needed for the kill-gate stats to be trusted, and the
 *  next runDailyRamp tick gets stuck on `awaiting-prior-stats` forever.
 *
 *  Below this threshold, pickWaveAction treats the run as terminal —
 *  marks `failed/pool-too-small`, deactivates the ramp, and clears the
 *  lease. The waitlist is effectively drained; operator must extend the
 *  curve OR restart the ramp manually if more contacts are wanted. */
const MIN_USABLE_POOL_SIZE = 100;

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
    // The loop returns before reaching this line on attempt === MAX-1 (see
    // condition above), so attempt is in [0, MAX-1) here. RESEND_BACKOFF_MS
    // is sized to MAX-1 slots — the index is always in-range — but
    // noUncheckedIndexedAccess can't prove that. Defensive fallback to
    // the last entry, then a hard 1000ms safety net if the array were
    // ever shorter.
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

/**
 * Look up users-table rows for a list of normalized emails. Returns only
 * matched rows (missing emails are absent from the result, NOT represented
 * as null). Convex wire format: array of records, NOT a Map (Maps aren't
 * serializable across the action↔query boundary).
 *
 * Caller (pickWaveAction / _dryRunNonEnglishExclusion) is expected to
 * dedupe inputs before calling.
 *
 * Performance: parallelizes index lookups via `Promise.all` inside the
 * query handler. Convex query handlers can issue concurrent
 * `ctx.db.query(...).first()` reads against an index — they run within
 * the same transaction (read isolation) but don't serialize round-trips.
 * For a 1000-email input, this turns ~1000 sequential awaits (~1s+) into
 * one parallel batch (~100ms typical).
 *
 * Future scaling consideration: at >10k authenticated users in
 * production, consider materializing `localePrimary` on
 * `registrations.localePrimary` directly via `users:ensureRecord`'s
 * second write. That eliminates this cross-table lookup entirely from
 * the broadcast hot path, at the cost of one extra patch per ensureRecord
 * call. Bulk-loading all users via `.collect()` is NOT a safe interim
 * step — Convex's per-query transaction limit (~8MB / ~16k rows) caps
 * this. For wave-8 today (~hundreds of authenticated users), the
 * Promise.all batched approach is sufficient and forward-compatible
 * with either follow-up architecture.
 */
export const _getUsersByEmailPage = internalQuery({
  args: {
    emails: v.array(v.string()),
  },
  handler: async (ctx, { emails }) => {
    const validEmails = emails.filter((e) => e && e.length > 0);
    if (validEmails.length === 0) return [];
    const rows = await Promise.all(
      validEmails.map((email) =>
        ctx.db
          .query("users")
          .withIndex("by_normalizedEmail", (q) =>
            q.eq("normalizedEmail", email),
          )
          .first(),
      ),
    );
    const out: Array<{ normalizedEmail: string; localePrimary?: string }> = [];
    for (const row of rows) {
      if (row && row.normalizedEmail) {
        out.push({
          normalizedEmail: row.normalizedEmail,
          localePrimary: row.localePrimary,
        });
      }
    }
    return out;
  },
});

/**
 * Operator pre-flight: report the IMPACT of running pickWaveAction with
 * `excludeNonEnglish: true` against the CURRENT eligible pool, WITHOUT
 * actually firing a wave. Mirrors pickWaveAction's read path
 * (suppressed + paid + paginated registrations + per-page _getUsersByEmailPage
 * + filterPageForEligibility) but does NOT touch Resend / scheduler /
 * wavePickedContacts / waveRuns.
 *
 * Operator runbook: run BEFORE flipping `excludeNonEnglish: true` on a
 * real ramp. Inspect the returned counters; sanity-check that the
 * `excludedByLocale` distribution matches expected demographics (e.g.,
 * `zh > ru > ko > ja` for an English-launch list). If `excludedTotal /
 * eligibleTotal > 10%`, the heuristic is over-aggressive — investigate
 * before enabling.
 *
 * CLI:
 *   npx convex run broadcast/waveRuns:_dryRunNonEnglishExclusion '{}'
 */
export const _dryRunNonEnglishExclusion = internalAction({
  args: {
    sampleSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    eligibleTotal: number;
    excludedTotal: number;
    excludedByLocale: Record<string, number>;
    sampleExcludedEmails: string[];
  }> => {
    const sampleSize =
      typeof args.sampleSize === "number" && args.sampleSize > 0
        ? Math.min(args.sampleSize, 200)
        : 20;

    const [suppressed, paid] = await Promise.all([
      ctx.runQuery(internal.broadcast.waveRuns._getSuppressedEmails, {}),
      ctx.runQuery(internal.broadcast.waveRuns._getPaidEmails, {}),
    ]);
    const suppressedSet = new Set(suppressed);
    const paidSet = new Set(paid);

    let eligibleTotal = 0;
    let excludedTotal = 0;
    const excludedByLocale: Record<string, number> = {};
    const sampleExcludedEmails: string[] = [];

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

      // Fetch users-table rows for THIS PAGE's candidates only — bounded
      // by page size, not table size.
      const candidates: string[] = [];
      for (const row of page.page) {
        const e = row.normalizedEmail;
        if (!e || e.length === 0) continue;
        if (suppressedSet.has(e)) continue;
        if (paidSet.has(e)) continue;
        if (row.proLaunchWave) continue;
        candidates.push(e);
      }
      const dedup = Array.from(new Set(candidates));
      const usersByEmail: Map<string, { localePrimary?: string }> = new Map();
      if (dedup.length > 0) {
        const userRows: Array<{
          normalizedEmail: string;
          localePrimary?: string;
        }> = await ctx.runQuery(
          internal.broadcast.waveRuns._getUsersByEmailPage,
          { emails: dedup },
        );
        for (const u of userRows) {
          usersByEmail.set(u.normalizedEmail, {
            localePrimary: u.localePrimary,
          });
        }
      }

      const result = filterPageForEligibility({
        page: page.page,
        suppressedSet,
        paidSet,
        usersByEmail,
        excludeNonEnglish: true,
      });

      eligibleTotal += result.pageEligibleCount;
      excludedTotal += result.pageExcludedTotal;
      for (const [locale, count] of Object.entries(result.pageExcludedByLocale)) {
        excludedByLocale[locale] = (excludedByLocale[locale] ?? 0) + count;
      }

      // Collect a small sample of excluded emails for operator inspection.
      // Sampled in encounter order (good enough; not statistical). Build a
      // Set from `result.eligible` once per page so the membership check is
      // O(1) instead of O(eligible.length) per row — without this, the
      // worst-case sample-collection cost is O(page_size × eligible_size)
      // ≈ O(1000²) per page on a fully-eligible page (per greptile P2,
      // PR #3643).
      if (sampleExcludedEmails.length < sampleSize) {
        const eligibleSet = new Set(result.eligible);
        for (const row of page.page) {
          if (sampleExcludedEmails.length >= sampleSize) break;
          const e = row.normalizedEmail;
          if (!e) continue;
          if (suppressedSet.has(e) || paidSet.has(e) || row.proLaunchWave) continue;
          // If this email made it into result.eligible, it's NOT excluded.
          if (!eligibleSet.has(e)) {
            sampleExcludedEmails.push(e);
          }
        }
      }

      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    return { eligibleTotal, excludedTotal, excludedByLocale, sampleExcludedEmails };
  },
});

/**
 * Persist pool-filter audit fields onto the waveRuns row at the end of
 * pickWaveAction's pool-selection phase. NOT lease-validating: audit
 * fields are operational metadata, not state-machine state, and recording
 * them for THIS run's pool selection remains useful even if the lease has
 * since rotated. Throws only if the run row itself is missing (a logic
 * bug in the caller, not a normal recovery scenario).
 */
export const _recordPoolFilterStats = internalMutation({
  args: {
    runId: v.string(),
    excludeNonEnglish: v.boolean(),
    eligiblePoolCount: v.number(),
    excludedCount: v.number(),
    excludedLocaleCounts: v.record(v.string(), v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run) {
      throw new Error(`[_recordPoolFilterStats] no run ${args.runId}`);
    }
    await ctx.db.patch(run._id, {
      excludeNonEnglish: args.excludeNonEnglish,
      eligiblePoolCount: args.eligiblePoolCount,
      excludedCount: args.excludedCount,
      excludedLocaleCounts: args.excludedLocaleCounts,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
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
      v.literal("pool-too-small"),
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

    // Terminal-completion substatuses: clear the lease AND deactivate the
    // ramp. Both 'empty-pool' (zero picked) and 'pool-too-small' (picked
    // below MIN_USABLE_POOL_SIZE) mean the waitlist is drained — without
    // deactivating, the next cron tick would re-fire pickWaveAction and
    // hit the same condition repeatedly. For 'pool-too-small' specifically,
    // the alternative — let the wave proceed with say 50 contacts — would
    // strand the next cron tick on `awaiting-prior-stats` forever because
    // delivered count never reaches MIN_DELIVERED_FOR_KILLGATE=100.
    if (substatus === "empty-pool" || substatus === "pool-too-small") {
      const config = await ctx.db
        .query("broadcastRampConfig")
        .withIndex("by_key", (q) => q.eq("key", "current"))
        .unique();
      if (config && config.pendingRunId === runId) {
        await ctx.db.patch(config._id, {
          pendingRunId: undefined,
          pendingRunStartedAt: undefined,
          pendingWaveLabel: undefined,
          active: false,
          lastRunStatus:
            substatus === "empty-pool"
              ? "ramp-complete-empty-pool"
              : "ramp-complete-pool-too-small",
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
    // Filter contacts whose locale (from `users.localePrimary` or email-TLD
    // heuristic fallback) is non-English. Filter runs INSIDE the registration
    // pagination loop, BEFORE reservoir sampling — sampling-then-filtering
    // would silently underfill (sample 1000, exclude 200, send 800 even
    // though thousands of eligible English contacts existed elsewhere).
    excludeNonEnglish: v.optional(v.boolean()),
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
    const excludeNonEnglish = args.excludeNonEnglish === true;

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
      // Step 2: stream registrations + filter (per-page) + reservoir-sample.
      const [suppressed, paid] = await Promise.all([
        ctx.runQuery(internal.broadcast.waveRuns._getSuppressedEmails, {}),
        ctx.runQuery(internal.broadcast.waveRuns._getPaidEmails, {}),
      ]);
      const suppressedSet = new Set(suppressed);
      const paidSet = new Set(paid);

      const reservoir = new Reservoir<string>(args.requestedCount);
      // Pool-filter audit accumulators — persisted to waveRuns at end of pool
      // selection so any past wave's filter behavior is auditable from the
      // row alone (no log archaeology).
      let eligiblePoolCount = 0;
      let excludedCount = 0;
      const excludedLocaleCounts: Record<string, number> = {};

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

        // When filtering is active, fetch users-table data for THIS PAGE's
        // candidate emails (those that survive the non-locale filters).
        // Bounded by page size, NOT reservoir size — explicitly per-page to
        // avoid read-limit surprises on a 100k+ registration table.
        let usersByEmail: Map<string, { localePrimary?: string }> = new Map();
        if (excludeNonEnglish) {
          const candidates: string[] = [];
          for (const row of page.page) {
            const e = row.normalizedEmail;
            if (!e || e.length === 0) continue;
            if (suppressedSet.has(e)) continue;
            if (paidSet.has(e)) continue;
            if (row.proLaunchWave) continue;
            candidates.push(e);
          }
          const dedup = Array.from(new Set(candidates));
          if (dedup.length > 0) {
            const userRows: Array<{
              normalizedEmail: string;
              localePrimary?: string;
            }> = await ctx.runQuery(
              internal.broadcast.waveRuns._getUsersByEmailPage,
              { emails: dedup },
            );
            for (const u of userRows) {
              usersByEmail.set(u.normalizedEmail, {
                localePrimary: u.localePrimary,
              });
            }
          }
        }

        const result = filterPageForEligibility({
          page: page.page,
          suppressedSet,
          paidSet,
          usersByEmail,
          excludeNonEnglish,
        });

        for (const email of result.eligible) reservoir.offer(email);
        eligiblePoolCount += result.pageEligibleCount;
        excludedCount += result.pageExcludedTotal;
        for (const [locale, count] of Object.entries(result.pageExcludedByLocale)) {
          excludedLocaleCounts[locale] = (excludedLocaleCounts[locale] ?? 0) + count;
        }

        if (page.isDone) break;
        cursor = page.continueCursor;
      }

      // Persist pool-filter audit fields BEFORE the empty-pool guard so even
      // a discard-by-empty-pool run records what was filtered out.
      await ctx.runMutation(
        internal.broadcast.waveRuns._recordPoolFilterStats,
        {
          runId: args.runId,
          excludeNonEnglish,
          eligiblePoolCount,
          excludedCount,
          excludedLocaleCounts,
        },
      );

      const picked = reservoir.values();

      // Empty-pool guard. Clears the lease + deactivates the ramp.
      if (picked.length === 0) {
        await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
          runId: args.runId,
          substatus: "empty-pool",
          error: "no unstamped registrations",
        });
        return { ok: false, reason: "empty-pool" };
      }

      // Pool-too-small guard. picked.length < MIN_USABLE_POOL_SIZE means
      // the wave's delivered count will never reach the kill-gate threshold,
      // so the next cron tick would get stuck on `awaiting-prior-stats`
      // forever. Treat as terminal completion: deactivate the ramp + clear
      // the lease, surface for operator triage. Operator can re-activate
      // and extend `rampCurve` if more sends are wanted, OR run a final
      // wave manually via direct `pickWaveAction` call (which bypasses this
      // guard since the operator is taking deliberate action).
      if (picked.length < MIN_USABLE_POOL_SIZE) {
        await ctx.runMutation(internal.broadcast.waveRuns._markPickFailed, {
          runId: args.runId,
          substatus: "pool-too-small",
          error:
            `picked ${picked.length} contacts (< MIN_USABLE_POOL_SIZE=${MIN_USABLE_POOL_SIZE}); ` +
            `ramp deactivated to avoid stranding the next cron tick on awaiting-prior-stats. ` +
            `Operator: extend rampCurve + resumeRamp if more sends desired, or run a final wave manually.`,
        });
        return { ok: false, reason: "pool-too-small" };
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
 *
 * Takes `contactId` directly (not a query lookup) — at large wave sizes
 * the previous `.filter().unique()` scan over by_runId_status would
 * traverse all pending rows and trip Convex's 8192-document-read-per-
 * mutation limit (~8k pending contacts breaks the mutation). The id is
 * already in hand at the action's call site (`_getPendingBatch` returns
 * full Docs), so a direct `ctx.db.get(contactId)` is O(1) / 1 read AND
 * provides the same CAS guard via the post-load status check.
 */
export const _markContactPushed = internalMutation({
  args: {
    contactId: v.id("wavePickedContacts"),
    runId: v.string(),
    normalizedEmail: v.string(),
    waveLabel: v.string(),
  },
  handler: async (ctx, { contactId, runId, normalizedEmail, waveLabel }) => {
    const contact = await ctx.db.get(contactId);
    if (
      !contact ||
      contact.runId !== runId ||
      contact.status !== "pending" ||
      contact.normalizedEmail !== normalizedEmail
    ) {
      // CAS: no-op if already-pushed/failed, runId mismatch, or row deleted.
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
 *
 * Takes `contactId` directly to avoid the 8192-doc-read limit on large
 * waves — see `_markContactPushed` for rationale.
 */
export const _markContactFailed = internalMutation({
  args: {
    contactId: v.id("wavePickedContacts"),
    runId: v.string(),
    normalizedEmail: v.string(),
    failedReason: v.string(),
  },
  handler: async (ctx, { contactId, runId, normalizedEmail, failedReason }) => {
    const contact = await ctx.db.get(contactId);
    if (
      !contact ||
      contact.runId !== runId ||
      contact.status !== "pending" ||
      contact.normalizedEmail !== normalizedEmail
    ) {
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
            contactId: contact._id,
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
          contactId: contact._id,
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

/**
 * Lease + status CAS guard. Refuses unless:
 *   - waveRuns.status === 'pushing' (or already 'broadcast-created' for
 *     idempotency on retry — a duplicate finalizeWaveAction sees the same
 *     broadcastId and is a no-op)
 *   - broadcastRampConfig.pendingRunId === runId (still hold the lease)
 *
 * Without these guards, two concurrent finalizeWaveAction invocations
 * (e.g. operator-triggered resumeFinalizeWaveRun while the original is
 * mid-flight on a slow Resend response) could both call
 * createProLaunchBroadcast, both call _markBroadcastCreated, and overwrite
 * each other's broadcastId — leading to one of the two created Resend
 * broadcasts being orphaned + duplicate sends downstream.
 */
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

    // Idempotent: if already broadcast-created with the SAME broadcastId,
    // treat as no-op success. Different broadcastId = a duplicate Resend
    // broadcast was created — surface as failure so the caller can decide
    // (typically: log, don't proceed to send the new duplicate).
    if (run.status === "broadcast-created") {
      if (run.broadcastId === broadcastId) {
        return { ok: true as const, alreadyMarked: true as const };
      }
      return {
        ok: false as const,
        reason: "duplicate-broadcast-detected" as const,
        existing: run.broadcastId,
      };
    }
    if (run.status !== "pushing") {
      return { ok: false as const, reason: `wrong-status-${run.status}` as const };
    }

    const config = await ctx.db
      .query("broadcastRampConfig")
      .withIndex("by_key", (q) => q.eq("key", "current"))
      .unique();
    if (!config || config.pendingRunId !== runId) {
      return { ok: false as const, reason: "lost-lease" as const };
    }

    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "broadcast-created",
      broadcastId,
      lastBatchAt: now, // re-arm in-flight guard for the send phase
      updatedAt: now,
    });
    return { ok: true as const, alreadyMarked: false as const };
  },
});

/**
 * CAS-guarded failure recorder. Refuses to overwrite a terminal-success row
 * (`status='sent'`) — without this guard, a duplicate finalize action whose
 * Resend send returns "already sent" 422 would overwrite the WINNING
 * finalize's clean state with `failureSubstatus='send-broadcast-failed'`,
 * and a subsequent operator `markFinalizeRecovered` would re-advance the
 * tier a second time.
 */
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

    // Terminal-status CAS. If a concurrent finalize already committed
    // status='sent', this is a duplicate-finalize loser whose Resend
    // 422-already-sent error landed it here. Treat as no-op success — the
    // winner's state is correct; we should not overwrite it.
    if (run.status === "sent") {
      return { ok: false as const, reason: "already-sent" as const };
    }
    // Defensive: if already in a failed-with-different-substatus state,
    // refuse to overwrite. Operator's existing recovery routing depends
    // on the original substatus.
    if (
      run.status === "failed" &&
      run.failureSubstatus !== undefined &&
      run.failureSubstatus !== substatus
    ) {
      return {
        ok: false as const,
        reason: "already-failed-different-substatus" as const,
        existing: run.failureSubstatus,
      };
    }

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
 *
 * Lease + status CAS:
 *   - waveRuns.status MUST be 'broadcast-created' (or 'sent' for idempotency
 *     on a duplicate finalize — returns no-op success without re-advancing
 *     the tier)
 *   - broadcastRampConfig.pendingRunId MUST === runId
 *
 * Without these, two concurrent finalizes could both advance currentTier
 * (skipping a wave's worth of progress) AND both clear the lease.
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

    // Status check FIRST — broadcastId presence is downstream of being in
    // broadcast-created status. Checking presence before status would mask
    // a wrong-status caller behind a misleading "missing broadcastId" error.
    if (run.status === "sent") {
      // Idempotent: a duplicate finalize on an already-sent run is a no-op,
      // not an error. Don't re-advance the tier.
      return { ok: true as const, alreadySent: true as const, advancedToTier: undefined };
    }
    if (run.status !== "broadcast-created") {
      throw new Error(
        `[_finalizeWaveRun] run ${runId} is ${run.status}, expected broadcast-created`,
      );
    }
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
    if (config.pendingRunId !== runId) {
      throw new Error(
        `[_finalizeWaveRun] lost lease: expected ${runId}, found ${config.pendingRunId ?? "<cleared>"}. ` +
        `Refusing to advance tier — operator force-released the lease, or another run took over.`,
      );
    }

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
      // CAS-check the broadcast-created transition. A concurrent finalize
      // (e.g. operator-triggered resume mid-flight) could have already
      // created its own broadcast and patched the run. If we lost the race,
      // we just created an orphan broadcast in Resend — log loudly so the
      // operator knows to clean it up, then exit without sending.
      const markResult = await ctx.runMutation(
        internal.broadcast.waveRuns._markBroadcastCreated,
        { runId, broadcastId: createResult.broadcastId },
      );
      if (!markResult.ok) {
        console.error(
          `[finalizeWaveAction] CAS lost on _markBroadcastCreated runId=${runId} reason=${markResult.reason} ` +
          `our-broadcastId=${createResult.broadcastId}. The Resend broadcast we created is orphaned — ` +
          `operator should delete it via Resend dashboard if not the same as the winning runner's broadcastId.`,
        );
        return { ok: false, reason: `markBroadcastCreated-${markResult.reason}` };
      }
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
    // Final lease+status revalidation before send — narrows the duplicate-
    // send window. (Doesn't eliminate it: send IS external I/O; two actions
    // racing past this point still both call sendProLaunchBroadcast. Resend's
    // /broadcasts/:id/send rejects already-sent broadcasts with 422, which
    // is our last line of defence — if both actions raced past here, the
    // loser sees a Resend 422 and goes to send-broadcast-failed; the
    // _finalizeWaveRun's idempotency on already-sent then handles cleanup.)
    if (after.run.status === "sent") {
      // Another finalize already won. Idempotent no-op.
      console.log(`[finalizeWaveAction] runId=${runId} already sent by another invocation — exiting clean`);
      return { ok: true, reason: "already-sent" };
    }
    if (!after.configHoldsLease) {
      console.warn(`[finalizeWaveAction] runId=${runId} lost lease before send — exiting`);
      return { ok: false, reason: "lost-lease-pre-send" };
    }
    try {
      await ctx.runAction(
        internal.broadcast.sendBroadcast.sendProLaunchBroadcast,
        { broadcastId: after.run.broadcastId },
      );
    } catch (err) {
      const failResult = await ctx.runMutation(
        internal.broadcast.waveRuns._markFinalizeFailed,
        {
          runId,
          substatus: "send-broadcast-failed",
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // CAS detected the run is already 'sent' — this is a duplicate finalize
      // whose Resend call returned 422 already-sent (the winner finalized
      // ahead of us). Don't propagate the throw; the run state is correct.
      if (!failResult.ok && failResult.reason === "already-sent") {
        console.log(
          `[finalizeWaveAction] runId=${runId} send returned error but run already sent ` +
          `by another invocation — treating as duplicate-finalize loser (clean exit)`,
        );
        return { ok: true, reason: "already-sent-duplicate-loser" };
      }
      throw err;
    }

    // Success — atomic finalize. _finalizeWaveRun's CAS returns
    // {alreadySent: true} as a no-op if a concurrent finalize already
    // committed; that's fine.
    const fin = await ctx.runMutation(internal.broadcast.waveRuns._finalizeWaveRun, {
      runId,
      sentAt: Date.now(),
    });
    if ("alreadySent" in fin && fin.alreadySent) {
      return { ok: true, reason: "already-sent" };
    }
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

    // Strict status + substatus guard. We need BOTH:
    //   - status === 'broadcast-created' (the only state where the broadcast
    //     object exists in Resend AND the tier hasn't been advanced)
    //   - failureSubstatus === 'send-broadcast-failed' (confirms a genuine
    //     send failure that the operator has verified-as-actually-sent in
    //     the Resend dashboard)
    //
    // Status alone is insufficient: status='broadcast-created' is ALSO the
    // mid-flight state between _markBroadcastCreated and sendProLaunchBroadcast
    // (no substatus yet). An operator calling markFinalizeRecovered in that
    // window would advance the tier while finalizeWaveAction still runs;
    // the action's _finalizeWaveRun is now idempotent (won't double-advance),
    // but Resend ALSO sees the send as legitimate — so we'd have advanced
    // the tier on a still-in-flight wave. Better: require explicit failure
    // signal from operator-confirmed send-broadcast-failed.
    //
    // resumeFinalizeWaveRun's success path PATCHES failureSubstatus back to
    // undefined and reschedules the action, so a post-resume run also won't
    // pass this guard — operator must wait for the next attempt to either
    // succeed (status='sent') or fail back to send-broadcast-failed before
    // markFinalizeRecovered is invocable again. That's the right behavior:
    // markFinalizeRecovered is for the specific case "Resend confirmed sent
    // but our action saw an error".
    if (run.status !== "broadcast-created") {
      throw new Error(
        `[markFinalizeRecovered] run ${runId} status=${run.status} — recovery requires status='broadcast-created'. ` +
        (run.status === "sent"
          ? `The run was already finalized; nothing to recover. Inspect lastWaveSentAt on broadcastRampConfig.`
          : `If in 'failed', use resumeFinalizeWaveRun (which patches back to broadcast-created) or discardWaveRun.`),
      );
    }
    if (run.failureSubstatus !== "send-broadcast-failed") {
      throw new Error(
        `[markFinalizeRecovered] run ${runId} status='broadcast-created' but failureSubstatus=` +
        `${run.failureSubstatus ?? "<none>"}. markFinalizeRecovered only applies to send-broadcast-failed. ` +
        `If the run is mid-flight (no substatus), wait for finalizeWaveAction to finish — _finalizeWaveRun is ` +
        `idempotent on already-sent. If you ran resumeFinalizeWaveRun and want to abort the retry instead, ` +
        `wait for the scheduled finalizeWaveAction to either succeed or re-fail; only then is markFinalizeRecovered safe.`,
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
    // Lease must still be held by THIS runId — otherwise another run has
    // taken over OR an operator force-released and we'd be advancing the
    // tier from a stale runId.
    if (config.pendingRunId !== runId) {
      throw new Error(
        `[markFinalizeRecovered] runId=${runId} lost lease (held by ${config.pendingRunId ?? "<cleared>"}). ` +
        `Investigate: another run may have advanced the tier OR forceReleaseLease was used. ` +
        `Refusing to advance the tier from a stale runId.`,
      );
    }

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
    // Schedule cleanup IMMEDIATELY (not via the daily cron) so any contacts
    // that were `status='pushed'` during the discarded run are unstamped
    // before the next runDailyRamp tick — otherwise they'd be excluded
    // from future picks despite never having received the email.
    await ctx.scheduler.runAfter(
      0,
      internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
      { runId },
    );
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

/**
 * Cleanup mutation. Two responsibilities, in order:
 *
 *   1. UNSTAMP — for each `wavePickedContacts` row with `status='pushed'`,
 *      look up the matching `registrations` row and clear `proLaunchWave`
 *      iff it still equals THIS run's `waveLabel` (defensive — don't
 *      clobber a contact's stamp from a later wave). Without this, a
 *      contact pushed during a discarded run is permanently excluded from
 *      future picks despite never having received the email.
 *   2. DELETE — remove the `wavePickedContacts` row.
 *
 * Chunked at 500 rows. Caller (the cleanup action) loops until `hasMore`
 * is false. Idempotent: if called twice, the second call sees no rows
 * and returns `{deleted: 0, hasMore: false}`.
 */
export const _cleanupDiscardedWavePickedContacts = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db
      .query("waveRuns")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique();
    const waveLabel = run?.waveLabel;

    const rows = await ctx.db
      .query("wavePickedContacts")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .take(CLEANUP_CHUNK_SIZE);
    let unstamped = 0;
    for (const row of rows) {
      if (row.status === "pushed" && waveLabel) {
        const reg = await ctx.db
          .query("registrations")
          .withIndex("by_normalized_email", (q) =>
            q.eq("normalizedEmail", row.normalizedEmail),
          )
          .first();
        // Only clear if the stamp still matches THIS run's wave — a contact
        // re-picked into a later wave would have proLaunchWave set to that
        // newer wave's label; leave it alone.
        if (reg && reg.proLaunchWave === waveLabel) {
          await ctx.db.patch(reg._id, {
            proLaunchWave: undefined,
            proLaunchWaveAssignedAt: undefined,
          });
          unstamped++;
        }
      }
      await ctx.db.delete(row._id);
    }
    return {
      deleted: rows.length,
      unstamped,
      hasMore: rows.length === CLEANUP_CHUNK_SIZE,
    };
  },
});

/**
 * Cleanup orchestrator. Two invocation modes:
 *   - With `runId` arg: targeted cleanup, scheduled IMMEDIATELY by
 *     `discardWaveRun` so unstamping happens before the next runDailyRamp
 *     tick (otherwise `status='pushed'` contacts stay stamped until the
 *     daily cron runs).
 *   - Without `runId`: daily-cron scan of all `failed` waveRuns rows >24h
 *     old (cleans up runs the operator didn't explicitly discard).
 *
 * Both modes self-schedule the next 500-row chunk until each run is fully
 * drained, then move to the next candidate.
 */
export const cleanupDiscardedWavePickedContactsAction = internalAction({
  args: {
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    deleted: number;
    unstamped: number;
    hasMore: boolean;
  }> => {
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
      } else if (result.unstamped > 0) {
        console.log(
          `[cleanupDiscardedWavePickedContactsAction] runId=${args.runId} ` +
          `unstamped ${result.unstamped} registrations (re-eligible for future picks)`,
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
    let totalUnstamped = 0;
    for (const runId of candidates) {
      const result = await ctx.runMutation(
        internal.broadcast.waveRuns._cleanupDiscardedWavePickedContacts,
        { runId },
      );
      totalDeleted += result.deleted;
      totalUnstamped += result.unstamped;
      if (result.hasMore) {
        await ctx.scheduler.runAfter(
          0,
          internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
          { runId },
        );
      }
    }
    return { deleted: totalDeleted, unstamped: totalUnstamped, hasMore: false };
  },
});

/**
 * Auto-cleanup candidates: failed runs >24h old whose substatus indicates
 * **terminal abandonment** — meaning the operator either explicitly discarded
 * them or no recovery path is meaningful. RECOVERABLE finalize failures
 * (`create-broadcast-failed`, `send-broadcast-failed`) are excluded because
 * the segment may still be valid in Resend AND the operator may yet run
 * `resumeFinalizeWaveRun` / `markFinalizeRecovered`. If we cleaned those up,
 * the unstamping step would re-eligibilize already-pushed recipients and a
 * subsequent successful send would create duplicate outreach.
 *
 * Terminal substatuses (auto-cleanable):
 *   - `discarded-by-operator`           — operator chose abandonment
 *   - `empty-pool` / `pool-too-small`   — no contacts pushed; nothing to recover
 *   - `segment-create-failed`           — no contacts pushed; segment doesn't exist
 *   - `persist-failed`                  — partial pushes possible; operator should
 *                                          discard explicitly. Auto-cleanup AFTER
 *                                          24h is a safety net for forgotten cases
 *   - `batch-failure-rate-exceeded`     — push-rate threshold tripped; operator
 *                                          should discard. Same 24h safety net rationale
 *
 * Recoverable (NEVER auto-cleaned):
 *   - `create-broadcast-failed`         — `resumeFinalizeWaveRun` retries create
 *   - `send-broadcast-failed`           — `resumeFinalizeWaveRun({confirmedNotSent})`
 *                                          retries send, OR `markFinalizeRecovered`
 *                                          finalizes if Resend shows already-sent
 */
const TERMINAL_FAILURE_SUBSTATUSES = [
  "discarded-by-operator",
  "empty-pool",
  "pool-too-small",
  "segment-create-failed",
  "persist-failed",
  "batch-failure-rate-exceeded",
] as const;

/** Max failed runs to consider per cleanup cron tick. Bounded so a
 *  long-lived deployment with many discarded waves doesn't load the
 *  whole table into memory at once. The cron runs daily — at 100/day,
 *  cleanup would catch up on any reasonable backlog within a week. */
const CLEANUP_CANDIDATES_PER_TICK = 100;

export const _listFailedWaveRunsForCleanup = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const failed = await ctx.db
      .query("waveRuns")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(CLEANUP_CANDIDATES_PER_TICK);
    return failed
      .filter(
        (r) =>
          r.updatedAt < cutoff &&
          r.failureSubstatus !== undefined &&
          (TERMINAL_FAILURE_SUBSTATUSES as readonly string[]).includes(
            r.failureSubstatus,
          ),
      )
      .map((r) => r.runId);
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
