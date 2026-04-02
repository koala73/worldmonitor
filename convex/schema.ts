import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { channelTypeValidator, quietHoursOverrideValidator, sensitivityValidator } from "./constants";

export default defineSchema({
  userPreferences: defineTable({
    userId: v.string(),
    variant: v.string(),
    data: v.any(),
    schemaVersion: v.number(),
    updatedAt: v.number(),
    syncVersion: v.number(),
  }).index("by_user_variant", ["userId", "variant"]),

  notificationChannels: defineTable(
    v.union(
      v.object({
        userId: v.string(),
        channelType: v.literal("telegram"),
        chatId: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
      }),
      v.object({
        userId: v.string(),
        channelType: v.literal("slack"),
        webhookEnvelope: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
        slackChannelName: v.optional(v.string()),
        slackTeamName: v.optional(v.string()),
        slackConfigurationUrl: v.optional(v.string()),
      }),
      v.object({
        userId: v.string(),
        channelType: v.literal("email"),
        email: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
      }),
      v.object({
        userId: v.string(),
        channelType: v.literal("discord"),
        webhookEnvelope: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
        discordGuildId: v.optional(v.string()),
        discordChannelId: v.optional(v.string()),
      }),
    ),
  )
    .index("by_user", ["userId"])
    .index("by_user_channel", ["userId", "channelType"]),

  alertRules: defineTable({
    userId: v.string(),
    variant: v.string(),
    enabled: v.boolean(),
    eventTypes: v.array(v.string()),
    sensitivity: sensitivityValidator,
    channels: v.array(channelTypeValidator),
    updatedAt: v.number(),
    quietHoursEnabled: v.optional(v.boolean()),
    quietHoursStart: v.optional(v.number()),
    quietHoursEnd: v.optional(v.number()),
    quietHoursTimezone: v.optional(v.string()),
    quietHoursOverride: v.optional(quietHoursOverrideValidator),
  })
    .index("by_user", ["userId"])
    .index("by_user_variant", ["userId", "variant"])
    .index("by_enabled", ["enabled"]),

  telegramPairingTokens: defineTable({
    userId: v.string(),
    token: v.string(),
    expiresAt: v.number(),
    used: v.boolean(),
    variant: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_user", ["userId"]),

  registrations: defineTable({
    email: v.string(),
    normalizedEmail: v.string(),
    registeredAt: v.number(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    referredBy: v.optional(v.string()),
    referralCount: v.optional(v.number()),
  })
    .index("by_normalized_email", ["normalizedEmail"])
    .index("by_referral_code", ["referralCode"]),
  contactMessages: defineTable({
    name: v.string(),
    email: v.string(),
    organization: v.optional(v.string()),
    phone: v.optional(v.string()),
    message: v.optional(v.string()),
    source: v.string(),
    receivedAt: v.number(),
  }),
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
});
