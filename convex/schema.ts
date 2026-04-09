import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { channelTypeValidator, digestModeValidator, quietHoursOverrideValidator, sensitivityValidator } from "./constants";

// Subscription status enum — maps Dodo statuses to our internal set
const subscriptionStatus = v.union(
  v.literal("active"),
  v.literal("on_hold"),
  v.literal("cancelled"),
  v.literal("expired"),
);

// Payment event status enum — covers charge outcomes and dispute lifecycle
const paymentEventStatus = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("dispute_opened"),
  v.literal("dispute_won"),
  v.literal("dispute_lost"),
  v.literal("dispute_closed"),
);

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
    // Digest mode fields (absent = realtime, same as digestMode: "realtime")
    digestMode: v.optional(digestModeValidator),
    digestHour: v.optional(v.number()),       // 0-23 local hour for daily/twice_daily
    digestTimezone: v.optional(v.string()),   // IANA timezone, e.g. "America/New_York"
    aiDigestEnabled: v.optional(v.boolean()), // opt-in AI executive summary in digests (default true for new rules)
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

  // --- Payment tables (Dodo Payments integration) ---

  subscriptions: defineTable({
    userId: v.string(),
    dodoSubscriptionId: v.string(),
    dodoProductId: v.string(),
    planKey: v.string(),
    status: subscriptionStatus,
    currentPeriodStart: v.number(),
    currentPeriodEnd: v.number(),
    cancelledAt: v.optional(v.number()),
    rawPayload: v.any(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoSubscriptionId", ["dodoSubscriptionId"]),

  entitlements: defineTable({
    userId: v.string(),
    planKey: v.string(),
    features: v.object({
      tier: v.number(),
      maxDashboards: v.number(),
      apiAccess: v.boolean(),
      apiRateLimit: v.number(),
      prioritySupport: v.boolean(),
      exportFormats: v.array(v.string()),
    }),
    validUntil: v.number(),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  customers: defineTable({
    userId: v.string(),
    dodoCustomerId: v.optional(v.string()),
    email: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoCustomerId", ["dodoCustomerId"]),

  webhookEvents: defineTable({
    webhookId: v.string(),
    eventType: v.string(),
    rawPayload: v.any(),
    processedAt: v.number(),
    status: v.literal("processed"),
  })
    .index("by_webhookId", ["webhookId"])
    .index("by_eventType", ["eventType"]),

  paymentEvents: defineTable({
    userId: v.string(),
    dodoPaymentId: v.string(),
    type: v.union(v.literal("charge"), v.literal("refund")),
    amount: v.number(),
    currency: v.string(),
    status: paymentEventStatus,
    dodoSubscriptionId: v.optional(v.string()),
    rawPayload: v.any(),
    occurredAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoPaymentId", ["dodoPaymentId"]),

  productPlans: defineTable({
    dodoProductId: v.string(),
    planKey: v.string(),
    displayName: v.string(),
    isActive: v.boolean(),
  })
    .index("by_dodoProductId", ["dodoProductId"])
    .index("by_planKey", ["planKey"]),

  emailSuppressions: defineTable({
    normalizedEmail: v.string(),
    reason: v.union(v.literal("bounce"), v.literal("complaint"), v.literal("manual")),
    suppressedAt: v.number(),
    source: v.optional(v.string()),
  }).index("by_normalized_email", ["normalizedEmail"]),
});
