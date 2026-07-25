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

export default crons;
