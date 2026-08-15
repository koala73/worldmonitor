import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  CURRENT_PREFS_SCHEMA_VERSION,
  MAX_PREFS_BLOB_SIZE,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from "./constants";
import { ROLLING_DEPLOYMENT_PREFERENCE_KEYS } from "../shared/cloud-preferences-contract";

export const getPreferencesByUserId = internalQuery({
  args: { userId: v.string(), variant: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", args.userId).eq("variant", args.variant),
      )
      .unique();
  },
});

export const getPreferences = query({
  args: { variant: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = identity.subject;
    return await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();
  },
});

/**
 * Discriminated return shape. `CONFLICT` is the CAS-guard "no-op" path —
 * intentional behavior for two-device concurrency. Switching from `throw`
 * to `return` here means Convex Insights stops labeling it
 * `Uncaught ConvexError` (no throw → no log surface), but the wire shape
 * exposed through `api/user-prefs.ts` (HTTP 409 with `actualSyncVersion`)
 * is unchanged — clients see the same response.
 *
 * Expected write denials return instead of throwing so limiter accounting and
 * duplicate-row cleanup persist in Convex. `UNAUTHENTICATED` remains a throw
 * because it is auth drift / bad input rather than a metered write attempt.
 */
export type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: "CONFLICT"; actualSyncVersion: number }
  | { ok: false; reason: "BLOB_TOO_LARGE"; size: number; max: number }
  | { ok: false; reason: "RATE_LIMITED"; limit: number; reset: number };

type UserPrefsWriteRateLimitResult =
  | { ok: true }
  | { ok: false; reason: "RATE_LIMITED"; limit: number; reset: number };

const RATE_LIMIT_COUNTER_SCAN_LIMIT = USER_PREFS_WRITE_RATE_LIMIT + 1;
/**
 * Per-run delete cap for `pruneStaleWriteRateLimits`. Rows are four scalar
 * fields, so 500 deletes sit far under Convex's per-mutation write budget while
 * still draining an hour of expired windows for hundreds of users in one pass.
 */
const RATE_LIMIT_PRUNE_BATCH = 500;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Older clients replace the complete preference blob without fields added by
 * a newer deployment. Preserve only these omission-safe fields from an
 * existing row; explicit reset values such as "[]" and "1" remain authoritative.
 */
export function preserveOmittedRollingDeploymentFields(
  existingData: unknown,
  incomingData: unknown,
): unknown {
  if (!isRecord(existingData) || !isRecord(incomingData)) return incomingData;

  let merged: Record<string, unknown> | null = null;
  for (const key of ROLLING_DEPLOYMENT_PREFERENCE_KEYS) {
    if (
      !Object.prototype.hasOwnProperty.call(incomingData, key)
      && typeof existingData[key] === "string"
    ) {
      merged ??= { ...incomingData };
      merged[key] = existingData[key];
    }
  }
  return merged ?? incomingData;
}

function currentRateLimitWindowStart(now: number): number {
  return Math.floor(now / USER_PREFS_WRITE_RATE_WINDOW_MS) * USER_PREFS_WRITE_RATE_WINDOW_MS;
}

/**
 * Every index range this touches is bounded to `(userId, windowStart)` — the
 * single row the limiter actually accounts against. Convex derives a mutation's
 * OCC read set from the ranges it scans, so widening this by even one unbounded
 * query drags the caller's rows from every other window into the read set, and
 * any concurrent write by the SAME user (two dashboard tabs, or a dragged
 * slider persisting per change) invalidates it. That is how #6706
 * (WORLDMONITOR-ZE) livelocked: retries collided with the still-arriving
 * contending writes until Convex exhausted them and the write failed outright.
 *
 * Expired-window rows are therefore NOT collected here. They are opportunistic
 * garbage with no reader, and `pruneStaleWriteRateLimits` ages them out on a
 * cron instead — off the user-facing path entirely.
 */
