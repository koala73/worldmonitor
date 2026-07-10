import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import {
  CURRENT_PREFS_SCHEMA_VERSION,
  MAX_PREFS_BLOB_SIZE,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from "./constants";

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
const RATE_LIMIT_STALE_CLEANUP_LIMIT = 5;

async function checkUserPrefsWriteRateLimit(
  ctx: MutationCtx,
  userId: string,
): Promise<UserPrefsWriteRateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / USER_PREFS_WRITE_RATE_WINDOW_MS) * USER_PREFS_WRITE_RATE_WINDOW_MS;
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

  const staleRows = await ctx.db
    .query("userPreferenceWriteRateLimits")
    .withIndex("by_user_window", (q) => q.eq("userId", userId))
    .take(RATE_LIMIT_STALE_CLEANUP_LIMIT);
  for (const row of staleRows) {
    if (row.windowStart !== windowStart) await ctx.db.delete(row._id);
  }

  return { ok: true };
}

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

    const blobSize = JSON.stringify(args.data).length;
    if (blobSize > MAX_PREFS_BLOB_SIZE) {
      return {
        ok: false,
        reason: "BLOB_TOO_LARGE",
        size: blobSize,
        max: MAX_PREFS_BLOB_SIZE,
      };
    }

    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

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
        data: args.data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        variant: args.variant,
        data: args.data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
    }

    return { ok: true, syncVersion: nextSyncVersion };
  },
});
