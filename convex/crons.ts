import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "cleanup-expired-pairing-tokens",
  { minuteUTC: 27 },
  internal.telegramPairingTokens.cleanupExpired,
);

crons.hourly(
  "api-plan-limit-usage-scan",
  { minuteUTC: 17 },
  internal.apiPlanLimitUsage.scanApiPlanLimitUsageInternal,
  {},
);

crons.hourly(
  "api-plan-limit-email-delivery",
  { minuteUTC: 18 },
  internal.apiPlanLimitEmails.sendDuePlanLimitEmails,
  {},
);

// Bounded recovery for Company Monitoring purge generations whose scheduled
// continuation was dropped. The mutation independently enforces the ordinary
// lapse purgeAfter deadline, so an hourly wake cannot bypass the 24h grace.
crons.hourly(
  "company-monitoring-stalled-purge-reaper",
  { minuteUTC: 37 },
  internal.companyMonitoring.accounts.reapStalledAccountPurges,
  {},
);

// Company Monitoring account roots are provisioned on first use and are no
// longer touched by entitlement writes (#6256), so lapses are pulled here
// instead of pushed from billing. Scanning only companyMonitoringAccounts means
// this costs nothing for the subscribers who never use the feature. The 24h
// purgeAfter grace still applies downstream, so detection latency of one tick
// is absorbed by a window that already exists.
crons.hourly(
  "company-monitoring-entitlement-reconciler",
  { minuteUTC: 47 },
  internal.companyMonitoring.accounts.reconcileAccountEntitlements,
  {},
);

// Retention sweep for the preference-write rate limiter (#6706). The limiter
// used to drop expired-window rows inline on every write, which widened that
// mutation's OCC read set from one counter row to the caller's entire row set
// and livelocked users writing from two tabs. Collecting them here keeps the
// write path's read set at exactly the current window. Hourly, not daily: a
// user writing continuously produces one row per 60s window, so an hourly tick
// bounds the table at ~60 rows per active user instead of ~1440.
crons.hourly(
  "user-prefs-rate-limit-prune",
  { minuteUTC: 52 },
  internal.userPreferences.pruneStaleWriteRateLimits,
  {},
);

// PRO-launch broadcast ramp runner. Wakes once a day at 13:00 UTC
// (~9am ET / 6am PT / 3pm CET — early enough that any kill-gate
// trip can be triaged within US business hours, late enough that
// overnight bounces and complaints have flowed back via the Resend
// webhook). The action no-ops when no ramp is configured, the ramp
// is paused, kill-gated, or the prior wave hasn't settled yet —
// see `convex/broadcast/rampRunner.ts` for the full state machine.
// Daily retention prune for the plan-limit tables. apiUsageRollups gains a row
// per user per hourly scan and apiPlanLimitNotices accumulates superseded rows,
// neither with a native TTL — this ages both out past a 90-day window in
// bounded per-run batches. See `pruneApiPlanLimitData` in apiPlanLimitNotices.ts.
crons.daily(
  "api-plan-limit-prune",
  { hourUTC: 4, minuteUTC: 45 },
  internal.apiPlanLimitNotices.pruneApiPlanLimitData,
  {},
);

// Daily retention prune for the append-only historical intelligence store
// (#5694). The table has no natural ceiling — every seeder run appends the
// events it published — and each row carries a 512-float vector, so the
// vector index is the real cost being bounded here. Ages rows past
// INTEL_HISTORY_RETENTION_DAYS out by `ingestedAt` in bounded per-run
// batches that self-drain. Also drains expired retraction tombstones
// (#5743) in the same pass, by `retractedAt` — a handful of hand-created
// rows do not justify a second scheduled function. See `prune` in
// convex/intelHistory.ts. 04:30 UTC sits between the plan-limit prune
// (04:45) and the wave-runs cleanup (04:00) so the three delete-heavy jobs
// never overlap.
crons.daily(
  "intel-history-prune",
  { hourUTC: 4, minuteUTC: 30 },
  internal.intelHistory.prune,
  {},
);

crons.daily(
  "broadcast-ramp-runner",
  { hourUTC: 13, minuteUTC: 0 },
  internal.broadcast.rampRunner.runDailyRamp,
);

// Daily prune of `wavePickedContacts` rows belonging to discarded/failed
// wave runs older than 24h. Each invocation deletes one chunk (500 rows)
// and self-schedules until a run's rows are drained, then moves on. Avoids
// hitting Convex's per-mutation write limit on bulk deletion of up to 25k
// rows in one shot. See `convex/broadcast/waveRuns.ts`
// (`cleanupDiscardedWavePickedContactsAction`).
crons.daily(
  "wave-runs-cleanup",
  { hourUTC: 4, minuteUTC: 0 },
  internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
  {},
);

