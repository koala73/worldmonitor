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

// Payment event status enum — covers charge outcomes and dispute lifecycle.
// `processing` / `requires_customer_action` are NON-terminal states (3DS/SCA
// in flight); persisting them gives the app a pending-payment signal for
// duplicate-prevention (#4438) and reconciliation (#4439). `cancelled` is a
// terminal-but-uncharged outcome. See convex/payments/webhookMutations.ts.
const paymentEventStatus = v.union(
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("processing"),
  v.literal("requires_customer_action"),
  v.literal("cancelled"),
  v.literal("dispute_opened"),
  v.literal("dispute_won"),
  v.literal("dispute_lost"),
  v.literal("dispute_closed"),
);

const apiPlanLimitDimension = v.union(
  v.literal("api_daily_requests"),
  v.literal("api_minute_burst"),
  v.literal("mcp_daily_calls"),
  v.literal("mcp_minute_burst"),
);

const apiPlanLimitNoticeState = v.union(
  v.literal("warning"),
  v.literal("over_limit"),
  v.literal("sustained_burst"),
);

const apiPlanLimitEmailStatus = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("skipped"),
  v.literal("suppressed"),
  v.literal("failed"),
);

const apiPlanLimitCtaKind = v.union(
  v.literal("checkout"),
  v.literal("billing_portal"),
  v.literal("contact_support"),
  v.literal("none"),
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

  userPreferenceWriteRateLimits: defineTable({
    userId: v.string(),
    windowStart: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_user_window", ["userId", "windowStart"]),

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
    // Optional country-scope (ISO-3166 alpha-2). Empty/absent → all countries (current behavior).
    countries: v.optional(v.array(v.string())),
    // Optional watchlist ticker-scope (#4922 U3, e.g. ["AAPL", "RELIANCE.NS"]).
    // Unlike `countries`, this is OPT-IN scoped: empty/absent → the rule
    // receives NO `watchlist_story_alert` events (the relay requires a
    // non-empty intersection with the story's tickers).
    tickers: v.optional(v.array(v.string())),
  })
    .index("by_user", ["userId"])
    .index("by_user_variant", ["userId", "variant"])
    .index("by_enabled", ["enabled"]),

  // ────────────────────────────────────────────────────────────────────────
  // Followed countries (watchlist primitive). See
  // docs/plans/2026-05-02-001-feat-followed-countries-watchlist-primitive-plan.md
  // (U12). One row per (userId, country) follow; uniqueness is enforced by
  // the `followCountry` mutation via the `by_user_country` index check, NOT
  // by Convex schema (Convex does not support unique constraints).
  //
  // `country` is a canonical ISO 3166-1 alpha-2 code (uppercase, e.g. "US",
  // "GB", "JP"). Validation against the canonical alpha-2 registry happens
  // at the mutation boundary (U13: `convex/lib/iso2.ts::isValidIso2`).
  followedCountries: defineTable({
    userId: v.string(),
    country: v.string(),
    addedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_country", ["country"])
    .index("by_user_country", ["userId", "country"]),

  // Aggregate-counter table for `countFollowers`. One row per country, kept
  // in lockstep with `followedCountries` row inserts/deletes by the
  // followCountry/unfollowCountry/mergeAnonymousLocal mutations (atomic
  // patch within the same Convex mutation transaction). Lets the public
  // `countFollowers` query be O(1) instead of O(n) per call. The privacy
  // floor (`COUNTRY_COUNT_PRIVACY_FLOOR`) is applied at read time in the
  // query, not at write time — the row stores the true count.
  followedCountriesCounts: defineTable({
    country: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_country", ["country"]),

  // Pre-seeded per-country lock table for aggregate counter writes.
  // The user shard lock only serializes mutations by user; first-ever
  // follows of the same country by different users need an existing
  // country-scoped document for Convex OCC to serialize the lazy
  // `followedCountriesCounts` row creation/update path. One row is seeded
  // for each valid ISO-2 code, and every counter +/- operation reads and
  // patches the row for that country in the same transaction.
  followedCountriesCountryLocks: defineTable({
    country: v.string(),
    lastTouchedAt: v.number(),
  }).index("by_country", ["country"]),

  // Per-user serialization document for the followed-countries watchlist.
  // EVERY mutation that mutates `followedCountries` for a user reads AND
  // writes this row, forcing Convex's per-document OCC to serialize
  // concurrent same-user mutations. Without this, two parallel
  // `followCountry` calls from the same user can both pass the cap check
  // (Convex OCC tracks reads at the document level, not at the index-range
  // level), both insert, and bypass the cap. The denormalized `count`
  // also lets the cap check be O(1) instead of O(n) — happy side effect.
  //
  // Invariant: `count` MUST equal the row count of `followedCountries`
  // for `userId`. The mutations are the only writers; tests assert this
  // parity after every operation. See plan U13 / Codex round-3 P0
  // (run 20260502-195816-dae403d7).
  //
  // KEY CAVEAT (Codex round-4 P0 v2): this row is created LAZILY on the
  // first mutation, so its OCC alone does NOT close a brand-new user's
  // race — two parallel first-ever mutations would both read empty and
  // both insert, producing duplicate meta rows. The fix is the pre-seeded
  // `followedCountriesShards` table below: every mutation reads + patches
  // the shard row at `userIdToShard(userId)` BEFORE this lazy-create can
  // happen, and Convex's OCC on the shard row serializes the two parallel
  // mutations so the second one observes the first's user-meta insert.
  followedCountriesUserMeta: defineTable({
    userId: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // Pre-seeded sharded lock table for the followed-countries watchlist
  // (Codex round-4 P0 v2). One row per shard id `0..SHARD_COUNT-1`.
  // Mapped to via `convex/lib/shards.ts::userIdToShard(userId)`, a
  // deterministic non-cryptographic hash. Every mutation that touches
  // `followedCountries` for a user reads the shard row at the top of the
  // handler AND patches `lastTouchedAt` at the end — that read+write pair
  // is what triggers Convex's per-document OCC to serialize concurrent
  // same-user mutations. Because rows are pre-seeded (never lazily
  // created), there is no TOCTOU window: the loser of an OCC race retries
  // against the post-winner state, sees the user-meta row the winner
  // inserted, and proceeds correctly.
  //
  // SHARD_COUNT is fixed at deploy time. Re-seeding requires draining
  // in-flight mutations; do not change without an operator runbook.
  // Seeding is idempotent — `_seedShards` skips existing rows. A daily
  // cron + manual operator mutation guarantee the table stays seeded.
  followedCountriesShards: defineTable({
    shardId: v.number(),
    lastTouchedAt: v.number(),
  }).index("by_shard", ["shardId"]),

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
    // Locale filter switch — when true, pickWaveAction excludes
    // contacts whose `users.localePrimary` (or email-TLD heuristic
    // fallback) is non-English. Optional + missing-reads-as-false on
    // the config — existing ramp rows that pre-date this feature
    // continue with byte-identical behavior. Operator opts in via
    // `initRamp({excludeNonEnglish: true})`.
    excludeNonEnglish: v.optional(v.boolean()),
  }).index("by_key", ["key"]),

  // ────────────────────────────────────────────────────────────────────────
  // Plan 2026-04-29 (post-launch-stabilization PR 2): wave-loading state
  // machine. Replaces the monolithic `assignAndExportWave` action — which
  // hits the Convex 10-min runtime budget at ~1500 contacts — with a
  // multi-step pipeline (pick → push-batch×N → finalize) that fits within
  // budget at any wave size.
  //
  // `waveRuns` is the per-run state row. `wavePickedContacts` is the
  // per-contact tri-state row that the push pipeline drains in batches.
  // Together they are the durable source of truth for an in-flight wave;
  // `broadcastRampConfig.lastWave*` is updated atomically by
  // `_finalizeWaveRun` only when the whole pipeline succeeds.
  //
  // See `convex/broadcast/waveRuns.ts` for the function-shape rules
  // (internalAction = external I/O, internalMutation = DB writes only)
  // and the lease/recovery semantics.
  // ────────────────────────────────────────────────────────────────────────
  waveRuns: defineTable({
    // Unique per pickWave call. Same string is set as
    // `broadcastRampConfig.pendingRunId` for lease coordination — the
    // existing rampRunner lease pattern. Cleared on `_finalizeWaveRun`
    // success or operator recovery (`discardWaveRun`).
    runId: v.string(),
    waveLabel: v.string(),
    segmentId: v.optional(v.string()),
    // Lifecycle:
    //   picking            → reservoir-sampling + creating segment + persisting picked rows
    //   segment-created    → ready for first pushBatchAction
    //   pushing            → at least one batch in flight; remaining `pending` rows
    //   broadcast-created  → all contacts pushed; broadcast object exists in Resend; send may have failed
    //   sent               → terminal success — broadcastRampConfig advanced atomically by _finalizeWaveRun
    //   failed             → terminal-by-failure; substatus carries reason and dictates which operator
    //                        recovery mutation applies (resumeStalledWaveRun, resumeFinalizeWaveRun,
    //                        markFinalizeRecovered, or discardWaveRun)
    status: v.union(
      v.literal("picking"),
      v.literal("segment-created"),
      v.literal("pushing"),
      v.literal("broadcast-created"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    // Operator-supplied count from `pickWaveAction` args. May exceed pool —
    // the actual picked count is in `totalCount`, with `underfilled=true`.
    requestedCount: v.number(),
    // = picked.length after reservoir sampling. Finalization gates on
    // "zero `pending` rows for this runId", NOT on pushedCount === totalCount —
    // failed contacts are tolerated up to the 5% threshold.
    totalCount: v.number(),
    underfilled: v.boolean(),
    pushedCount: v.number(),
    failedCount: v.number(),
    batchSize: v.number(),
    // Updated by every successful batch + by lease-revalidating recovery
    // mutations. Used (with createdAt/updatedAt fallback) by `runDailyRamp`'s
    // 15-min in-flight guard to distinguish "actively running" from "stalled
    // — needs operator intervention".
    lastBatchAt: v.optional(v.number()),
    broadcastId: v.optional(v.string()),
    // Discriminator for `failed` status. Drives operator recovery routing:
    //   'create-broadcast-failed'      → segment ready, no broadcast yet → resumeFinalizeWaveRun retries create
    //   'send-broadcast-failed'        → segment + broadcast ready, send failed → resumeFinalizeWaveRun({confirmedNotSent:true}) OR markFinalizeRecovered
    //   'discarded-by-operator'        → discardWaveRun ran; cleanup cron prunes the rows
    //   'batch-failure-rate-exceeded'  → push-side >5% failures → discardWaveRun (transient retry won't help)
    //   'empty-pool'                   → pickWave found zero unstamped registrations → terminal no-op
    //   'segment-create-failed'        → Resend createSegment failed → operator inspects + discards
    //   'persist-failed'               → mid-loop _persistPickedBatch failed → operator inspects + discards
    failureSubstatus: v.optional(v.string()),
    error: v.optional(v.string()),
    // Pool-filter audit fields (added 2026-05-10 alongside `users` table +
    // `excludeNonEnglish` flag). Populated by pickWaveAction's pool selection
    // step so any past wave's filter behavior is auditable from the
    // `waveRuns` row alone — no log archaeology required. Optional so
    // pre-existing rows pass schema validation.
    excludeNonEnglish: v.optional(v.boolean()),
    eligiblePoolCount: v.optional(v.number()),
    excludedCount: v.optional(v.number()),
    excludedLocaleCounts: v.optional(v.record(v.string(), v.number())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_runId", ["runId"])
    .index("by_status", ["status"]),

  // Per-contact tri-state row written by `_persistPickedBatch` during pick
  // and patched atomically by `_markContactPushed` / `_markContactFailed`
  // during push. The CAS guard on those mutations (no-op unless
  // status==='pending') makes them idempotent under overlapping
  // pushBatchAction invocations or operator-resume-while-original-still-running.
  //
  // Rows are NOT deleted synchronously on `discardWaveRun` — the daily
  // `cleanupDiscardedWavePickedContactsAction` cron prunes them in 500-row
  // batches to avoid hitting Convex's per-mutation write limits on bulk
  // deletion of up to 25k rows.
  wavePickedContacts: defineTable({
    runId: v.string(),
    normalizedEmail: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("pushed"),
      v.literal("failed"),
    ),
    pushedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    failedReason: v.optional(v.string()),
  })
    .index("by_runId", ["runId"])
    .index("by_runId_status", ["runId", "status"]),

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
    normalizedEmail: v.optional(v.string()),
  }).index("by_normalized_email_received", ["normalizedEmail", "receivedAt"]),

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
    // Stable first-class projection of `rawPayload.customer.customer_id`
    // (the Dodo customer this sub was paid as). Optional because
    // `DodoSubscriptionData.customer` is itself optional and lifecycle
    // event payloads (`subscription.renewed`, `.on_hold`, `.cancelled`,
    // `.plan_changed`, `.expired`) sometimes arrive without it — a
    // blind `rawPayload: data` patch would otherwise wipe the value.
    // Webhook handlers write this field with `data.customer?.customer_id
    // ?? existing.dodoCustomerId` (see `mergeDodoCustomerId` in
    // `subscriptionHelpers.ts`) so it survives lifecycle patches.
    //
    // Manage Billing prefers this column when populated — see
    // `payments/billing:getDodoCustomerIdForUserPortal`, which is a
    // 3-tier resolver (this column → `rawPayload.customer.customer_id`
    // → `customers.dodoCustomerId` for the same userId). Pre-PR rows
    // may still rely on tiers 2-3 until
    // `backfillSubscriptionDodoCustomerId` lands their values here.
    dodoCustomerId: v.optional(v.string()),
    // Epoch ms of the event that opened the CURRENT on_hold episode.
    // Set by handleSubscriptionOnHold only on the active→on_hold
    // transition (webhook replays while already on_hold keep the
    // original anchor), and used as the dunning episode key (#4932):
    // day-3/day-7 reminders compute their age from it, and the
    // dunningEmails ledger scopes idempotency to it so a NEW payment
    // failure months later starts a fresh email sequence. Optional —
    // rows that entered on_hold before this field existed fall back
    // to `updatedAt` in the dunning scan.
    onHoldAt: v.optional(v.number()),
    rawPayload: v.any(),
    updatedAt: v.number(),
    // Renewal-reconciliation bookkeeping (see
    // `payments/billing:reconcileMissedDodoRenewals`). Orthogonal to
    // `updatedAt` — these are NEVER bumped on a webhook state change, only
    // when the reconciliation cron attempts (and fails/skips) a row. Used to
    // back off permanently-failing rows (e.g. test-mode-era subs that 404
    // against the live Dodo client) so they stop starving the batch's scan
    // slots. Cleared on a successful reconcile AND on a webhook that renews the
    // sub (so a new stale episode starts from a clean slate).
    lastReconcileAttemptAt: v.optional(v.number()),
    reconcileFailureCount: v.optional(v.number()),
    // Count of CONSECUTIVE definitive Dodo 404s (reset by any non-404 reconcile
    // outcome). Distinct from `reconcileFailureCount` (which counts all failure
    // kinds for backoff) so the terminal "subscription deleted in Dodo"
    // downgrade requires repeated 404s specifically, not just any prior failure.
    reconcileNotFoundCount: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoSubscriptionId", ["dodoSubscriptionId"])
    .index("by_dodoCustomerId", ["dodoCustomerId"])
    // Dunning scan (#4932): on_hold is a small TRANSIENT set (tens of rows),
    // safe to collect() daily.
    .index("by_status", ["status"])
    // Winback scan (#4932): cancelled is an ACCUMULATING terminal status —
    // it grows with lifetime churn, so a bare by_status collect() would
    // eventually hit Convex's per-transaction read cap and kill the whole
    // daily scan (PR #4935 review finding 2). This compound index lets the
    // scan range-read only a bounded window. Keyed on currentPeriodEnd
    // (ACCESS end), not cancelledAt: an annual subscriber who cancels
    // months before expiry would otherwise be paid-through during the
    // post-cancel window and outside it once access actually ends — never
    // winback-eligible (review round 2, finding 3). The winback email says
    // "your access ended ~a month ago", so access end is the right clock.
    .index("by_status_currentPeriodEnd", ["status", "currentPeriodEnd"]),

  // Dunning/winback send ledger (#4932): one row per email step actually
  // delivered for a given subscription episode. `episodeAt` is the on_hold
  // anchor (dunning steps) or `cancelledAt` (winback), so a later, separate
  // payment-failure episode legitimately re-sends the sequence while webhook
  // replays and overlapping cron ticks stay idempotent. Growth is bounded by
  // real billing events (≤4 rows per episode), so no prune cron is needed.
  dunningEmails: defineTable({
    dodoSubscriptionId: v.string(),
    step: v.union(
      v.literal("dunning_day0"),
      v.literal("dunning_day3"),
      v.literal("dunning_day7"),
      v.literal("winback_day30"),
    ),
    episodeAt: v.number(),
    email: v.string(),
    sentAt: v.number(),
  }).index("by_sub_step_episode", ["dodoSubscriptionId", "step", "episodeAt"]),

  entitlements: defineTable({
    userId: v.string(),
    planKey: v.string(),
    features: v.object({
      tier: v.number(),
      maxDashboards: v.number(),
      apiAccess: v.boolean(),
      apiRateLimit: v.number(),
      planLimits: v.optional(v.object({
        apiRequestsPerDay: v.union(v.number(), v.null()),
        apiBurstRequestsPerMinute: v.union(v.number(), v.null()),
        mcpCallsPerDay: v.union(v.number(), v.null()),
        mcpBurstRequestsPerMinute: v.union(v.number(), v.null()),
      })),
      prioritySupport: v.boolean(),
      exportFormats: v.array(v.string()),
      // Optional for backward-compat with existing rows written before
      // plan 2026-05-10-001 (Pro MCP). Dodo webhooks repopulate this on
      // the next subscription event; legacy rows return undefined and
      // every consumer treats undefined as "no MCP access" (fail-closed).
      mcpAccess: v.optional(v.boolean()),
      // Optional — per-account daily REST allowance (#3199). Legacy rows
      // predate it; the rate-limit consumer treats undefined as "no daily
      // limit" (fail-OPEN). Catalog-sourced writes always set it, so this
      // validator MUST accept it or the webhook's entitlement write is
      // rejected (v.object is strict on extra keys).
      apiDailyAllowance: v.optional(v.number()),
    }),
    validUntil: v.number(),
    // Optional complimentary-entitlement floor. When set and in the future,
    // subscription.expired events skip the normal downgrade-to-free so
    // goodwill credits outlive Dodo subscription cancellations.
    compUntil: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_validUntil", ["validUntil"]),

  apiUsageRollups: defineTable({
    userId: v.string(),
    planKey: v.string(),
    dimension: apiPlanLimitDimension,
    windowKey: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    limit: v.union(v.number(), v.null()),
    usage: v.number(),
    usageRatio: v.union(v.number(), v.null()),
    source: v.string(),
    sourceFreshAt: v.number(),
    computedAt: v.number(),
  })
    .index("by_user_window", ["userId", "windowKey"])
    .index("by_window_dimension", ["windowKey", "dimension"])
    // Age-ordered for the retention prune cron (burst mints one rollup per
    // user per hourly scan, so this table grows without bound otherwise).
    .index("by_computedAt", ["computedAt"]),

  apiPlanLimitNotices: defineTable({
    userId: v.string(),
    planKey: v.string(),
    dimension: apiPlanLimitDimension,
    state: apiPlanLimitNoticeState,
    windowKey: v.string(),
    usage: v.number(),
    limit: v.union(v.number(), v.null()),
    usageRatio: v.union(v.number(), v.null()),
    current: v.boolean(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    lastEmailedAt: v.optional(v.number()),
    acknowledgedAt: v.optional(v.number()),
    emailStatus: apiPlanLimitEmailStatus,
    // Number of delivery attempts that ended in `failed`. Bounds retries so a
    // permanently undeliverable recipient stops being re-sent on every scan.
    emailAttempts: v.optional(v.number()),
    upgradeTargetPlanKey: v.optional(v.string()),
    ctaKind: apiPlanLimitCtaKind,
    blockedReason: v.optional(v.string()),
  })
    .index("by_notice_dedupe", ["userId", "planKey", "dimension", "state", "windowKey"])
    // `current` first so listEmailDue can exclude superseded rows in the index
    // (not a post-take filter) -- a dead-pending backlog can't starve live due notices.
    .index("by_email_due", ["current", "emailStatus", "lastSeenAt"])
    // Only-`current` scans (readiness gate + stale-notice recovery sweep) query
    // through this index instead of collecting the whole (ever-growing) table.
    .index("by_current", ["current", "lastSeenAt"])
    // Per-user live-notice lookups (supersede loop, recovery clear, Settings
    // list) query this instead of scanning all per-(user,state) history and
    // filtering `current` in memory -- bounds the hot path to live rows.
    .index("by_user_dimension_current", ["userId", "dimension", "current"]),

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

  // Canonical per-Clerk-user record. Populated on first authenticated session
  // by client → `users:ensureRecord` (see convex/users.ts). Distinct from
  // `customers` (which is paid-only, populated by Dodo subscription webhook):
  // `users` covers EVERY Clerk-authenticated user, free or paid. Holds
  // operational properties used for product personalization and broadcast
  // audience filtering — locale, timezone, country, first/last seen.
  //
  // ⚠️ Authority of `country`: client-reported (derived from a `cf-ipcountry`
  // cookie or similar). NOT authoritative. Do NOT use for compliance, geo-
  // gating, or anything where a malicious client could spoof a different
  // country to gain or evade something. Server-side derivation (Vercel edge
  // wrapper reading `cf-ipcountry` from the actual request headers) is a
  // future v2 concern; v1 just stores what the client passes for analytics
  // use only.
  users: defineTable({
    userId: v.string(), // Clerk userId; primary identifier
    email: v.optional(v.string()), // Server-derived from ctx.auth.getUserIdentity()
    normalizedEmail: v.optional(v.string()), // Lowercased mirror of email; joined against registrations
    localeTag: v.optional(v.string()), // Full BCP 47 tag (e.g. "zh-CN", "en-US"); kept for future analytics
    localePrimary: v.optional(v.string()), // Lowercased primary subtag (e.g. "zh", "en"); broadcast filter target
    timezone: v.optional(v.string()), // IANA zone (e.g. "Asia/Shanghai")
    country: v.optional(v.string()), // ISO 3166-1 alpha-2; CLIENT-REPORTED — see warning above
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_normalizedEmail", ["normalizedEmail"])
    .index("by_localePrimary", ["localePrimary"]),

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
    // Plan key (e.g. "pro_monthly") threaded through the checkout-session
    // metadata bridge (metadata.wm_plan_key) so a pending 3DS payment row can be
    // resolved to its PRODUCT_CATALOG tierGroup for the duplicate-payment guard
    // (#4438). Optional: legacy rows and sessions created before the bridge
    // shipped simply have none (the guard fails open for those — see #4438 plan).
    planKey: v.optional(v.string()),
    rawPayload: v.any(),
    occurredAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_dodoPaymentId", ["dodoPaymentId"])
    .index("by_occurredAt", ["occurredAt"])
    // Time-bounded read for the duplicate-payment guard (#4438): it only needs
    // recent rows (within the staleness window), so it queries this index with a
    // range on occurredAt instead of collecting the user's whole (unbounded,
    // rawPayload-carrying) payment history — keeps the guard fail-open.
    .index("by_userId_occurredAt", ["userId", "occurredAt"]),

  paymentReconciliationAttempts: defineTable({
    dodoPaymentId: v.string(),
    userId: v.string(),
    planKey: v.optional(v.string()),
    action: v.union(
      v.literal("terminal_reconciled"),
      v.literal("customer_notified"),
      v.literal("ops_notified"),
    ),
    observedStatus: v.string(),
    pendingOccurredAt: v.number(),
    reconciledAt: v.number(),
  })
    .index("by_dodoPaymentId", ["dodoPaymentId"])
    .index("by_reconciledAt", ["reconciledAt"]),

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

  // Non-key Pro MCP identity rows. One row per OAuth grant for a Pro user.
  // Referenced from OAuth code/token records as `mcpTokenId` — never carries
  // plaintext or `wm_` keys. Revoke deletes the row's revokedAt → next
  // bearer-resolution at api/mcp.ts returns 401 (no token-index sweep needed).
  // See plan: docs/plans/2026-05-10-001-feat-pro-mcp-clerk-auth-quota-plan.md
  mcpProTokens: defineTable({
    userId: v.string(),
    clientId: v.optional(v.string()),
    name: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

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
