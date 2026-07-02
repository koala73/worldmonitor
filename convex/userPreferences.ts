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
 * `BLOB_TOO_LARGE` and `UNAUTHENTICATED` remain THROWS because they are
 * rare and we DO want them visible in Sentry as errors. CONFLICT is
 * dozens-per-day expected behavior, not an error.
 */
export type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: "CONFLICT"; actualSyncVersion: number };

async function checkUserPrefsWriteRateLimit(ctx: MutationCtx, userId: string): Promise<void> {
  const now = Date.now();
  const windowStart = Math.floor(now / USER_PREFS_WRITE_RATE_WINDOW_MS) * USER_PREFS_WRITE_RATE_WINDOW_MS;
  const reset = windowStart + USER_PREFS_WRITE_RATE_WINDOW_MS;
  const rows = await ctx.db
    .query("userPreferenceWriteRateLimits")
    .withIndex("by_user_window", (q) => q.eq("userId", userId))
    .collect();
  const currentRows = rows.filter((row) => row.windowStart === windowStart);
  const count = currentRows.reduce((sum, row) => sum + row.count, 0);

  if (count >= USER_PREFS_WRITE_RATE_LIMIT) {
    throw new ConvexError({
      kind: "RATE_LIMITED",
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset,
    });
  }

  let retainedId: (typeof rows)[number]["_id"] | null = null;

  if (currentRows.length > 0) {
    const current = currentRows[0]!;
    retainedId = current._id;
    await ctx.db.patch(current._id, {
      count: count + 1,
      updatedAt: now,
    });
  } else {
    const reusable = rows[0];
    if (reusable) {
      retainedId = reusable._id;
      await ctx.db.patch(reusable._id, {
        windowStart,
        count: 1,
        updatedAt: now,
      });
    } else {
      retainedId = await ctx.db.insert("userPreferenceWriteRateLimits", {
        userId,
        windowStart,
        count: 1,
        updatedAt: now,
      });
    }
  }

  for (const row of rows) {
    if (row._id !== retainedId) await ctx.db.delete(row._id);
  }
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
    // BLOB_TOO_LARGE and UNAUTHENTICATED throw as structured ConvexErrors —
    // they are rare error conditions we want surfaced in Sentry. Convex's
    // wire format propagates `errorData` for object payloads so the edge
    // handler routes via `err.data.kind`. (PR #3466 fixed the original
    // string-data wire-strip bug.)
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    await checkUserPrefsWriteRateLimit(ctx, userId);

    const blobSize = JSON.stringify(args.data).length;
    if (blobSize > MAX_PREFS_BLOB_SIZE) {
      throw new ConvexError({
        kind: "BLOB_TOO_LARGE",
        size: blobSize,
        max: MAX_PREFS_BLOB_SIZE,
      });
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
