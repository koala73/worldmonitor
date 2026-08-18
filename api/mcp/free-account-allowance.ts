/**
 * Free-account MCP allowance (#6716) — MCP call-site only.
 *
 * Two fail-closed counters for authenticated callers whose Pro gate returned
 * `insufficient_tier` (confirmed free / non-Pro), NOT billing-verification
 * states:
 *
 *   1. Request windows/day — a new window opens after an idle gap (MCP has no
 *      task boundary; a desktop client holds one session across questions).
 *   2. Absolute call ceiling/day — hard cap on tools/call count.
 *
 * MUST NOT be wired into `checkProMcpAccess`. That gate has five callers;
 * relaxing it centrally would grant free-tier access on the REST gateway and
 * both OAuth mint paths. Reinterpretation lives only in `api/mcp/auth.ts`.
 *
 * Scope note: the allowance covers CACHE-BACKED tools only. `api/mcp/dispatch.ts`
 * refuses a tool with `_execute` before calling in here, because those fan out to
 * `server/gateway.ts`, whose own `checkProMcpAccess` re-check this feature does
 * not relax — admitting one would charge a slot for a call the gateway rejects.
 */

import type { PipelineFn } from './types';
import { envPrefix } from '../../server/_shared/pro-mcp-token';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from './upgrade-constants';

export type FreeAccountAllowanceOk = {
  ok: true;
};

export type FreeAccountAllowanceRejected = {
  ok: false;
  reason: 'allowance-exhausted' | 'redis-unavailable';
};

export type FreeAccountAllowanceResult = FreeAccountAllowanceOk | FreeAccountAllowanceRejected;

/** One pipeline element as returned by the Upstash REST helper. */
type PipeElement = { result?: unknown; error?: unknown };

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Every key carries the environment prefix, exactly like `dailyCounterKey`.
 * Preview and production share ONE Upstash instance (see `redis.ts`'s
 * `getKeyPrefix` comment), so an unprefixed key would let a preview deploy
 * spend — or reset — a real user's production allowance.
 */
export function freeAccountCallsKey(userId: string, nowMs: number): string {
  return `${envPrefix()}mcp:free-acct:calls:${userId}:${utcDayKey(nowMs)}`;
}

export function freeAccountRequestsKey(userId: string, nowMs: number): string {
  return `${envPrefix()}mcp:free-acct:reqs:${userId}:${utcDayKey(nowMs)}`;
}

/**
 * Day-scoped like both counters it gates. An un-scoped last-activity key
 * outlives the UTC rollover, so activity at 23:58 would still look "recent" at
 * 00:01 and suppress the new day's first window-open — the new day's request
 * counter would never reach 1 for that burst, letting an extra window slip past
 * the daily cap before counting starts.
 */
export function freeAccountLastActivityKey(userId: string, nowMs: number): string {
  return `${envPrefix()}mcp:free-acct:last:${userId}:${utcDayKey(nowMs)}`;
}

/** Seconds until end of UTC day + 1h slack — counters must not linger forever. */
function dayTtlSeconds(nowMs: number): number {
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const endOfDay = dayStart + 24 * 60 * 60 * 1000;
  return Math.max(60, Math.ceil((endOfDay - nowMs) / 1000) + 3600);
}

function asFiniteNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when any element of a pipeline reply failed.
 *
 * The Upstash REST pipeline resolves as a whole even when an individual command
 * errors — the failure is reported per element. Inspecting only element 0 (the
 * INCR) let a failed EXPIRE through: the counter landed with NO TTL, so it never
 * reset at the UTC boundary and the caller stayed locked out past midnight.
 */
function pipelineFailed(pipe: PipeElement[] | null, expected: number): boolean {
  if (!pipe || !Array.isArray(pipe) || pipe.length < expected) return true;
  return pipe.slice(0, expected).some((el) => el?.error !== undefined && el?.error !== null);
}

async function runPipeline(
  pipeline: PipelineFn,
  commands: Array<Array<string | number>>,
): Promise<PipeElement[] | null> {
  try {
    const res = await pipeline(commands);
    return Array.isArray(res) ? (res as PipeElement[]) : null;
  } catch {
    return null;
  }
}

/**
 * Clamp a counter that rollback failed to bring back down.
 *
 * Ports `reserveQuota`'s F4 protection (api/mcp/quota.ts). Both counters here
 * use INCR-then-best-effort-DECR, and a DECR lost to a Redis hiccup ratchets the
 * counter permanently upward — every later INCR then exceeds the limit and the
 * caller is locked out for the rest of the UTC day. That matters MORE here than
 * on the Pro path: the ceiling is 5, not 50+, so a couple of lost DECRs is the
 * whole allowance.
 */
