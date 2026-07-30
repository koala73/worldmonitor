import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const suppress = internalMutation({
  args: {
    email: v.string(),
    reason: v.union(v.literal("bounce"), v.literal("complaint"), v.literal("manual")),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();

    const existing = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (existing) return existing._id;

    return await ctx.db.insert("emailSuppressions", {
      normalizedEmail,
      reason: args.reason,
      suppressedAt: Date.now(),
      source: args.source,
    });
  },
});

export const isEmailSuppressed = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const entry = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();
    return !!entry;
  },
});

export const bulkSuppress = internalMutation({
  args: {
    emails: v.array(v.object({
      email: v.string(),
      reason: v.union(v.literal("bounce"), v.literal("complaint"), v.literal("manual")),
      source: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    let added = 0;
    let skipped = 0;
    for (const entry of args.emails) {
      const normalizedEmail = entry.email.trim().toLowerCase();
      const existing = await ctx.db
        .query("emailSuppressions")
        .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
        .first();

      if (existing) {
        skipped++;
        continue;
      }

      await ctx.db.insert("emailSuppressions", {
        normalizedEmail,
        reason: entry.reason,
        suppressedAt: Date.now(),
        source: entry.source,
      });
      added++;
    }
    return { added, skipped };
  },
});

export const remove = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    const entry = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (entry) {
      await ctx.db.delete(entry._id);
      return true;
    }
    return false;
  },
});
