import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { channelTypeValidator } from "./constants";

export const getChannelsByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("notificationChannels")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const setChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    channelType: channelTypeValidator,
    chatId: v.optional(v.string()),
    webhookEnvelope: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, channelType, chatId, webhookEnvelope, email } = args;
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", channelType),
      )
      .unique();
    const isNew = !existing;
    const now = Date.now();
    if (channelType === "telegram") {
      if (!chatId) throw new ConvexError("chatId required for telegram channel");
      const doc = { userId, channelType: "telegram" as const, chatId, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { await ctx.db.insert("notificationChannels", doc); }
    } else if (channelType === "slack") {
      if (!webhookEnvelope) throw new ConvexError("webhookEnvelope required for slack channel");
      const doc = { userId, channelType: "slack" as const, webhookEnvelope, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { await ctx.db.insert("notificationChannels", doc); }
    } else if (channelType === "email") {
      if (!email) throw new ConvexError("email required for email channel");
      const doc = { userId, channelType: "email" as const, email, verified: true, linkedAt: now };
      if (existing) { await ctx.db.replace(existing._id, doc); } else { await ctx.db.insert("notificationChannels", doc); }
    }
    return { isNew };
  },
});

export const setSlackOAuthChannelForUser = internalMutation({
  args: {
    userId: v.string(),
    webhookEnvelope: v.string(),
    slackChannelName: v.optional(v.string()),
    slackTeamName: v.optional(v.string()),
    slackConfigurationUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", "slack"),
      )
      .unique();
    const isNew = !existing;
    const doc = {
      userId: args.userId,
      channelType: "slack" as const,
      webhookEnvelope: args.webhookEnvelope,
      verified: true,
      linkedAt: Date.now(),
      slackChannelName: args.slackChannelName,
      slackTeamName: args.slackTeamName,
      slackConfigurationUrl: args.slackConfigurationUrl,
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("notificationChannels", doc);
    }
    return { isNew };
  },
});

export const deleteChannelForUser = internalMutation({
  args: { userId: v.string(), channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", args.channelType),
      )
      .unique();
    if (!existing) return;
    await ctx.db.delete(existing._id);
    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const rule of rules) {
      const filtered = rule.channels.filter((c) => c !== args.channelType);
      if (filtered.length !== rule.channels.length) {
        await ctx.db.patch(rule._id, { channels: filtered });
      }
    }
  },
});

export const createPairingTokenForUser = internalMutation({
  args: { userId: v.string(), variant: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, variant } = args;
    const existing = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of existing) {
      if (!t.used) await ctx.db.patch(t._id, { used: true });
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await ctx.db.insert("telegramPairingTokens", { userId, token, expiresAt, used: false, variant });
    return { token, expiresAt };
  },
});

export const getChannels = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query("notificationChannels")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();
  },
});

export const setChannel = mutation({
  args: {
    channelType: channelTypeValidator,
    chatId: v.optional(v.string()),
    webhookEnvelope: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    const now = Date.now();

    if (args.channelType === "telegram") {
      if (!args.chatId) throw new ConvexError("chatId required for telegram channel");
      const doc = { userId, channelType: "telegram" as const, chatId: args.chatId, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else if (args.channelType === "slack") {
      if (!args.webhookEnvelope) throw new ConvexError("webhookEnvelope required for slack channel");
      const doc = { userId, channelType: "slack" as const, webhookEnvelope: args.webhookEnvelope, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    } else if (args.channelType === "email") {
      if (!args.email) throw new ConvexError("email required for email channel");
      const doc = { userId, channelType: "email" as const, email: args.email, verified: true, linkedAt: now };
      if (existing) {
        await ctx.db.replace(existing._id, doc);
      } else {
        await ctx.db.insert("notificationChannels", doc);
      }
    }
  },
});

export const deleteChannel = mutation({
  args: { channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    if (!existing) return;
    await ctx.db.delete(existing._id);

    // Remove this channel from all alert rules for this user
    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const rule of rules) {
      const filtered = rule.channels.filter((c) => c !== args.channelType);
      if (filtered.length !== rule.channels.length) {
        await ctx.db.patch(rule._id, { channels: filtered });
      }
    }
  },
});

// Called by the notification relay via /relay/deactivate HTTP action
// when Telegram returns 403 or Slack returns 404/410.
export const deactivateChannelForUser = internalMutation({
  args: { userId: v.string(), channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", args.userId).eq("channelType", args.channelType),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { verified: false });
    }
  },
});

export const deactivateChannel = mutation({
  args: { channelType: channelTypeValidator },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", userId).eq("channelType", args.channelType),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { verified: false });
    }
  },
});

export const createPairingToken = mutation({
  args: { variant: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("UNAUTHENTICATED");
    const userId = identity.subject;

    // Invalidate any existing unused tokens for this user
    const existing = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of existing) {
      if (!t.used) await ctx.db.patch(t._id, { used: true });
    }

    // Generate a base64url token (43 chars from 32 random bytes)
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const expiresAt = Date.now() + 15 * 60 * 1000;

    await ctx.db.insert("telegramPairingTokens", {
      userId,
      token,
      expiresAt,
      used: false,
      variant: args.variant,
    });

    return { token, expiresAt };
  },
});

export const claimPairingToken = mutation({
  args: { token: v.string(), chatId: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("telegramPairingTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!record) return { ok: false, reason: "NOT_FOUND" as const };
    if (record.used) return { ok: false, reason: "ALREADY_USED" as const };
    if (record.expiresAt < Date.now()) return { ok: false, reason: "EXPIRED" as const };

    // Mark token used
    await ctx.db.patch(record._id, { used: true });

    // Upsert telegram channel for this user
    const existing = await ctx.db
      .query("notificationChannels")
      .withIndex("by_user_channel", (q) =>
        q.eq("userId", record.userId).eq("channelType", "telegram"),
      )
      .unique();

    const doc = {
      userId: record.userId,
      channelType: "telegram" as const,
      chatId: args.chatId,
      verified: true,
      linkedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert("notificationChannels", doc);
    }

    // On first-time pairing only, add 'telegram' to the alert rule so alerts
    // are delivered immediately without requiring a manual rule edit.
    // Skip on re-pair (existing channel) to preserve any intentional per-rule
    // customization the user may have made (e.g. removed Telegram from a variant).
    // If the token carries a variant, scope the update to that variant's rule only.
    // Fall back to all rules when variant is absent (backward compat for old tokens).
    if (!existing) {
      const rules = await (record.variant
        ? ctx.db
            .query("alertRules")
            .withIndex("by_user_variant", (q) =>
              q.eq("userId", record.userId).eq("variant", record.variant as string),
            )
            .collect()
        : ctx.db
            .query("alertRules")
            .withIndex("by_user", (q) => q.eq("userId", record.userId))
            .collect());
      for (const rule of rules) {
        if (!rule.channels.includes("telegram")) {
          await ctx.db.patch(rule._id, { channels: [...rule.channels, "telegram"] });
        }
      }
    }

    return { ok: true, reason: null };
  },
});
