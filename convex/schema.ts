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
      v.object({
        userId: v.string(),
        channelType: v.literal("webhook"),
        webhookEnvelope: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
        webhookLabel: v.optional(v.string()),
        webhookSecret: v.optional(v.string()),
      }),
      // Web Push (Phase 6). endpoint+p256dh+auth are the standard
      // PushSubscription identity triple — not secrets, just per-device
      // pairing material (they identify the browser's push endpoint at
      // Mozilla/Google/Apple). Stored plaintext to match the rest of
      // this table. userAgent is cosmetic: lets the settings UI show
      // "Chrome · MacOS" next to the Remove button so users can tell
      // which device a subscription belongs to.
      v.object({
        userId: v.string(),
        channelType: v.literal("web_push"),
        endpoint: v.string(),
        p256dh: v.string(),
        auth: v.string(),
        verified: v.boolean(),
        linkedAt: v.number(),
        userAgent: v.optional(v.string()),
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
    // Per-row stamp recording which PRO-launch broadcast wave a
    // registrant landed in (e.g. "canary-250", "wave-2", "wave-3").
    // Future wave-export actions filter on `proLaunchWave === undefined`
    // to pick only un-emailed registrants. Optional so existing rows
    // pass schema validation; the canary-250 backfill stamps the 244
    // contacts already emailed yesterday, future waves stamp themselves
    // at export time.
    proLaunchWave: v.optional(v.string()),
    proLaunchWaveAssignedAt: v.optional(v.number()),
  })
    .index("by_normalized_email", ["normalizedEmail"])
    .index("by_referral_code", ["referralCode"])
    // Index on the wave stamp so future picks can scan only-stamped
    // / only-unstamped efficiently without a full table scan against
    // tens of thousands of registrations.
    .index("by_proLaunchWave", ["proLaunchWave"]),

  // Singleton config for the cron-driven broadcast ramp runner. One
  // row, keyed by the literal string "current" so admin mutations
  // can target it without juggling Convex ids.
  //
  // The daily cron reads this row, checks the previous wave's
  // kill-gate metrics, and (if green) advances to the next tier in
  // `rampCurve`. Operator interventions (pause / resume / clear
  // kill-gate / abort) are admin mutations on this row.
  //
  // We DELIBERATELY don't auto-clear `killGateTripped` — once the
  // ramp halts itself, an operator must explicitly clear before the
  // next cron run resumes. Better one extra dashboard click than a
  // silent resumption after a real deliverability incident.
  broadcastRampConfig: defineTable({
    key: v.string(), // always "current"
    active: v.boolean(),
    // Wave sizes in order. e.g. [500, 1500, 5000, 15000, 25000].
    // Each cron tick advances `currentTier` by 1 and uses
    // `rampCurve[currentTier]` as the next wave's count.
    rampCurve: v.array(v.number()),
    // Index into rampCurve. -1 = not started; ramp ends when
    // currentTier === rampCurve.length - 1.
    currentTier: v.number(),
    // Naming prefix for waves; e.g. "wave" → "wave-2", "wave-3".
    // The number suffix is `currentTier + waveLabelOffset` so the
    // first auto-ramp wave can pick up where manual canary/wave-2
    // left off (default offset 3 means tier 0 → "wave-3").
    waveLabelPrefix: v.string(),
    waveLabelOffset: v.number(),
    // Kill thresholds. Defaults match metrics.ts: 4% bounce, 0.08%
    // complaint. Stored on the config so an operator can tighten
    // them without redeploying.
    bounceKillThreshold: v.number(),
    complaintKillThreshold: v.number(),
    // Kill-gate latch. Set to true by the cron when the prior
    // wave's stats trip a threshold. Cleared only by explicit
    // operator action.
    killGateTripped: v.boolean(),
    killGateReason: v.optional(v.string()),
    // Tracking the last successfully-sent wave so the next cron
    // tick can fetch its stats for the kill-gate check.
    lastWaveLabel: v.optional(v.string()),
    lastWaveBroadcastId: v.optional(v.string()),
    lastWaveSegmentId: v.optional(v.string()),
    lastWaveSentAt: v.optional(v.number()),
    lastWaveAssigned: v.optional(v.number()),
    // Status of the last cron run — distinct from the last wave.
    // `succeeded`        — wave sent cleanly
    // `kill-gate-tripped`— prior-wave check halted the ramp
    // `pool-drained`     — assignAndExportWave returned underfilled
    //                      with assigned < threshold
    // `partial-failure`  — wave action threw mid-flight; needs ops
    //                      intervention before next run
    // `awaiting-prior-stats` — prior wave hasn't accumulated enough
    //                      delivered events yet; cron will retry
    lastRunStatus: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    lastRunError: v.optional(v.string()),
    // Lease for the in-flight cron run. Set atomically by `_claimTierForRun`
    // BEFORE the runner makes any external side effects (assignAndExportWave,
    // createProLaunchBroadcast, sendProLaunchBroadcast). Cleared by
    // `_recordWaveSent` (success), `_recordRunOutcome` (failure for the
    // owning runId), `recoverFromPartialFailure` (operator), or
    // `forceReleaseLease` (operator, last-resort). Two overlapping cron runs
    // both attempting `_claimTierForRun` will see a lease already held and
    // exit before any duplicate emails go out. There is NO automatic
    // staleness override — long-running side effects (large waves) must not
    // be racable just because they exceed an arbitrary clock; recovery from
    // a genuinely-stuck lease is operator-only via `forceReleaseLease`.
    pendingRunId: v.optional(v.string()),
    pendingRunStartedAt: v.optional(v.number()),
    // Per-step progress markers persisted by the in-flight run AFTER each
    // external action succeeds. Lets `recoverFromPartialFailure` recover
    // without operator-supplied metadata when the action dies between steps
    // (e.g. Convex action timeout, OOM) before the catch can record
    // partial-failure. Cleared on successful `_recordWaveSent` and on
    // `recoverFromPartialFailure` completion.
    pendingWaveLabel: v.optional(v.string()),
    pendingSegmentId: v.optional(v.string()),
    pendingAssigned: v.optional(v.number()),
    pendingExportAt: v.optional(v.number()),
    pendingBroadcastId: v.optional(v.string()),
    pendingBroadcastAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // Phase 9 / Todo #223 — Clerk-user referral codes.
  // The `registrations.referralCode` column uses a 6-char hash of
  // the registering email; share-button codes are an 8-char HMAC
  // of the Clerk userId. Distinct spaces — this table resolves the
  // Clerk-code space back to a userId so the register mutation can
  // credit the right sharer when their code is used.
  userReferralCodes: defineTable({
    userId: v.string(),
    code: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_code", ["code"]),

  // Attribution rows written when a /pro?ref=<clerkCode> visitor
  // signs up for the waitlist. One row per (referrer, referee email)
  // pair. Kept separate from `registrations.referralCount` because
  // the referrer has no registrations row to increment.
  userReferralCredits: defineTable({
    referrerUserId: v.string(),
    refereeEmail: v.string(),
    createdAt: v.number(),
  })
    .index("by_referrer", ["referrerUserId"])
    .index("by_referrer_email", ["referrerUserId", "refereeEmail"]),

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
    // Optional complimentary-entitlement floor. When set and in the future,
    // subscription.expired events skip the normal downgrade-to-free so
    // goodwill credits outlive Dodo subscription cancellations.
    compUntil: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  customers: defineTable({
    userId: v.string(),
    dodoCustomerId: v.optional(v.string()),
    email: v.string(),
    // Lowercased + trimmed mirror of `email`. Required for O(1) joins from
    // `registrations`/`emailSuppressions` (both keyed on `normalizedEmail`)
    // when building broadcast audiences — without this, dedup is a full
    // table scan and paid users can leak into "buy PRO!" sends.
    // Optional so existing rows pass schema validation; backfilled via
    // `npx convex run payments/backfillCustomerNormalizedEmail:backfill`.
    normalizedEmail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoCustomerId", ["dodoCustomerId"])
    .index("by_normalized_email", ["normalizedEmail"]),

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

  userApiKeys: defineTable({
    userId: v.string(),
    name: v.string(),
    keyPrefix: v.string(),        // first 8 chars of plaintext key, for display
    keyHash: v.string(),          // SHA-256 hex digest — never store plaintext
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_keyHash", ["keyHash"]),

  emailSuppressions: defineTable({
    normalizedEmail: v.string(),
    reason: v.union(v.literal("bounce"), v.literal("complaint"), v.literal("manual")),
    suppressedAt: v.number(),
    source: v.optional(v.string()),
  }).index("by_normalized_email", ["normalizedEmail"]),

  // Per-event log of Resend webhook deliveries tagged with a broadcast_id.
  // Used as forensic detail to drive engineer-level inspection alongside
  // Resend's dashboard. Idempotent on `webhookEventId` — Resend retries
  // on 5xx and we MUST treat every delivery as at-most-once.
  //
  // No recipient email stored, AND no rawPayload stored — Resend's
  // `data` object includes `to: string[]` (recipient addresses), `from`,
  // `subject`, etc. that are PII or PII-adjacent. Convex dashboard rows
  // are observable to anyone with project access. We keep only the
  // identifying metadata; if a specific event needs deeper inspection,
  // look it up by `emailMessageId` in the Resend dashboard.
  broadcastEvents: defineTable({
    webhookEventId: v.string(),
    broadcastId: v.string(),
    emailMessageId: v.optional(v.string()),
    eventType: v.string(),
    occurredAt: v.number(),
  })
    .index("by_webhookEventId", ["webhookEventId"])
    .index("by_broadcast_event", ["broadcastId", "eventType"]),
});
