import { runRedisPipeline } from '../../../_shared/redis';

// ---------- AviationStack billing-cycle call budget ----------
//
// Hard ceiling on PAID AviationStack calls per BILLING CYCLE, shared across
// every call site (the request-time RPC layer + scripts/seed-aviation.mjs).
// All callers INCRBY the same Redis counter
// `aviation:avstack:calls:<YYYY-MM-DD>` (UTC, the cycle's start date) and
// refuse to call upstream once their ceiling is reached, so total spend can
// never exceed the plan no matter how much user traffic or how many cron ticks
// arrive.
//
// The window is the invoice's, not the calendar's. AviationStack bills from an
// anniversary day (the 25th on this account), so the counter used to key on
// `<YYYY-MM>` while the invoice ran the 25th → 24th. That mismatch makes the
// cap wrong in BOTH directions: it keeps refusing calls into the first days of
// a fresh allowance, and it zeroes itself a week into a cycle that is already
// partly spent. AVIATIONSTACK_CYCLE_RESET_DAY moves the anniversary.
//
// Two ceilings against ONE counter so user-panel traffic can't starve the
// curated seeder (the seeder feeds the map + health; request-time is a panel
// nicety):
//   - request-time calls stop at AVIATIONSTACK_REQUEST_BUDGET (default 7k)
//   - all calls (incl. seeder) stop at AVIATIONSTACK_MONTHLY_BUDGET (default
//     48k) — the gap reserves headroom for the seeder.
// Defaults sit under a 50,000/cycle plan. Note the seeder alone needs ~40.3k
// (56 airports x 24 sweeps x 30d) and ~41.7k on a 31-day cycle, so the reserved
// gap is deliberately most of the budget and the real headroom is thin —
// lowering the seeder's sweep cadence is the lever if that stops fitting.
// Set MONTHLY budget to 0 to disable the cap entirely (legacy behaviour).
//
// IMPORTANT: keep the key format + env names in lockstep with the duplicate
// implementation in scripts/seed-aviation.mjs (the seeder is plain .mjs and
// cannot import this module). In production both run unprefixed against the
// same Upstash instance, so they share the counter; preview deploys are
// key-prefixed and bill separately, which is fine.

const DEFAULT_CYCLE_RESET_DAY = 25;

// Clamped to 1..28 so a cycle opens in every month — an anniversary of 29-31
// would silently skip February and hand out a double-length allowance.
function cycleResetDay(): number {
  const raw = Number(process.env.AVIATIONSTACK_CYCLE_RESET_DAY?.trim());
  if (!Number.isInteger(raw) || raw < 1 || raw > 28) return DEFAULT_CYCLE_RESET_DAY;
  return raw;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * UTC start date of the billing cycle containing `now`, as `YYYY-MM-DD`.
 *
 * On or after the anniversary day we are in the cycle that opened this month;
 * before it, we are still inside the one that opened last month. `Date.UTC`
 * normalises month -1 into the previous December, so January is not special.
 */
export function aviationStackBudgetCycle(now = new Date()): string {
  const resetDay = cycleResetDay();
  const monthOffset = now.getUTCDate() >= resetDay ? 0 : -1;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, resetDay));
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
}

// Exported so a test can prove this agrees with the seeder's avstackBudgetKey:
// a drift between the two splits the shared ceiling into two counters and
// silently doubles AviationStack spend.
export function avstackBudgetKey(now = new Date()): string {
  return `aviation:avstack:calls:${aviationStackBudgetCycle(now)}`;
}

const AVSTACK_BUDGET_TTL = 40 * 24 * 60 * 60; // 40d — outlives the longest cycle; the next cycle uses a new key

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Reserve `count` AviationStack calls against the billing-cycle budget. Returns true
 * if the caller may proceed with the upstream call(s), false if doing so would
 * breach the ceiling for this `kind` (caller should serve last-good/empty).
 *
 * Fail-open: if Redis is unreachable we allow the call. The seeder — the bulk
 * spender — is independently bounded by its freshness gate, and failing closed
 * would blank the panel on every Redis blip. The 2k margin under a 50k plan
 * absorbs the slack.
 */
export async function reserveAviationStackCalls(
  count: number,
  kind: 'request' | 'seed',
): Promise<boolean> {
  if (count <= 0) return true;
  const hardCap = intEnv('AVIATIONSTACK_MONTHLY_BUDGET', 48_000);
  if (hardCap <= 0) return true; // cap disabled
  const ceiling = kind === 'seed'
    ? hardCap
    : Math.min(hardCap, intEnv('AVIATIONSTACK_REQUEST_BUDGET', 7_000));

  const key = avstackBudgetKey();
  try {
    const res = await runRedisPipeline([
      ['INCRBY', key, count],
      ['EXPIRE', key, AVSTACK_BUDGET_TTL],
    ]);
    const total = Number(res?.[0]?.result);
    if (!Number.isFinite(total)) return true; // redis unavailable → fail-open
    if (total > ceiling) {
      // Give the reservation back so the counter reflects calls actually made.
      const refund = await runRedisPipeline([['DECRBY', key, count]]);
      const refundedTotal = Number(refund?.[0]?.result);
      if (!Number.isFinite(refundedTotal)) {
        console.warn(`[Aviation] AviationStack ${kind} budget refund failed for ${count} call(s); counter may be inflated`);
      }
      console.warn(`[Aviation] AviationStack ${kind} call blocked — cycle budget reached (${total - count}/${ceiling})`);
      return false;
    }
    return true;
  } catch {
    return true; // fail-open
  }
}
