import { assertAccountWritable } from "./accountDeletion/guard";
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
import { PREFERENCE_VARIANTS, ROLLING_DEPLOYMENT_PREFERENCE_KEYS } from "../shared/cloud-preferences-contract";
import { normalizeWebcamPreferences } from "../shared/pinned-webcams";
import {
  MAX_DASHBOARD_TAB_CHANGES_PER_CALL,
  MAX_DASHBOARD_TAB_TOMBSTONES,
  MAX_SYNCED_DASHBOARD_TABS,
  type DashboardTabChangeResult,
  type DashboardTabRow,
  type SyncDashboardTabsResult,
} from "../shared/dashboard-tab-sync";
import {
  checkDashboardTabId,
  checkDashboardTabRecord,
  dashboardTabRecordValidator,
} from "./lib/dashboardTabRecord";
import type { Doc } from "./_generated/dataModel";

const preferenceVariant = v.union(...PREFERENCE_VARIANTS.map(variant => v.literal(variant)));

export const getPreferencesByUserId = internalQuery({
  args: { userId: v.string(), variant: preferenceVariant },
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", args.userId).eq("variant", args.variant),
      )
      .unique();
    return prefs ? { ...prefs, data: normalizeWebcamPreferences(prefs.data) } : null;
  },
});

export const getPreferences = query({
  args: { variant: preferenceVariant },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = identity.subject;
    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();
    return prefs ? { ...prefs, data: normalizeWebcamPreferences(prefs.data) } : null;
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
    variant: preferenceVariant,
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
    await assertAccountWritable(ctx, userId);

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

    const mergedData = preserveOmittedRollingDeploymentFields(existing?.data, args.data);
    const data = normalizeWebcamPreferences(mergedData);
    const blobSize = Math.max(JSON.stringify(mergedData).length, JSON.stringify(data).length);
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

// ── Dashboard tabs (#11141) ─────────────────────────────────────────────────
//
// Each tab is its own row in `userDashboardTabs`, never part of the blob
// above: a full tab snapshot is ~15 KB and the blob caps at
// MAX_PREFS_BLOB_SIZE. Rows are compared and set per tab with a
// server-assigned `version`, so two devices editing different tabs never
// collide, and a delete stays as a tombstone so other devices learn of it.

const dashboardTabChange = v.object({
  tabId: v.string(),
  baseVersion: v.optional(v.number()),
  record: v.union(dashboardTabRecordValidator, v.null()),
});

// Every row one account can hold for a variant, plus one call's inserts.
const DASHBOARD_TAB_ROW_SCAN_LIMIT =
  MAX_SYNCED_DASHBOARD_TABS + MAX_DASHBOARD_TAB_TOMBSTONES + MAX_DASHBOARD_TAB_CHANGES_PER_CALL + 1;

function toDashboardTabRow(row: Doc<"userDashboardTabs">): DashboardTabRow {
  return {
    tabId: row.tabId,
    version: row.version,
    deleted: row.deleted,
    ...(row.record ? { record: row.record } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every stored tab row, live and deleted, for the caller and one variant. A
 * signed-out caller gets an empty list rather than an error, so the client can
 * subscribe on every load.
 */
export const listDashboardTabs = query({
  args: { variant: preferenceVariant },
  handler: async (ctx, args): Promise<DashboardTabRow[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("userDashboardTabs")
      .withIndex("by_user_variant", (q) => q.eq("userId", identity.subject).eq("variant", args.variant))
      .take(DASHBOARD_TAB_ROW_SCAN_LIMIT);
    return rows.map(toDashboardTabRow);
  },
});

/**
 * Apply a batch of tab changes. Each change is compared and set on its own:
 * `baseVersion` must equal the stored version (and be absent for a tab the
 * server has never seen), or that change returns CONFLICT with the current
 * row and writes nothing. `record: null` turns the row into a tombstone.
 *
 * `expectedUserId` is the account the client's sync state belongs to. Clerk
 * can switch the active account without a sign-out, so a batch built from one
 * account's tabs can arrive with another account's token; that batch is
 * refused whole (WRONG_ACCOUNT) before it spends rate limit.
 */
export const syncDashboardTabs = mutation({
  args: {
    variant: preferenceVariant,
    expectedUserId: v.string(),
    changes: v.array(dashboardTabChange),
  },
  handler: async (ctx, args): Promise<SyncDashboardTabsResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;
    if (args.expectedUserId !== userId) return { ok: false, reason: "WRONG_ACCOUNT" };
    await assertAccountWritable(ctx, userId);
    if (args.changes.length > MAX_DASHBOARD_TAB_CHANGES_PER_CALL) {
      throw new ConvexError({ kind: "INVALID_TAB", field: "changes" });
    }
    const seenTabIds = new Set<string>();
    for (const change of args.changes) {
      checkDashboardTabId(change.tabId);
      if (seenTabIds.has(change.tabId)) throw new ConvexError({ kind: "INVALID_TAB", field: "changes.tabId" });
      seenTabIds.add(change.tabId);
      if (change.record) checkDashboardTabRecord(change.record);
    }

    const rateLimit = await checkUserPrefsWriteRateLimit(ctx, userId);
    if (!rateLimit.ok) return rateLimit;

    const rows = await ctx.db
      .query("userDashboardTabs")
      .withIndex("by_user_variant", (q) => q.eq("userId", userId).eq("variant", args.variant))
      .take(DASHBOARD_TAB_ROW_SCAN_LIMIT);
    const byTabId = new Map(rows.map((row) => [row.tabId, row]));
    let liveCount = rows.filter((row) => !row.deleted).length;
    const tombstones = rows.filter((row) => row.deleted);
    const now = Date.now();
    const results: DashboardTabChangeResult[] = [];
    let floor: Doc<"userDashboardTabVersionFloors"> | null | undefined;
    const readFloor = async () => {
      if (floor === undefined) {
        floor = await ctx.db
          .query("userDashboardTabVersionFloors")
          .withIndex("by_user_variant", (q) => q.eq("userId", userId).eq("variant", args.variant))
          .unique();
      }
      return floor;
    };

    for (const change of args.changes) {
      const row = byTabId.get(change.tabId);
      if ((row?.version ?? undefined) !== change.baseVersion) {
        results.push({ tabId: change.tabId, ok: false, reason: "CONFLICT", row: row ? toDashboardTabRow(row) : null });
        continue;
      }

      if (change.record === null) {
        if (!row) {
          // Nothing stored and nothing to delete.
          results.push({ tabId: change.tabId, ok: true, version: 0 });
          continue;
        }
        const version = row.version + 1;
        if (!row.deleted) liveCount -= 1;
        await ctx.db.replace(row._id, {
          userId, variant: args.variant, tabId: row.tabId, version, deleted: true,
          createdAt: row.createdAt, updatedAt: now,
        });
        if (!row.deleted) tombstones.push({ ...row, deleted: true, updatedAt: now, version });
        else {
          // Deleted again: prune by the time just written, not the old one.
          const index = tombstones.findIndex((t) => t._id === row._id);
          if (index !== -1) tombstones[index] = { ...tombstones[index]!, updatedAt: now, version };
        }
        results.push({ tabId: change.tabId, ok: true, version });
        continue;
      }

      const becomesLive = !row || row.deleted;
      if (becomesLive && liveCount >= MAX_SYNCED_DASHBOARD_TABS) {
        results.push({ tabId: change.tabId, ok: false, reason: "TAB_LIMIT", limit: MAX_SYNCED_DASHBOARD_TABS });
        continue;
      }
      if (row) {
        const version = row.version + 1;
        await ctx.db.patch(row._id, { record: change.record, deleted: false, version, updatedAt: now });
        if (row.deleted) {
          const index = tombstones.findIndex((t) => t._id === row._id);
          if (index !== -1) tombstones.splice(index, 1);
        }
        results.push({ tabId: change.tabId, ok: true, version });
      } else {
        // Above every pruned tombstone: this id may have been a tab before.
        const version = ((await readFloor())?.version ?? 0) + 1;
        await ctx.db.insert("userDashboardTabs", {
          userId, variant: args.variant, tabId: change.tabId, version, deleted: false,
          record: change.record, createdAt: now, updatedAt: now,
        });
        results.push({ tabId: change.tabId, ok: true, version });
      }
      if (becomesLive) liveCount += 1;
    }

    // Keep the newest tombstones. A device that still holds a base for an
    // evicted one reads the absent row as a delete.
    if (tombstones.length > MAX_DASHBOARD_TAB_TOMBSTONES) {
      tombstones.sort((a, b) => a.updatedAt - b.updatedAt);
      let highest = 0;
      for (const stale of tombstones.slice(0, tombstones.length - MAX_DASHBOARD_TAB_TOMBSTONES)) {
        highest = Math.max(highest, stale.version);
        await ctx.db.delete(stale._id);
      }
      const current = await readFloor();
      if (!current) {
        await ctx.db.insert("userDashboardTabVersionFloors", { userId, variant: args.variant, version: highest, updatedAt: now });
      } else if (highest > current.version) {
        await ctx.db.patch(current._id, { version: highest, updatedAt: now });
      }
    }

    return { ok: true, results };
  },
});
