import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "cleanup-expired-pairing-tokens",
  { minuteUTC: 27 },
  internal.telegramPairingTokens.cleanupExpired,
);

// PRO-launch broadcast ramp runner. Wakes once a day at 13:00 UTC
// (~9am ET / 6am PT / 3pm CET — early enough that any kill-gate
// trip can be triaged within US business hours, late enough that
// overnight bounces and complaints have flowed back via the Resend
// webhook). The action no-ops when no ramp is configured, the ramp
// is paused, kill-gated, or the prior wave hasn't settled yet —
// see `convex/broadcast/rampRunner.ts` for the full state machine.
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

export default crons;
