import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { CURRENT_PREFS_SCHEMA_VERSION, MAX_PREFS_BLOB_SIZE } from "./constants";

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

export const setPreferences = mutation({
  args: {
    variant: v.string(),
    data: v.any(),
    expectedSyncVersion: v.number(),
    schemaVersion: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    // Throw structured `ConvexError({ kind, ... })` instead of string-data —
    // Convex's wire format reliably propagates `errorData` for object payloads,
    // so the edge handler can route via `err.data.kind` to the correct HTTP
    // status. String-data ConvexErrors arrive at the edge as a generic
    // `Error("[Request ID: X] Server Error")` with `errorData` undefined,
    // which previously caused CONFLICT throws to be misclassified as 500
    // and trigger an unbounded retry loop on the client (PD investigation).
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

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
      // Include `actualSyncVersion` so the edge can echo it in the 409 body
      // and the client can refresh its local view in one round-trip instead
      // of re-fetching getPreferences.
      throw new ConvexError({
        kind: "CONFLICT",
        actualSyncVersion: existing.syncVersion,
      });
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

    return { syncVersion: nextSyncVersion };
  },
});
