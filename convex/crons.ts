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

export default crons;
