import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { channelTypeValidator, sensitivityValidator } from "./constants";

export const getAlertRules = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const setAlertRules = mutation({
  args: {
    variant: v.string(),
    enabled: v.boolean(),
    eventTypes: v.array(v.string()),
    sensitivity: sensitivityValidator,
    channels: v.array(channelTypeValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled: args.enabled,
        eventTypes: args.eventTypes,
        sensitivity: args.sensitivity,
        channels: args.channels,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: args.enabled,
        eventTypes: args.eventTypes,
        sensitivity: args.sensitivity,
        channels: args.channels,
        updatedAt: now,
      });
    }
  },
});

export const getByEnabled = query({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", args.enabled))
      .collect();
  },
});