// Every 6h, not daily: a payment becomes a reconciliation candidate at ~6h
// pending, so on a daily cadence its age at first scan is uniformly 6h-30h and
// anything landing in (24h, 30h] misses the 24h customer-email freshness gate
// (STUCK_PAYMENT_CUSTOMER_EMAIL_MAX_AGE_MS) — ~25% of ordinary stuck payments
// silently dropped to ops-only. At 6h cadence first-scan age stays <=~12h, so
// every stuck payment gets its recovery email. Safe to run 4x/day: the action
// is fully idempotent and marker-gated (already-handled payments are skipped).
crons.interval(
  "payments-stuck-pending-reconciliation",
  { hours: 6 },
  internal.payments.billing.reconcileStuckPendingPayments,
  {},
);

// Idempotent daily seed of the `followedCountriesShards` lock table
// (Codex round-4 P0 v2). Skips existing shards; inserts any missing
// shard ids in `[0, SHARD_COUNT)`. Defends against a deploy-time seed
// step being skipped — every `followCountry` / `unfollowCountry` /
// `mergeAnonymousLocal` mutation throws SHARDS_NOT_SEEDED if its shard
// row is missing, so the cron is the steady-state self-heal. Cheap:
// post-seed it just runs a 64-row collect + skip-loop.
crons.daily(
  "followed-countries-shards-seed",
  { hourUTC: 3, minuteUTC: 0 },
  internal.followedCountries._seedShards,
);

// Daily dedupe pass for the `followedCountriesShards` table. Pairs with
// `_seedShards` above: a concurrent-seed race (e.g. the deploy step
// running in parallel with the cron tick) can produce duplicate rows
// for the same `shardId`. `readShardOrThrow` uses `.first()` so
// duplicates don't break correctness, but they degrade OCC contention
// coverage for users hashing to that shard. Running the dedupe in the
// same daily slot, 1 minute after the seed, guarantees the table is
// back to exactly SHARD_COUNT rows within 24h of any race. Idempotent
// in the steady-state (no duplicates → no deletes).
crons.daily(
  "followed-countries-shards-dedupe",
  { hourUTC: 3, minuteUTC: 1 },
  internal.followedCountries._dedupeShards,
);

crons.daily(
  "followed-countries-country-locks-seed",
  { hourUTC: 3, minuteUTC: 2 },
  internal.followedCountries._seedCountryLocks,
);

crons.daily(
  "followed-countries-country-locks-dedupe",
  { hourUTC: 3, minuteUTC: 3 },
  internal.followedCountries._dedupeCountryLocks,
);

// Daily self-heal for the singleton Dodo failure summary. This both restores a
// missing deploy-time seed and removes duplicate global rows from a rare race
// between deploy/manual/cron seed invocations. Operational reads tolerate the
// duplicates until this idempotent pass retains the oldest authority row.
crons.daily(
  "dodo-webhook-failure-summary-seed",
  { hourUTC: 3, minuteUTC: 4 },
  internal.payments.webhookMutations._seedFailureSummary,
);

// Dunning + winback scan (#4932). Schedules the due day-3/day-7 payment-
// failure reminders and the 30-day winback (at most one step per
// subscription per tick; every send re-validates live state). 14:30 UTC =
// ~10:30am ET, inside US business hours so a reply/complaint gets seen the
// same day, and 90 minutes after the broadcast ramp runner (13:00) so the
// two email systems never interleave sends.
crons.daily(
  "billing-dunning-scan",
  { hourUTC: 14, minuteUTC: 30 },
  internal.payments.subscriptionEmails.runDunningScan,
  {},
);

// Missed-renewal reconciliation (#4765): a renewal that succeeded at Dodo
// but whose webhook was lost leaves the local sub with a lapsed period —
// wrongly cutting off a paying customer. Daily sweep refreshes those from
// Dodo's authoritative state and recomputes entitlements.
crons.daily(
  "dodo-renewal-reconciliation",
  { hourUTC: 3, minuteUTC: 17 },
  internal.payments.billing.reconcileMissedDodoRenewals,
  {},
);

// Business Pro seat grant reconciliation (#4634/#4635) — safety net for the
// webhook-driven and scheduled grant-revocation paths in subscriptionHelpers.ts.
// A lost webhook or a dropped scheduled function can leave a grant pointing
// at a Business subscription that's no longer covering/no longer api_business;
// this daily sweep independently re-derives every live grant's validity
// rather than trusting a single revocation trigger to have fired.
crons.daily(
  "business-pro-grants-reconciliation",
  { hourUTC: 3, minuteUTC: 20 },
  internal.payments.subscriptionHelpers.reconcileBusinessProGrants,
  {},
);

export default crons;
