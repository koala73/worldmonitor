import { runRedisPipeline } from '../../../_shared/redis';

// ---------- AviationStack monthly call budget ----------
//
// Hard ceiling on PAID AviationStack calls per calendar month, shared across
// every call site (the request-time RPC layer + scripts/seed-aviation.mjs).
// All callers INCRBY the same Redis counter `aviation:avstack:calls:<YYYY-MM>`
// (UTC) and refuse to call upstream once their ceiling is reached, so total
// spend can never exceed the plan no matter how much user traffic or how many
// cron ticks arrive.
//
// Two ceilings against ONE counter so user-panel traffic can't starve the
// curated seeder (the seeder feeds the map + health; request-time is a panel
// nicety):
//   - request-time calls stop at AVIATIONSTACK_REQUEST_BUDGET (default 85k)
//   - all calls (incl. seeder) stop at AVIATIONSTACK_MONTHLY_BUDGET (default
//     130k) — the gap reserves headroom for the seeder.
// Defaults sum under a 135k plan with margin. Set MONTHLY budget to 0 to
// disable the cap entirely (legacy behaviour).
//
// IMPORTANT: keep the key format + env names in lockstep with the duplicate
// implementation in scripts/seed-aviation.mjs (the seeder is plain .mjs and
// cannot import this module). In production both run unprefixed against the
// same Upstash instance, so they share the counter; preview deploys are
// key-prefixed and bill separately, which is fine.

export function aviationStackBudgetMonth(now = new Date()): string {
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return ym;
}

function avstackBudgetKey(now = new Date()): string {
  return `aviation:avstack:calls:${aviationStackBudgetMonth(now)}`;
}

const AVSTACK_BUDGET_TTL = 40 * 24 * 60 * 60; // 40d — outlives the month; next month uses a new key

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Reserve `count` AviationStack calls against the monthly budget. Returns true
 * if the caller may proceed with the upstream call(s), false if doing so would
 * breach the ceiling for this `kind` (caller should serve last-good/empty).
 *
 * Fail-open: if Redis is unreachable we allow the call. The seeder — the bulk
 * spender — is independently bounded by its freshness gate, and failing closed
 * would blank the panel on every Redis blip. The 5k margin under a 135k plan
 * absorbs the slack.
 */
export async function reserveAviationStackCalls(
  count: number,
  kind: 'request' | 'seed',
): Promise<boolean> {
  if (count <= 0) return true;
  const hardCap = intEnv('AVIATIONSTACK_MONTHLY_BUDGET', 130_000);
  if (hardCap <= 0) return true; // cap disabled
  const ceiling = kind === 'seed'
    ? hardCap
    : Math.min(hardCap, intEnv('AVIATIONSTACK_REQUEST_BUDGET', 85_000));

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
      console.warn(`[Aviation] AviationStack ${kind} call blocked — monthly budget reached (${total - count}/${ceiling})`);
      return false;
    }
    return true;
  } catch {
    return true; // fail-open
  }
}