async function clampCounter(
  pipeline: PipelineFn,
  key: string,
  limit: number,
  observedCount: number,
): Promise<void> {
  if (observedCount <= limit + 1) return;
  const probe = await runPipeline(pipeline, [['INCR', key], ['DECR', key]]);
  const probeIncr = asFiniteNumber(probe?.[0]?.result);
  if (probeIncr === null) return;
  const postRollbackCount = probeIncr - 1;
  if (postRollbackCount <= limit) return;
  // DECR the overshoot away (bounded) rather than SET, so the key's existing TTL
  // survives and the mock surface stays INCR/DECR/EXPIRE/GET/SET-only.
  const decrs = Math.min(postRollbackCount - limit, 100);
  await runPipeline(
    pipeline,
    Array.from({ length: decrs }, () => ['DECR', key]),
  );
}

/**
 * Reserve one free-account MCP tool call.
 *
 * Ordering is load-bearing: call counter first (absolute ceiling), then idle-
 * gap request window. Both fail closed on Redis errors — including a per-element
 * error inside an otherwise-resolved pipeline.
 */
export async function reserveFreeAccountAllowance(
  userId: string,
  pipeline: PipelineFn,
  nowMs: number = Date.now(),
  opts?: {
    callsPerDay?: number;
    requestsPerDay?: number;
    idleGapMs?: number;
  },
): Promise<FreeAccountAllowanceResult> {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, reason: 'redis-unavailable' };
  }

  const callsLimit = opts?.callsPerDay ?? FREE_ACCOUNT_CALLS_PER_DAY;
  const requestsLimit = opts?.requestsPerDay ?? FREE_ACCOUNT_REQUESTS_PER_DAY;
  const idleGapMs = opts?.idleGapMs ?? FREE_ACCOUNT_IDLE_GAP_MS;
  const callsKey = freeAccountCallsKey(userId, nowMs);
  const reqsKey = freeAccountRequestsKey(userId, nowMs);
  const lastKey = freeAccountLastActivityKey(userId, nowMs);
  const ttl = dayTtlSeconds(nowMs);

  // --- Call ceiling -------------------------------------------------------
  const callPipe = await runPipeline(pipeline, [
    ['INCR', callsKey],
    ['EXPIRE', callsKey, ttl],
  ]);
  if (pipelineFailed(callPipe, 2)) {
    return { ok: false, reason: 'redis-unavailable' };
  }
  const callCount = asFiniteNumber(callPipe?.[0]?.result);
  if (callCount === null || callCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  const rollbackCall = async (): Promise<void> => {
    await runPipeline(pipeline, [['DECR', callsKey]]);
  };

  if (callCount > callsLimit) {
    await rollbackCall();
    await clampCounter(pipeline, callsKey, callsLimit, callCount);
    return { ok: false, reason: 'allowance-exhausted' };
  }

  // --- Idle-gap request window --------------------------------------------
  // ONE atomic claim, not a GET-now/SET-later pair. MCP clients fan tool calls
  // out concurrently; with a read-modify-write every request in a burst read the
  // same stale timestamp, each concluded it was opening a window, and a single
  // user-visible burst spent 2-3 of the 3 daily windows. `SET NX EX` makes
  // exactly one caller the window opener — the reply is 'OK' for the winner and
  // null for everyone else.
  const claim = await runPipeline(pipeline, [
    ['SET', lastKey, String(nowMs), 'EX', String(Math.ceil(idleGapMs / 1000)), 'NX'],
  ]);
  if (pipelineFailed(claim, 1)) {
    await rollbackCall();
    return { ok: false, reason: 'redis-unavailable' };
  }
  const claimResult = claim?.[0]?.result;
  const opensNewWindow = claimResult === 'OK' || claimResult === true;

  if (opensNewWindow) {
    const reqPipe = await runPipeline(pipeline, [
      ['INCR', reqsKey],
      ['EXPIRE', reqsKey, ttl],
    ]);
    if (pipelineFailed(reqPipe, 2)) {
      await rollbackCall();
      return { ok: false, reason: 'redis-unavailable' };
    }
    const requestCount = asFiniteNumber(reqPipe?.[0]?.result);
    if (requestCount === null || requestCount < 1) {
      await rollbackCall();
      return { ok: false, reason: 'redis-unavailable' };
    }
    if (requestCount > requestsLimit) {
      await runPipeline(pipeline, [['DECR', reqsKey]]);
      await clampCounter(pipeline, reqsKey, requestsLimit, requestCount);
      await rollbackCall();
      return { ok: false, reason: 'allowance-exhausted' };
    }
  }

  // No rollback handle is returned. Once this resolves ok the caller dispatches
  // and the slot is charged for good (the GHSA-hcq5 posture `reserveQuota`
  // states); a refund seam that no caller may legitimately use is a trap, not an
  // affordance.
  return { ok: true };
}

// Re-export constants for tests / catalog docs without a circular import into
// upgrade.ts (upgrade.ts must stay free of Redis).
export {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from './upgrade-constants';
