import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  channelTypeValidator,
  digestModeValidator,
  proActivationStepIdValidator,
  quietHoursOverrideValidator,
  sensitivityValidator,
} from "./constants";
import {
  companyMonitoringCompleteReceiptValidator,
  companyMonitoringCandidateStateValidator,
  companyMonitoringCandidateTerminalReasonValidator,
  companyMonitoringAdmissionAuthorityValidator,
  companyMonitoringAdmissionClassificationValidator,
  companyMonitoringAdmissionConfidenceFloorsValidator,
  companyMonitoringEvidenceAuthorityValidator,
  companyMonitoringEvidenceIndependenceValidator,
  companyMonitoringEvidenceProviderValidator,
  companyMonitoringEvidenceStateValidator,
  companyMonitoringNonReassuringReasonValidator,
  companyMonitoringNonReassuringReceiptValidator,
  companyMonitoringScanSourceValidator,
  companyMonitoringXAllowedUseValidator,
  companyMonitoringXAuthorityRoleValidator,
  companyMonitoringXContentStateValidator,
  companyMonitoringXDemotionReasonValidator,
  companyMonitoringXStorageStateValidator,
} from "./companyMonitoring/validators";

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

const companyMonitoringObligationIdentity = {
  obligationId: v.string(),
  ownerAccountId: v.string(),
  companyId: v.string(),
  source: companyMonitoringScanSourceValidator,
  queryVersion: v.string(),
  dueAt: v.number(),
  checkpoint: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

const companyMonitoringWorkIdentity = {
  workId: v.string(),
  workKey: v.string(),
  ownerAccountId: v.string(),
  cohortKey: v.string(),
  source: companyMonitoringScanSourceValidator,
  windowStart: v.number(),
  windowEnd: v.number(),
  queryVersion: v.string(),
  scheduledDueAt: v.number(),
  selectionDueAt: v.number(),
  resultCap: v.number(),
  attemptCount: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

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
  })
    .index("by_user_window", ["userId", "windowStart"])
    // Retention scan for `pruneStaleWriteRateLimits` (#6706). Expired-window
    // rows are garbage-collected off the write path, so the sweep needs a
    // cross-user range on age alone; without it the prune would be a full
    // table scan whose read set collides with every live counter.
    .index("by_windowStart", ["windowStart"]),

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
    // MCP paid-funnel upgrade attribution (#6716). Stamped from checkout
    // metadata.wm_attribution on first subscription.active only.
    attributionSource: v.optional(v.string()),
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
    // Request-path renewal verification (#4770). The state + attempt timestamp
    // form a durable lease/cooldown shared by every Convex action instance, so
    // concurrent premium requests cannot fan out into duplicate Dodo lookups.
    // Kept separate from the daily reconciler's backoff fields above so a cron
    // failure does not suppress the bounded customer-facing rescue attempt —
    // and vice versa: on-demand attempts advance/reset only the shared
    // consecutive-404 streak (reconcileNotFoundCount — provider evidence
    // counts from either path); the backoff pair (reconcileFailureCount /
    // lastReconcileAttemptAt) is cron-only, so request-path failures cannot
    // defer the nightly safety net (see markDodoReconcileAttempt `source`).
    renewalVerificationState: v.optional(v.union(
      v.literal("pending"),
      v.literal("failed"),
      v.literal("lapsed"),
    )),
    renewalVerificationAttemptAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_status_currentPeriodEnd", ["userId", "status", "currentPeriodEnd"])
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
    .index("by_status_currentPeriodEnd", ["status", "currentPeriodEnd"])
    // Cancellation-confirm retry (#7314, PR #7328): still-covering cancelled
    // rows can sit in by_status_currentPeriodEnd for a full annual period.
    // Keying this index on cancelledAt lets the daily scan range-read only
    // the three-day retry cohort instead of every paid-through cancellation.
    // Rows without cancelledAt are omitted (optional field) — the scan
    // already skips those as having no stable episode key.
    .index("by_status_cancelledAt", ["status", "cancelledAt"]),

  // What happened in a Pro-activation session, one row per subscription per
  // cohort (see `cohort` below).
  //
  // For the markerless retro cohort the row is ALSO a cross-device
  // single-presentation lease: a short pending claim closes concurrent mount
  // races without permanently suppressing onboarding when a browser crashes
  // before rendering the flow. The day-0 cohort has no lease — its fire-once
  // is the browser-local checkout marker — so its row is purely the outcome
  // record.
  //
  // The outcome buckets mirror ActivationStepOutcome
  // (pro-activation-state.ts). They are updated as the subscriber acts so a
  // tab close cannot erase engagement, then frozen when `exitedAt` is set.
  // `outcomeRevision` rejects late/out-of-order best-effort writes.
  proActivationPresentations: defineTable({
    userId: v.string(),
    subscriptionId: v.id("subscriptions"),
    // Which activation cohort this row records (#5621). ABSENT is the
    // markerless retro backfill — the only cohort that existed before, so
    // every pre-#5621 row reads correctly with no backfill, and the lease
    // lookups keep matching them by querying `cohort: undefined`.
    // "day0" is the post-checkout welcome session. The two are SEPARATE rows
    // for one subscription on purpose: day-0 carries no lease (its fire-once
    // is the browser-local checkout marker), so a day-0 row must never occupy
    // the retro claim slot or set the `presentedAt` gate that suppresses a
    // later legitimate backfill for a subscriber whose day-0 writes all
    // failed (#5600).
    cohort: v.optional(v.literal("day0")),
    claimNonce: v.string(),
    claimedAt: v.number(),
    // Day-0 only: client-generated session start used with claimNonce as a
    // total ownership order. Optional so rows written before the ordered
    // takeover contract deploy without a backfill.
    sessionStartedAt: v.optional(v.number()),
    presentedAt: v.optional(v.number()),
    // Set when a presentation is confirmed by an outcome-aware client. This
    // excludes rows created before #5582 without losing post-deploy sessions
    // that abandon the flow before their first progress snapshot.
    outcomeTrackingVersion: v.optional(v.literal(1)),
    confirmedSteps: v.optional(v.array(proActivationStepIdValidator)),
    skippedSteps: v.optional(v.array(proActivationStepIdValidator)),
    // Browser-refused steps (#5617). A separate bucket rather than a marker on
    // `skippedSteps` so rows written before it existed stay valid and every
    // existing consumer of the original three keeps its exact meaning.
    //
    // ROLLBACK: once any row has this field populated, deleting this line fails
    // the Convex deploy — schema validation rejects a stored field the
    // validator does not declare. To revert, revert the WRITE path (the client
    // and the mutation arg) and leave this field in place; drop it only after
    // the surviving rows have aged out.
    blockedSteps: v.optional(v.array(proActivationStepIdValidator)),
    failedSteps: v.optional(v.array(proActivationStepIdValidator)),
    outcomeRevision: v.optional(v.number()),
    outcomeUpdatedAt: v.optional(v.number()),
    exitedAt: v.optional(v.number()),
  })
    // Cohort is part of the key so each lookup names the row it means. A
    // prefix query on `subscriptionId` alone still reads BOTH cohorts (used
    // by subscription deletion); every lease/outcome lookup pins the second
    // component so it can never cross cohorts.
    .index("by_subscription_cohort", ["subscriptionId", "cohort"]),

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
      // Paid-through cancellation confirmation (#7314). Shares this ledger
      // with winback because both are keyed on the same cancellation episode
      // (`subscriptions.cancelledAt`) — distinct `step` values keep their
      // one-shot guarantees independent under `by_sub_step_episode`.
      v.literal("cancellation_confirm"),
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
        // Optional for entitlement rows written before the dashboard-AI
        // dimension existed; the read-time catalog merge supplies it.
        dashboardAiCallsPerDay: v.optional(v.union(v.number(), v.null())),
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
      // Optional — data-export entitlement (plan 2026-07-25-001). Legacy rows
      // predate it; consumers treat undefined on a tier >= 2 row as entitled
      // (fail-OPEN, permanently — see the PlanFeatures JSDoc). Catalog-sourced
      // writes always set it, so this validator MUST accept it.
      dataExport: v.optional(v.boolean()),
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
  // by client → `users:ensureRecord` (see convex/users.ts), and server-side at
  // checkout start by `users:recordTermsAcceptance` — which INSERTS when no row
  // exists, because a /pro buyer may never have run ensureRecord (pro-test has
  // no Convex client). Distinct from
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
    // Terms-of-service assent (#6976). Written at the two moments the user is
    // actually shown the documents: account creation, and checkout start (the
    // assent line sits immediately above every CTA). Both write the version
    // read from `shared/legal.ts` server-side, so no client can record a
    // version that was never in effect, and every recorded version resolves to
    // an archived snapshot under docs/legal/.
    //
    // OPTIONAL, and deliberately not backfilled: users who predate #6976 were
    // never shown an assent surface, and claiming otherwise would be worse than
    // an empty column. They fill in on their next checkout.
    termsAcceptedAt: v.optional(v.number()),
    termsVersion: v.optional(v.string()), // ISO date, e.g. "2026-08-20"
    // Set once, never overwritten (#6983). `termsAcceptedAt` moves to the
    // newest acceptance, so without this the date of the acceptance that
    // actually formed the agreement is destroyed by the first version bump —
    // and it cannot be reconstructed afterwards. The bump in #6983
    // (2026-07-27 → 2026-08-20) is the first one that would have done it.
    termsFirstAcceptedAt: v.optional(v.number()),
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

  // Durable dead-letter records for Dodo events that fail processing. Keep
  // this projection intentionally payload-free: operators need stable Dodo
  // identifiers and shape metadata to repair a subscription/payment, not a
  // second copy of customer data or webhook secrets.
  paymentWebhookFailures: defineTable({
    webhookId: v.string(),
    eventType: v.string(),
    dodoSubscriptionId: v.optional(v.string()),
    dodoPaymentId: v.optional(v.string()),
    dodoCustomerId: v.optional(v.string()),
    errorKind: v.string(),
    errorMessage: v.string(),
    dataKeys: v.array(v.string()),
    eventTimestamp: v.number(),
    receivedAt: v.number(),
    lastSeenAt: v.number(),
    attemptCount: v.number(),
    unresolved: v.boolean(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()),
    resolutionNote: v.optional(v.string()),
  })
    .index("by_webhookId", ["webhookId"])
    .index("by_unresolved_lastSeenAt", ["unresolved", "lastSeenAt"])
    .index("by_dodoSubscriptionId", ["dodoSubscriptionId"])
    .index("by_dodoPaymentId", ["dodoPaymentId"]),

  // Bounded aggregate used for the Sentry/ops signal. Keeping it separate
  // from the dead-letter rows avoids collecting an incident-sized table from
  // every retry just to report queue counts. The pre-seeded global document
  // also serializes failure-row inserts and lifecycle transitions; see
  // `payments/webhookMutations:_seedFailureSummary` and the Convex deploy
  // workflow. It must not be lazily created in the failure mutation because
  // an empty index range does not serialize concurrent first inserts.
  paymentWebhookFailureSummary: defineTable({
    key: v.literal("global"),
    unresolvedCount: v.number(),
    eventTypes: v.array(
      v.object({
        eventType: v.string(),
        count: v.number(),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Dodo events we received and authenticated but could not attribute to a
  // user: no signed checkout metadata and no `customers` row. The canonical
  // source is a Dodo *payment link* / dashboard-created subscription, which
  // carries `metadata: {}` because only our own checkout attaches the signed
  // `wm_user_id`.
  //
  // These are NOT `paymentWebhookFailures`. That table means "processing broke,
  // Dodo should retry"; retrying this never helps, because the identity lookup
  // is deterministic — all 8 attempts fail identically (2026-08-03). This table
  // means "received intact, needs a human to say who it belongs to", and the
  // webhook acknowledges 200 once the row is durably committed.
  unattributedPaymentEvents: defineTable({
    webhookId: v.string(),
    eventType: v.string(),
    // Did money actually move? Drives alert severity and whether we owe the
    // buyer fulfillment. An abandoned 3DS attempt is a sales signal; a settled
    // charge with nobody attached is a paid customer holding no access.
    charged: v.boolean(),
    dodoCustomerId: v.optional(v.string()),
    dodoPaymentId: v.optional(v.string()),
    dodoSubscriptionId: v.optional(v.string()),
    dodoProductId: v.optional(v.string()),
    // Contact details come straight from the Dodo payload — they are how an
    // operator finds the human to talk to, and the only identity signal we have.
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    rawPayload: v.any(),
    eventTimestamp: v.number(),
    receivedAt: v.number(),
    lastSeenAt: v.number(),
    occurrences: v.number(),
    notifiedAt: v.optional(v.number()),
    resolved: v.boolean(),
    resolvedUserId: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolutionNote: v.optional(v.string()),
  })
    .index("by_webhookId", ["webhookId"])
    .index("by_resolved_lastSeenAt", ["resolved", "lastSeenAt"])
    // Powers the per-customer notification throttle: a card-testing burst must
    // not turn into one admin email per attempt.
    .index("by_dodoCustomerId_lastSeenAt", ["dodoCustomerId", "lastSeenAt"])
    .index("by_dodoSubscriptionId", ["dodoSubscriptionId"]),

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

  // One row per checkout that exhausted the #6027 provider-429 retry ladder
  // and returned a terminal CHECKOUT_RATE_LIMITED to the buyer (#6698). This
  // is the rate signal the alarm in `payments/checkoutRateLimitAlarm.ts`
  // measures; the browser-side Sentry event is corroboration, not the source,
  // because it is ad-blockable and fires at level `info`.
  //
  // Deliberately payload-free and self-pruning: each insert deletes a bounded
  // batch of rows older than CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS, so a
  // storm drains over the inserts that follow it rather than accumulating for
  // the lifetime of the deployment. Rows left behind when 429s stop entirely
  // are inert — every count is window-relative, so a stale row can never
  // inflate a verdict.
  checkoutRateLimitEvents: defineTable({
    userId: v.string(),
    productId: v.string(),
    occurredAt: v.number(),
    // Stamped on the row whose insert crossed a threshold and emitted the ops
    // signal. This doubles as the alert cooldown clock, which is why the alarm
    // needs no pre-seeded singleton document — there is no state row whose
    // absence could silently disarm it.
    alertedAt: v.optional(v.number()),
  }).index("by_occurredAt", ["occurredAt"]),

  productPlans: defineTable({
    dodoProductId: v.string(),
    planKey: v.string(),
    displayName: v.string(),
    isActive: v.boolean(),
  })
    .index("by_dodoProductId", ["dodoProductId"])
    .index("by_planKey", ["planKey"]),

  // Company Monitoring's account root. Imports are replayed from company-row
  // idempotency fields, and purge progress lives on this root. Provider tables
  // below remain account-prefixed so destructive purge never scans globally.
  companyMonitoringAccounts: defineTable({
    logicalAccountId: v.string(),
    ownerUserId: v.optional(v.string()),
    ownerFenceHash: v.string(),
    lifecycle: v.union(
      v.literal("entitled"),
      v.literal("entitlement_lapsed"),
      v.literal("denied"),
    ),
    terminalReason: v.optional(v.union(v.literal("owner_deleted"), v.literal("account_deleted"))),
    entitlementDigest: v.optional(v.string()),
    lifecycleSequence: v.number(),
    companyCount: v.optional(v.number()),
    companyLimit: v.optional(v.number()),
    snapshotGeneration: v.optional(v.number()),
    purgeGeneration: v.number(),
    purgePhase: v.union(
      v.literal("none"),
      v.literal("pending"),
      v.literal("scan"),
      v.literal("companies"),
      v.literal("finalizing"),
      v.literal("complete"),
    ),
    destructivePurgeStarted: v.boolean(),
    pendingReactivation: v.boolean(),
    // Legacy accounts remain unstamped until every company page has had its
    // customer claim policy and current-name alias repaired. Provider rollout
    // gates fail closed on a missing or older version.
    claimPolicyVersion: v.optional(v.number()),
    // Durable orchestration cursors. Claims always begin from these indexed
    // account fields and read only a fixed page; work/company tables are never
    // scanned globally to discover due customer work.
    nextExaScanDueAt: v.optional(v.number()),
    nextXScanDueAt: v.optional(v.number()),
    purgeAfter: v.optional(v.number()),
    purgeCursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_logicalAccountId", ["logicalAccountId"])
    .index("by_ownerUserId", ["ownerUserId"])
    .index("by_ownerFenceHash", ["ownerFenceHash"])
    .index("by_purgePhase_updatedAt", ["purgePhase", "updatedAt"])
    // Consumer: accounts.reconcileAccountEntitlements. Entitlement writes no
    // longer push lapses (#6256), so the reconciler pulls them by scanning
    // entitled roots oldest-first.
    .index("by_lifecycle_updatedAt", ["lifecycle", "updatedAt"])
    .index("by_lifecycle_nextExaScanDueAt", ["lifecycle", "nextExaScanDueAt"])
    .index("by_lifecycle_nextXScanDueAt", ["lifecycle", "nextXScanDueAt"]),

  companyMonitoringCompanies: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    name: v.optional(v.string()),
    sortName: v.optional(v.string()),
    domicileCountry: v.optional(v.union(v.literal("US"), v.literal("GB"))),
    customerReference: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("paused"), v.literal("removed")),
    coverageState: v.optional(v.literal("awaiting_first_scan")),
    observationState: v.optional(v.literal("unknown")),
    // Any new deletion tombstone advances this version and makes downstream
    // derived state stale until the later recomputation slice consumes it.
    evidenceRevision: v.optional(v.number()),
    recomputeRequiredAt: v.optional(v.number()),
    snapshotGeneration: v.number(),
    directRequestId: v.optional(v.string()),
    directFingerprint: v.optional(v.string()),
    clientImportId: v.optional(v.string()),
    importOrdinal: v.optional(v.number()),
    importFingerprint: v.optional(v.string()),
    purgeGeneration: v.number(),
    purgePhase: v.union(
      v.literal("none"),
      v.literal("scan"),
      v.literal("evidence"),
      v.literal("candidates"),
      v.literal("payload"),
      v.literal("complete"),
    ),
    removedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_companyId", ["ownerAccountId", "companyId"])
    .index("by_account_lifecycle_sortName", ["ownerAccountId", "lifecycle", "sortName"])
    .index("by_account_customerReference_lifecycle", ["ownerAccountId", "customerReference", "lifecycle"])
    .index("by_account_directRequestId", ["ownerAccountId", "directRequestId"])
    .index("by_account_import_tuple", ["ownerAccountId", "clientImportId", "importOrdinal"]),

  companyMonitoringClaims: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    claimId: v.string(),
    type: v.union(
      v.literal("alias"),
      v.literal("domain"),
      v.literal("legal_identifier"),
      v.literal("x_account_id"),
      v.literal("x_handle"),
      v.literal("location"),
      v.literal("customer_reference"),
    ),
    value: v.string(),
    provenance: v.union(v.literal("customer"), v.literal("independent_provider")),
    trustState: v.union(
      v.literal("unverified"),
      v.literal("verified"),
      v.literal("expired"),
      v.literal("rejected"),
    ),
    allowedUses: v.optional(v.array(v.union(
      v.literal("discovery"),
      v.literal("attribution"),
      v.literal("primary_evidence"),
    ))),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"]),

  // One current official-X authority decision per company. The immutable
  // account ID is the binding key; handles are current display/routing data.
  // Claim IDs retain the exact independently verified domain evidence and
  // customer handle claim used for each decision.
  companyMonitoringXIdentities: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    domainClaimId: v.string(),
    xHandleClaimId: v.string(),
    officialDomain: v.string(),
    officialPageUrl: v.string(),
    accountId: v.string(),
    currentHandle: v.string(),
    profileName: v.string(),
    domicileCountry: v.union(v.literal("US"), v.literal("GB")),
    authorityRole: companyMonitoringXAuthorityRoleValidator,
    state: v.union(v.literal("authoritative"), v.literal("demoted")),
    demotionReason: v.optional(companyMonitoringXDemotionReasonValidator),
    badgeVerified: v.boolean(),
    allowedUses: v.array(companyMonitoringXAllowedUseValidator),
    evidenceHash: v.string(),
    checkedAt: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_account_accountId", ["ownerAccountId", "accountId"])
    .index("by_account_currentHandle", ["ownerAccountId", "currentHandle"]),

  // Compliance-aware recent posts. Deleted content remains as a tombstone;
  // protected/withheld content retains only permitted metadata.
  companyMonitoringXEvidence: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    postId: v.string(),
    authorAccountId: v.string(),
    currentHandle: v.string(),
    createdAt: v.number(),
    observedAt: v.number(),
    contentState: companyMonitoringXContentStateValidator,
    storageState: companyMonitoringXStorageStateValidator,
    text: v.optional(v.string()),
    editHistoryPostIds: v.array(v.string()),
    withheldCountryCodes: v.optional(v.array(v.string())),
    evidenceRevision: v.number(),
    lastReconciledAt: v.optional(v.number()),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_account_company_observedAt", ["ownerAccountId", "companyId", "observedAt"])
    .index("by_account_company_contentState_lastReconciledAt", [
      "ownerAccountId",
      "companyId",
      "contentState",
      "lastReconciledAt",
    ])
    .index("by_account_postId", ["ownerAccountId", "postId"])
    .index("by_account_company_postId", ["ownerAccountId", "companyId", "postId"]),

  // Every X edit-history ID resolves to one canonical evidence row. This
  // keeps later compliance events for any edit sibling from leaving another
  // version active after a deletion.
  companyMonitoringXPostAliases: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    postId: v.string(),
    canonicalPostId: v.string(),
    authorAccountId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_postId", ["ownerAccountId", "postId"])
    .index("by_account_company", ["ownerAccountId", "companyId"]),

  // Provider locators are copied into account + company rows. No unscoped
  // locator or fingerprint index exists, so identical provider results in two
  // portfolios remain separate customer evidence.
  companyMonitoringEvidence: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    evidenceId: v.string(),
    provider: companyMonitoringEvidenceProviderValidator,
    providerLocator: v.string(),
    queryVersion: v.optional(v.string()),
    providerLocatorHash: v.string(),
    providerOrigin: v.string(),
    providerOriginFingerprint: v.string(),
    contentFingerprint: v.string(),
    evidenceFingerprint: v.string(),
    occurrenceDedupeKey: v.string(),
    matchedClaimIds: v.array(v.string()),
    sourceAuthority: companyMonitoringEvidenceAuthorityValidator,
    independence: companyMonitoringEvidenceIndependenceValidator,
    state: companyMonitoringEvidenceStateValidator,
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
    author: v.optional(v.string()),
    authorAccountId: v.optional(v.string()),
    publishedAt: v.number(),
    observedAt: v.number(),
    expiresAt: v.optional(v.number()),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_account_company_locator", [
      "ownerAccountId",
      "companyId",
      "provider",
      "providerLocatorHash",
    ])
    .index("by_account_company_fingerprint", [
      "ownerAccountId",
      "companyId",
      "evidenceFingerprint",
    ])
    .index("by_account_company_occurrence", [
      "ownerAccountId",
      "companyId",
      "occurrenceDedupeKey",
    ])
    .index("by_account_company_occurrence_state", [
      "ownerAccountId",
      "companyId",
      "occurrenceDedupeKey",
      "state",
    ])
    .index("by_account_company_provider_state", [
      "ownerAccountId",
      "companyId",
      "provider",
      "state",
    ])
    .index("by_account_company_state_expiresAt", [
      "ownerAccountId",
      "companyId",
      "state",
      "expiresAt",
    ]),

  // One account/company occurrence is the classifier handoff. References are
  // bounded snapshots; referenceCount preserves the full active evidence size.
  companyMonitoringCandidates: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    candidateId: v.string(),
    occurrenceDedupeKey: v.string(),
    state: companyMonitoringCandidateStateValidator,
    firstDiscoveredAt: v.number(),
    firstDiscoveredPath: v.string(),
    attemptCount: v.number(),
    holdUntil: v.optional(v.number()),
    expiresAt: v.number(),
    observationBlocking: v.boolean(),
    referenceEvidenceFingerprints: v.array(v.string()),
    referenceCount: v.number(),
    referencesTruncated: v.boolean(),
    selectionPolicyVersion: v.string(),
    terminalReason: v.optional(companyMonitoringCandidateTerminalReasonValidator),
    evidenceRevision: v.number(),
    evidenceSnapshotDigest: v.optional(v.string()),
    lastAdmissionDecisionId: v.optional(v.id("companyMonitoringAdmissionDecisions")),
    classificationWorkerId: v.optional(v.string()),
    classificationLeaseToken: v.optional(v.string()),
    classificationLeaseExpiresAt: v.optional(v.number()),
    classificationRunId: v.optional(v.string()),
    classificationRequestedModelVersion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_account_company_occurrence", [
      "ownerAccountId",
      "companyId",
      "occurrenceDedupeKey",
    ])
    .index("by_account_state_updatedAt", ["ownerAccountId", "state", "updatedAt"])
    .index("by_state_updatedAt", ["state", "updatedAt"]),

  // Append-only outcome ledger. Model output is never stored directly: only
  // the strict normalized classification and deterministic policy result are
  // durable. The replay index fences one classification run to one evidence
  // revision while preserving every later retry as a separate row.
  companyMonitoringAdmissionDecisions: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    candidateId: v.string(),
    occurrenceDedupeKey: v.string(),
    evidenceRevision: v.number(),
    classificationRunId: v.string(),
    submissionDigest: v.string(),
    decision: v.union(
      v.literal("publish"),
      v.literal("hold"),
      v.literal("reject"),
      v.literal("expire"),
    ),
    reasonCodes: v.array(v.string()),
    referenceEvidenceFingerprints: v.array(v.string()),
    confidenceFloors: companyMonitoringAdmissionConfidenceFloorsValidator,
    classification: v.optional(companyMonitoringAdmissionClassificationValidator),
    overallConfidence: v.optional(v.number()),
    authority: v.optional(companyMonitoringAdmissionAuthorityValidator),
    queryVersions: v.array(v.string()),
    classificationSchemaVersion: v.string(),
    admissionPolicyVersion: v.string(),
    sourcePolicyVersion: v.string(),
    retryPolicyVersion: v.string(),
    evidenceSelectionPolicyVersion: v.string(),
    modelVersion: v.string(),
    requestedModelVersion: v.optional(v.string()),
    evidenceSnapshotDigest: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    terminalAt: v.number(),
    decidedAt: v.number(),
    previousDecisionId: v.optional(v.id("companyMonitoringAdmissionDecisions")),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_account_candidate", ["ownerAccountId", "candidateId", "decidedAt"])
    .index("by_replay_fence", [
      "ownerAccountId",
      "companyId",
      "occurrenceDedupeKey",
      "evidenceRevision",
      "classificationRunId",
    ]),

  // One durable company/source obligation. The closed state variants keep a
  // single uniqueness row while a work item's terminal receipt preserves the
  // history for every completed window. A failed/non-reassuring attempt never
  // changes `checkpoint`; a later window reuses that exact value.
  companyMonitoringScanObligations: defineTable(v.union(
    v.object({
      ...companyMonitoringObligationIdentity,
      state: v.literal("due"),
      workId: v.string(),
    }),
    v.object({
      ...companyMonitoringObligationIdentity,
      state: v.literal("leased"),
      workId: v.string(),
      leaseToken: v.string(),
      leaseExpiresAt: v.number(),
      workerId: v.string(),
    }),
    v.object({
      ...companyMonitoringObligationIdentity,
      state: v.literal("complete"),
      workId: v.string(),
      terminalReceiptId: v.string(),
      completedAt: v.number(),
    }),
    v.object({
      ...companyMonitoringObligationIdentity,
      state: v.literal("non_reassuring"),
      workId: v.string(),
      terminalReceiptId: v.string(),
      completedAt: v.number(),
      reason: companyMonitoringNonReassuringReasonValidator,
    }),
    v.object({
      ...companyMonitoringObligationIdentity,
      state: v.literal("cancelled"),
      workId: v.optional(v.string()),
      cancelledAt: v.number(),
      reason: v.union(
        v.literal("company_removed"),
        v.literal("account_inactive"),
        v.literal("superseded"),
      ),
    }),
  ))
    .index("by_account_company_source", ["ownerAccountId", "companyId", "source"])
    .index("by_workId", ["workId"]),

  // Durable cohort membership for terminal receipts. Live obligations move
  // to the next due work item, while these bounded links retain which
  // companies the immutable terminal work receipt covered. Company purge
  // removes its links page-by-page and deletes a receipt only after the final
  // cohort member link is gone.
  companyMonitoringScanReceiptLinks: defineTable({
    ownerAccountId: v.string(),
    companyId: v.string(),
    workId: v.string(),
    createdAt: v.number(),
  })
    .index("by_account_company", ["ownerAccountId", "companyId"])
    .index("by_workId", ["workId"])
    .index("by_workId_company", ["workId", "companyId"]),

  // Cohort/source/window work is the sole lease and terminal-receipt
  // authority. `selectionDueAt` is `scheduledDueAt` while due and the lease
  // expiry while leased, so crash replay remains an indexed bounded lookup.
  companyMonitoringScanWorkItems: defineTable(v.union(
    v.object({
      ...companyMonitoringWorkIdentity,
      state: v.literal("due"),
    }),
    v.object({
      ...companyMonitoringWorkIdentity,
      state: v.literal("leased"),
      leaseToken: v.string(),
      leaseExpiresAt: v.number(),
      workerId: v.string(),
    }),
    v.object({
      ...companyMonitoringWorkIdentity,
      state: v.literal("complete"),
      terminalLeaseToken: v.string(),
      terminalWorkerId: v.string(),
      terminalReceipt: companyMonitoringCompleteReceiptValidator,
    }),
    v.object({
      ...companyMonitoringWorkIdentity,
      state: v.literal("non_reassuring"),
      terminalLeaseToken: v.string(),
      terminalWorkerId: v.string(),
      terminalReceipt: companyMonitoringNonReassuringReceiptValidator,
    }),
    v.object({
      ...companyMonitoringWorkIdentity,
      state: v.literal("cancelled"),
      cancelledAt: v.number(),
      cancelReason: v.union(
        v.literal("company_removed"),
        v.literal("account_inactive"),
        v.literal("superseded"),
      ),
    }),
  ))
    .index("by_workId", ["workId"])
    .index("by_workKey", ["workKey"])
    .index("by_account_state_selectionDueAt", ["ownerAccountId", "state", "selectionDueAt"])
    .index("by_account_source_state_selectionDueAt", ["ownerAccountId", "source", "state", "selectionDueAt"]),

  userApiKeys: defineTable({
    userId: v.string(),
    name: v.string(),
    keyPrefix: v.string(),        // first 8 chars of plaintext key, for display
    keyHash: v.string(),          // SHA-256 hex digest — never store plaintext
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    scopes: v.optional(v.array(v.string())),
    companyMonitoringAccountId: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_revokedAt", ["userId", "revokedAt"])
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
  })
    .index("by_userId", ["userId"])
    .index("by_userId_revokedAt_createdAt", ["userId", "revokedAt", "createdAt"]),

  // API Business domain-gated Pro-seat invites (#4634/#4635). One row per seat
  // invite issued by an active `api_business` owner to a corporate-email
  // invitee. The grant is an explicit, revocable object keyed to the owner's
  // Business `dodoSubscriptionId` (KTD1) — NOT a fake subscription — so
  // `pickBestCoveringSub` stays clean. An `accepted` grant under a covering
  // Business sub resolves the invitee to Pro (U5); when the Business sub stops
  // covering, its grants flip to `revoked` and each invitee recomputes down (U6).
  // `inviteeEmail` and the owner `domain` are stored lowercased for stable comparisons
  // and reporting.
  businessProGrants: defineTable({
    businessSubscriptionId: v.string(),
    ownerUserId: v.string(),
    inviteeEmail: v.string(),
    domain: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    inviteeUserId: v.optional(v.string()),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_businessSubscriptionId", ["businessSubscriptionId"])
    .index("by_inviteeEmail", ["inviteeEmail"])
    .index("by_inviteeUserId", ["inviteeUserId"]),

  // Per-Business-subscription serialization document for the 4-seat cap.
  // EVERY mutation that mutates `businessProGrants` for a Business sub reads
  // AND writes this row, forcing Convex's per-document OCC to serialize
  // concurrent inviteSeats / removeSeat calls. Without this, two parallel
  // invites could both pass the cap check and insert a 5th grant.
  businessSeatLocks: defineTable({
    businessSubscriptionId: v.string(),
    lastTouchedAt: v.number(),
  }).index("by_businessSubscriptionId", ["businessSubscriptionId"]),

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

  // Pre-seeded, document-backed serialization point for `intelHistory.append`.
  //
  // Convex does not treat an empty `by_dedupeKey` index range as a conflict
  // dependency, so concurrent first-seen appends could both see no row and
  // insert the same key. `intelHistory.append` reads and patches this
  // always-existing singleton before checking dedupe keys, making the OCC
  // dependency document-backed. The historical seeders are low-frequency,
  // so one global serialization point is intentional and keeps the invariant
  // simple. It is seeded by the deploy workflow; append fails loudly if it is
  // absent rather than silently weakening idempotency.
  intelHistoryAppendLocks: defineTable({
    lockKey: v.string(),
    lastTouchedAt: v.number(),
  }).index("by_lockKey", ["lockKey"]),

  // Append-only historical intelligence memory (#5694). Seeders publish a
  // rolling live snapshot to Redis that overwrites itself every run; this
  // table is the durable long tail behind it — one row per distinct event,
  // never updated in place. `dedupeKey` is the seeder-side identity of an
  // event, so a re-publish of the same event is a skip, not a second row
  // (see `append` in convex/intelHistory.ts).
  //
  // EMBEDDING CONTRACT — `embedding` is produced by
  // openai/text-embedding-3-small at 512 dimensions: the SAME model and
  // dimension pair the brief deduper uses (EMBED_MODEL / EMBED_DIMS in
  // scripts/lib/brief-dedup-consts.mjs). The vector index below hard-codes
  // `dimensions: 512` and Convex rejects a stored vector of any other length,
  // so changing the model OR the dimension is a table migration (a new /
  // version-suffixed table plus a full re-embed) — NOT an in-place edit of
  // this number. Mixing vectors from two models in one index is worse than a
  // hard failure: the search still returns results, they are just ranked
  // against a similarity scale that no longer means anything. The deduper
  // carries the same warning on its CACHE_VERSION prefix.
  intelHistory: defineTable({
    // "conflict" | "military" | "energy" today. Deliberately v.string() and
    // not a v.union of literals: a new seeder domain should be a code change
    // in the collector, not a schema deploy that has to land first.
    domain: v.string(),
    resource: v.string(),
    country: v.optional(v.string()),
    category: v.optional(v.string()),
    title: v.string(),
    summary: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    // Event time as reported by the source, vs. the time we stored it. Both
    // are kept: reads are ordered by `occurredAt` (what a user means by "what
    // happened last week") while retention ages rows out by `ingestedAt` (so
    // a backfill of old events is not deleted by the next prune tick).
    occurredAt: v.number(),
    ingestedAt: v.number(),
    runId: v.string(),
    dedupeKey: v.string(),
    embedding: v.array(v.float64()),
  })
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_ingestedAt", ["ingestedAt"])
    .index("by_domain_occurredAt", ["domain", "occurredAt"])
    .index("by_country_occurredAt", ["country", "occurredAt"])
    // Convex's vector-index filter builder supports only `eq` and `or` — there
    // is no `and`. A query scoped to BOTH domain and country therefore pushes
    // one field down and post-filters the other; see `search` in
    // convex/intelHistory.ts for which one and why.
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 512,
      filterFields: ["domain", "country"],
    }),

  // Retraction tombstones for `intelHistory` (#5743).
  //
  // Deleting a poisoned or wrong history row is not enough on its own. The
  // producing seeders republish a rolling window every run, and `append`
  // decides "already stored?" by looking for a row with the same `dedupeKey` —
  // so a bare delete is undone by the next seed tick, usually within the hour.
  // A retraction therefore writes a tombstone keyed on the same `dedupeKey`
  // the delete removed, and `append` skips any record that matches one.
  //
  // Tombstones, not a soft-delete flag on `intelHistory`: the row must
  // genuinely leave the vector index (that is the whole point of a retraction,
  // and a filtered-out row still costs index space and can still be ranked),
  // while the identity has to survive it. They age out on the same 180-day
  // clock as the history itself — by `retractedAt`, so the window starts when
  // the operator acted rather than when the event happened.
  intelHistoryRetractions: defineTable({
    // Matches `intelHistory.dedupeKey` exactly. One row per retracted
    // identity; re-retracting the same key refreshes it rather than
    // accumulating duplicates.
    dedupeKey: v.string(),
    // When suppression was last ASSERTED — not when the operator first acted.
    // `retract` sets it, and every `append` this tombstone suppresses refreshes
    // it, because a record still arriving from the producer is evidence the
    // feed has not stopped serving it and expiry would be premature. Expiry is
    // therefore measured from the producer's last attempt, so `listRetractions`
    // orders by "most recently still-live" rather than by when someone typed
    // the command. The original action time lives in the `reason` an operator
    // is required to supply and in the `intel_history_retracted` breadcrumb.
    retractedAt: v.number(),
    // Free text from the operator, e.g. "poisoned RSS item, #5743". Required
    // at the relay boundary: a tombstone with no stated cause is unreviewable
    // six weeks later, when the only question that matters is whether it is
    // still deserved.
    reason: v.string(),
  })
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_retractedAt", ["retractedAt"]),
});
