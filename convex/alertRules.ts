import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { channelTypeValidator, digestModeValidator, quietHoursOverrideValidator, sensitivityValidator } from "./constants";

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

export const setDigestSettings = mutation({
  args: {
    variant: v.string(),
    digestMode: digestModeValidator,
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    if (args.digestHour !== undefined && (args.digestHour < 0 || args.digestHour > 23 || !Number.isInteger(args.digestHour))) {
      throw new ConvexError("digestHour must be an integer 0–23");
    }
    if (args.digestTimezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: args.digestTimezone });
      } catch {
        throw new ConvexError("digestTimezone must be a valid IANA timezone (e.g. America/New_York)");
      }
    }

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const now = Date.now();
    const patch = {
      digestMode: args.digestMode,
      digestHour: args.digestHour,
      digestTimezone: args.digestTimezone,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        ...patch,
      });
    }
  },
});

export const getAlertRulesByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const setAlertRulesForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    enabled: v.boolean(),
    eventTypes: v.array(v.string()),
    sensitivity: sensitivityValidator,
    channels: v.array(channelTypeValidator),
  },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", rest.variant),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled: rest.enabled,
        eventTypes: rest.eventTypes,
        sensitivity: rest.sensitivity,
        channels: rest.channels,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("alertRules", { userId, ...rest, updatedAt: now });
    }
  },
});

const QUIET_HOURS_ARGS = {
  variant: v.string(),
  quietHoursEnabled: v.boolean(),
  quietHoursStart: v.optional(v.number()),
  quietHoursEnd: v.optional(v.number()),
  quietHoursTimezone: v.optional(v.string()),
  quietHoursOverride: v.optional(quietHoursOverrideValidator),
} as const;

function validateQuietHoursArgs(args: {
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
}) {
  if (args.quietHoursStart !== undefined && (args.quietHoursStart < 0 || args.quietHoursStart > 23 || !Number.isInteger(args.quietHoursStart))) {
    throw new ConvexError("quietHoursStart must be an integer 0–23");
  }
  if (args.quietHoursEnd !== undefined && (args.quietHoursEnd < 0 || args.quietHoursEnd > 23 || !Number.isInteger(args.quietHoursEnd))) {
    throw new ConvexError("quietHoursEnd must be an integer 0–23");
  }
  if (args.quietHoursTimezone !== undefined) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: args.quietHoursTimezone });
    } catch {
      throw new ConvexError("quietHoursTimezone must be a valid IANA timezone (e.g. America/New_York)");
    }
  }
}

export const setQuietHours = mutation({
  args: QUIET_HOURS_ARGS,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;
    validateQuietHoursArgs(args);

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .unique();

    const now = Date.now();
    const patch = {
      quietHoursEnabled: args.quietHoursEnabled,
      quietHoursStart: args.quietHoursStart,
      quietHoursEnd: args.quietHoursEnd,
      quietHoursTimezone: args.quietHoursTimezone,
      quietHoursOverride: args.quietHoursOverride,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId,
        variant: args.variant,
        enabled: true,
        eventTypes: [],
        sensitivity: "all",
        channels: [],
        ...patch,
      });
    }
  },
});

export const setDigestSettingsForUser = internalMutation({
  args: {
    userId: v.string(),
    variant: v.string(),
    digestMode: digestModeValidator,
    digestHour: v.optional(v.number()),
    digestTimezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, variant, ...digest } = args;
    if (digest.digestHour !== undefined && (digest.digestHour < 0 || digest.digestHour > 23 || !Number.isInteger(digest.digestHour))) {
      throw new ConvexError("digestHour must be an integer 0–23");
    }
    if (digest.digestTimezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: digest.digestTimezone });
      } catch {
        throw new ConvexError("digestTimezone must be a valid IANA timezone (e.g. America/New_York)");
      }
    }
    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", variant),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...digest, updatedAt: now });
    } else {
      await ctx.db.insert("alertRules", {
        userId, variant, enabled: true, eventTypes: [], sensitivity: "all", channels: [],
        ...digest, updatedAt: now,
      });
    }
  },
});

export const setQuietHoursForUser = internalMutation({
  args: { userId: v.string(), ...QUIET_HOURS_ARGS },
  handler: async (ctx, args) => {
    const { userId, ...rest } = args;
    validateQuietHoursArgs(rest);

    const existing = await ctx.db
      .query("alertRules")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", rest.variant),
      )
      .unique();

    const now = Date.now();
    const patch = {
      quietHoursEnabled: rest.quietHoursEnabled,
      quietHoursStart: rest.quietHoursStart,
      quietHoursEnd: rest.quietHoursEnd,
      quietHoursTimezone: rest.quietHoursTimezone,
      quietHoursOverride: rest.quietHoursOverride,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("alertRules", {
        userId, variant: rest.variant, enabled: true,
        eventTypes: [], sensitivity: "all", channels: [],
        ...patch,
      });
    }
  },
});

/** Returns all enabled rules that have a non-realtime digestMode set. */
export const getDigestRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const enabled = await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return enabled.filter(
      (r) => r.digestMode !== undefined && r.digestMode !== "realtime",
    );
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
