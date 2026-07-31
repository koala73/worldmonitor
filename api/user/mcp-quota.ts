/**
 * GET /api/user/mcp-quota
 *
 * Clerk-authenticated read-only endpoint that returns the caller's current
 * Pro MCP daily quota usage. Reads the SAME Redis key shape that U7 writes
 * via INCR-first reservation in `api/mcp.ts` (`mcp:pro-usage:<userId>:<YYYY-MM-DD>`).
 * Single source of truth — `dailyCounterKey` is imported from
 * `server/_shared/pro-mcp-token.ts` so a writer/reader drift cannot occur.
 *
 * Response shape:
 *   200 { used: number, limit: number | null, resetsAt: <ISO at next UTC midnight> }
 *
 * `limit` is the caller's PLAN allowance (plan 2026-07-25-001 U3b), resolved
 * from `features.planLimits.mcpCallsPerDay` through the SAME `resolveDailyLimit`
 * that `api/mcp/quota.ts` enforces with — `null` means unlimited. Before U3b
 * this reported a hardcoded 50, so a Pro Business user at 120 of 250 read
 * "50 / 50" in Settings while enforcement served them fine.
 *
 * Edge cases:
 *   - First call of the UTC day: Redis key missing → `used: 0`.
 *   - Malformed Redis value (non-numeric): treat as 0 (the counter is
 *     INCR-only; non-numeric values would be a serious upstream regression
 *     better surfaced as "0 today" than as a 500).
 *   - Redis transient: log + return `used: 0`. The settings UI is best-effort
 *     informational; we never want a broken Redis to block the settings tab.
 *   - Entitlement lookup unavailable (null, or throwing): fall back to the
 *     pre-U3b behaviour (50). Same cost-protection direction as enforcement,
 *     and a lookup blip must never 500 a previously-working endpoint.
 *
 * Status codes:
 *   - 200 OK on success
 *   - 401 if no/invalid Clerk session
 *   - 405 on non-GET methods
 *
 * Cache-Control: no-store — quota state changes per-call, never cache.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { resolveClerkSession } from '../../server/_shared/auth-session';
import { getEntitlements } from '../../server/_shared/entitlement-check';
import { resolveDailyLimit, resolvePlanDrivenMcpAllowance } from '../mcp/quota';
import {
  dailyCounterKey,
  secondsUntilUtcMidnight,
} from '../../server/_shared/pro-mcp-token';

/** Inner handler — exported for unit tests with injected deps. */
export interface QuotaDeps {
  /** Resolves the Clerk userId from the request's Bearer header. Null = unauth. */
  resolveUserId: (req: Request) => Promise<string | null>;
  /**
   * Reads the daily counter key from Redis. Returns the stringified count
   * (Upstash returns INCR results as strings) or null if the key does not
   * exist. Throws on transport failure — the caller fail-softs to "0 used".
   */
  redisGet: (key: string) => Promise<string | null>;
  /**
   * Cached entitlement read for the plan allowance. Only `planKey` and
   * `features.planLimits.mcpCallsPerDay` are consumed; null/throw fall back
   * to the plan default via `resolveDailyLimit`.
   */
  getEntitlements: (userId: string) => Promise<{
    planKey?: string;
    features?: {
      planLimits?: { mcpCallsPerDay?: number | null };
    };
  } | null>;
  /** Injectable for deterministic tests. */
  now: () => Date;
}

const REDIS_OP_TIMEOUT_MS = 1_500;

async function rawRedisGetString(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  return typeof data?.result === 'string' ? data.result : null;
}

export async function quotaHandler(req: Request, deps: QuotaDeps): Promise<Response> {
  const cors = getCorsHeaders(req);
  const jsonHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'GET, OPTIONS' },
    });
  }

  const userId = await deps.resolveUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  const now = deps.now();
  const key = dailyCounterKey(userId, now);

  // Plan allowance first — `used` is clamped to THIS number, not to the
  // historical 50. An unreadable entitlement leaves `planDailyLimit`
  // undefined, which resolveDailyLimit turns into the plan default. The
  // plan-family gate mirrors enforcement (`checkMcpEntitlementGate`): an
  // API-tier plan's catalog allowance is NOT what the meter applies, so it
  // must not be what this endpoint displays.
  let planDailyLimit: number | null | undefined;
  try {
    const ent = await deps.getEntitlements(userId);
    planDailyLimit = resolvePlanDrivenMcpAllowance(ent?.planKey, ent?.features?.planLimits?.mcpCallsPerDay);
  } catch (err) {
    console.warn(
      '[mcp-quota] entitlement lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
    captureSilentError(err, {
      tags: { route: 'api/user/mcp-quota', step: 'entitlements' },
    });
  }
  const limit = resolveDailyLimit(planDailyLimit);

  let raw: string | null = null;
  try {
    raw = await deps.redisGet(key);
  } catch (err) {
    // Best-effort: Redis blip → report 0 used. The hard cap is enforced
    // server-side at INCR time; this endpoint is informational.
    console.warn(
      '[mcp-quota] Redis read failed:',
      err instanceof Error ? err.message : String(err),
    );
    captureSilentError(err, {
      tags: { route: 'api/user/mcp-quota', step: 'redis-get' },
    });
  }

  let used = 0;
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      // Cap displayed value at the resolved limit so a stale-rollover or test
      // injection cannot show "73 / 50". Unlimited plans have nothing to clamp
      // to — the raw counter IS the display value there.
      const floored = Math.floor(n);
      used = limit === null ? floored : Math.min(floored, limit);
    }
  }

  // Compute resetsAt deterministically from now + secondsUntilUtcMidnight.
  // Equivalent to floor-to-day + 1 day in UTC, but reuses the helper U7
  // already uses for Retry-After to guarantee the displayed countdown
  // matches the enforcement window exactly.
  const resetsAtMs = now.getTime() + secondsUntilUtcMidnight(now) * 1000;
  const resetsAt = new Date(resetsAtMs).toISOString();

  return new Response(
    JSON.stringify({ used, limit, resetsAt }),
    { status: 200, headers: jsonHeaders },
  );
}

export default async function handler(req: Request): Promise<Response> {
  return quotaHandler(req, {
    resolveUserId: async (r) => (await resolveClerkSession(r))?.userId ?? null,
    redisGet: rawRedisGetString,
    getEntitlements,
    now: () => new Date(),
  });
}