export async function checkUserPrefsWriteRateLimit(
  ctx: MutationCtx,
  userId: string,
): Promise<UserPrefsWriteRateLimitResult> {
  const now = Date.now();
  const windowStart = currentRateLimitWindowStart(now);
  const reset = windowStart + USER_PREFS_WRITE_RATE_WINDOW_MS;
  const currentRows = await ctx.db
    .query("userPreferenceWriteRateLimits")
    .withIndex("by_user_window", (q) =>
      q.eq("userId", userId).eq("windowStart", windowStart),
    )
    .take(RATE_LIMIT_COUNTER_SCAN_LIMIT);
  const count = currentRows.reduce((sum, row) => sum + row.count, 0);
  const retained = currentRows[0] ?? null;

  for (const row of currentRows.slice(1)) {
    await ctx.db.delete(row._id);
  }

  if (count >= USER_PREFS_WRITE_RATE_LIMIT) {
    if (retained && retained.count !== count) {
      await ctx.db.patch(retained._id, {
        count,
        updatedAt: now,
      });
    }
    return {
      ok: false,
      reason: "RATE_LIMITED",
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset,
    };
  }

  if (retained) {
    await ctx.db.patch(retained._id, {
      count: count + 1,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("userPreferenceWriteRateLimits", {
      userId,
      windowStart,
      count: 1,
      updatedAt: now,
    });
  }

  return { ok: true };
}

/**
 * Retention sweep for `userPreferenceWriteRateLimits` (#6706). The limiter used
 * to garbage-collect expired windows inline on every write, which is what
 * widened the write path's OCC read set and livelocked concurrent writers. The
 * work itself still has to happen — the table gains a row per user per window
 * they write in and has no native TTL — so it moved here, where nothing
 * contends with it.
 *
 * The cutoff is the CURRENT window start and is not operator-overridable. A row
 * at or above it is a live counter; deleting one would hand that user a fresh
 * budget, so the only knob exposed is the batch size. Rows below it can never
 * be read or incremented again — `checkUserPrefsWriteRateLimit` only ever scans
 * `(userId, currentWindowStart)` — so they are safe to drop unconditionally.
 */
export const pruneStaleWriteRateLimits = internalMutation({
  args: {
    // Per-run delete cap. Optional so tests can drive the drain-over-multiple-
    // runs behavior without seeding RATE_LIMIT_PRUNE_BATCH rows.
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Floor of 1, and a non-finite value falls back to the default rather than
    // propagating: `take(0)` returns [], and the `>= batch` check below would
    // read 0 >= 0 as "a full batch" and reschedule forever, deleting nothing.
    const requestedBatch = args.limit;
    const batch = Number.isFinite(requestedBatch)
      ? Math.max(1, Math.floor(requestedBatch as number))
      : RATE_LIMIT_PRUNE_BATCH;
    const cutoff = currentRateLimitWindowStart(Date.now());

    const stale = await ctx.db
      .query("userPreferenceWriteRateLimits")
      .withIndex("by_windowStart", (q) => q.lt("windowStart", cutoff))
      .take(batch);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    // Self-drain: a full batch means more expired rows remain. Each pass
    // deletes `batch` rows and the cutoff only ever moves forward, so the chain
    // terminates. Without it a single hourly tick would cap at `batch` rows and
    // a backlog larger than that could outpace the schedule indefinitely.
    const rescheduled = stale.length >= batch;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.userPreferences.pruneStaleWriteRateLimits, {
        limit: batch,
      });
    }

    return { deleted: stale.length, cutoff, rescheduled };
  },
});

export const setPreferences = mutation({
  args: {
    variant: v.string(),
    data: v.any(),
    expectedSyncVersion: v.number(),
    schemaVersion: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SetPreferencesResult> => {
    const identity = await ctx.auth.getUserIdentity();
    // UNAUTHENTICATED throws as a structured ConvexError because it is rare
    // auth drift / bad input we want surfaced in Sentry. Convex's
    // wire format propagates `errorData` for object payloads so the edge
    // handler routes via `err.data.kind`. (PR #3466 fixed the original
    // string-data wire-strip bug.)
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    // Run before the CAS read so stale expectedSyncVersion requests cannot
    // bypass the authoritative direct-Convex backstop by intentionally
    // returning CONFLICT forever. CONFLICT retries count as write attempts;
    // the limit is sized for that worst-case retry profile.
    const rateLimit = await checkUserPrefsWriteRateLimit(ctx, userId);
    if (!rateLimit.ok) return rateLimit;

    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const data = preserveOmittedRollingDeploymentFields(existing?.data, args.data);
    const blobSize = JSON.stringify(data).length;
    if (blobSize > MAX_PREFS_BLOB_SIZE) {
      return {
        ok: false,
        reason: "BLOB_TOO_LARGE",
        size: blobSize,
        max: MAX_PREFS_BLOB_SIZE,
      };
    }

    if (existing && existing.syncVersion !== args.expectedSyncVersion) {
      // CAS-guard "no-op". Returns rather than throws — see SetPreferencesResult
      // doc comment. Wire shape (HTTP 409 with actualSyncVersion in body) is
      // unchanged at the edge handler.
      return {
        ok: false,
        reason: "CONFLICT",
        actualSyncVersion: existing.syncVersion,
      };
    }

    const nextSyncVersion = (existing?.syncVersion ?? 0) + 1;
    const schemaVersion = args.schemaVersion ?? CURRENT_PREFS_SCHEMA_VERSION;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        variant: args.variant,
        data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
    }

    return { ok: true, syncVersion: nextSyncVersion };
  },
});
