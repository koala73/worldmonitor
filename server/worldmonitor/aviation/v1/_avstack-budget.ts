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
// Two ceilings so user-panel and API traffic can't starve the curated seeder
// (the seeder feeds the map + health):
//   - request-time calls stop once THEIR OWN spend reaches
//     AVIATIONSTACK_REQUEST_BUDGET (default 6k), counted on a separate
//     `aviation:avstack:request-calls:<cycle>` key. Measured against the
//     shared counter, seeder spend counted toward it, the total crossed 7k
//     under three days into the cycle, and flight-status and airport-flights
//     answered source "budget" for the remaining four weeks.
//   - all calls (incl. seeder) stop at AVIATIONSTACK_MONTHLY_BUDGET (default
//     48k) on the shared counter — the gap reserves headroom for the seeder.
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

function avstackRequestBudgetKey(now = new Date()): string {
  return `aviation:avstack:request-calls:${aviationStackBudgetCycle(now)}`;
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

  const now = new Date();
  const counters: Array<{ key: string; ceiling: number }> = [{ key: avstackBudgetKey(now), ceiling: hardCap }];
  if (kind === 'request') {
    counters.push({
      key: avstackRequestBudgetKey(now),
      ceiling: Math.min(hardCap, intEnv('AVIATIONSTACK_REQUEST_BUDGET', 6_000)),
    });
  }

  try {
    const res = await runRedisPipeline(counters.flatMap(({ key }) => [
      ['INCRBY', key, count],
      ['EXPIRE', key, AVSTACK_BUDGET_TTL],
    ]));
    const totals = counters.map((_, i) => Number(res?.[i * 2]?.result));
    // A counter that did answer and is over its ceiling blocks the call even
    // when the other one errored; fail-open covers only an unknown total.
    const breached = counters.findIndex(({ ceiling }, i) => Number.isFinite(totals[i]) && totals[i]! > ceiling);
    if (breached < 0 && !totals.every(Number.isFinite)) return true; // redis unavailable → fail-open
    if (breached >= 0) {
      // Give the reservation back so the counters reflect calls actually made.
      const reserved = counters.filter((_, i) => Number.isFinite(totals[i]));
      const refund = await runRedisPipeline(reserved.map(({ key }) => ['DECRBY', key, count]));
      if (!reserved.every((_, i) => Number.isFinite(Number(refund?.[i]?.result)))) {
        console.warn(`[Aviation] AviationStack ${kind} budget refund failed for ${count} call(s); counter may be inflated`);
      }
      const { ceiling } = counters[breached]!;
      const scope = breached === 0 ? 'cycle' : 'request-time';
      console.warn(`[Aviation] AviationStack ${kind} call blocked — ${scope} budget reached (${totals[breached]! - count}/${ceiling})`);
      return false;
    }
    return true;
  } catch {
    return true; // fail-open
  }
}
