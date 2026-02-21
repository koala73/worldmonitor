import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const register = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();

    const existing = await ctx.db
      .query("registrations")
      .withIndex("by_normalized_email", (q) => q.eq("normalizedEmail", normalizedEmail))
      .first();

    if (existing) {
      return { status: "already_registered" as const };
    }

    await ctx.db.insert("registrations", {
      email: args.email.trim(),
      normalizedEmail,
      registeredAt: Date.now(),
      source: args.source ?? "unknown",
      appVersion: args.appVersion ?? "unknown",
    });

    return { status: "registered" as const };
  },
});
