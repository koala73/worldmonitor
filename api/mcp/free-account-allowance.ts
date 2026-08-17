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
 */

import type { PipelineFn } from './types';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from './upgrade-constants';

export type FreeAccountAllowanceOk = {
  ok: true;
  rollback: () => Promise<void>;
};

export type FreeAccountAllowanceRejected = {
  ok: false;
  reason: 'allowance-exhausted' | 'redis-unavailable';
};

export type FreeAccountAllowanceResult = FreeAccountAllowanceOk | FreeAccountAllowanceRejected;

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function freeAccountCallsKey(userId: string, nowMs: number): string {
  return `mcp:free-acct:calls:${userId}:${utcDayKey(nowMs)}`;
}

export function freeAccountRequestsKey(userId: string, nowMs: number): string {
  return `mcp:free-acct:reqs:${userId}:${utcDayKey(nowMs)}`;
}

export function freeAccountLastActivityKey(userId: string): string {
  return `mcp:free-acct:last:${userId}`;
}

/** Seconds until end of UTC day + 1h slack — counters must not linger forever. */
function dayTtlSeconds(nowMs: number): number {
  const dayStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const endOfDay = dayStart + 24 * 60 * 60 * 1000;
  return Math.max(60, Math.ceil((endOfDay - nowMs) / 1000) + 3600);
}

function asFiniteNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reserve one free-account MCP tool call.
 *
 * Ordering is load-bearing: call counter first (absolute ceiling), then idle-
 * gap request window. Both fail closed on Redis errors.
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
  const lastKey = freeAccountLastActivityKey(userId);
  const ttl = dayTtlSeconds(nowMs);

  // --- Call ceiling -------------------------------------------------------
  let callPipe: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    callPipe = await pipeline([
      ['INCR', callsKey],
      ['EXPIRE', callsKey, ttl],
    ]);
  } catch {
    callPipe = null;
  }
  if (!callPipe || !Array.isArray(callPipe) || callPipe.length === 0) {
    return { ok: false, reason: 'redis-unavailable' };
  }
  const callCount = asFiniteNumber(callPipe[0]?.result);
  if (callCount === null || callCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  const rollbackCall = async (): Promise<void> => {
    try {
      await pipeline([['DECR', callsKey]]);
    } catch {
      /* best-effort; overshoot is the cost-protection direction */
    }
  };

  if (callCount > callsLimit) {
    await rollbackCall();
    return { ok: false, reason: 'allowance-exhausted' };
  }

  // --- Idle-gap request window --------------------------------------------
  let lastPipe: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    lastPipe = await pipeline([['GET', lastKey]]);
  } catch {
    lastPipe = null;
  }
  if (!lastPipe || !Array.isArray(lastPipe)) {
    await rollbackCall();
    return { ok: false, reason: 'redis-unavailable' };
  }

  const lastRaw = lastPipe[0]?.result;
  const lastMs = lastRaw == null || lastRaw === ''
    ? null
    : asFiniteNumber(typeof lastRaw === 'string' || typeof lastRaw === 'number' ? lastRaw : null);
  const opensNewWindow = lastMs === null || nowMs - lastMs >= idleGapMs;

  let requestCount = 0;
  if (opensNewWindow) {
    let reqPipe: Array<{ result?: unknown; error?: unknown }> | null;
    try {
      reqPipe = await pipeline([
        ['INCR', reqsKey],
        ['EXPIRE', reqsKey, ttl],
      ]);
    } catch {
      reqPipe = null;
    }
    if (!reqPipe || !Array.isArray(reqPipe) || reqPipe.length === 0) {
      await rollbackCall();
      return { ok: false, reason: 'redis-unavailable' };
    }
    const incr = asFiniteNumber(reqPipe[0]?.result);
    if (incr === null || incr < 1) {
      await rollbackCall();
      return { ok: false, reason: 'redis-unavailable' };
    }
    requestCount = incr;
    if (requestCount > requestsLimit) {
      try {
        await pipeline([['DECR', reqsKey]]);
      } catch {
        /* best-effort */
      }
      await rollbackCall();
      return { ok: false, reason: 'allowance-exhausted' };
    }
  }

  // Touch last-activity after both counters accept. Fail closed if we cannot
  // persist the touch — otherwise a stuck last-activity would never open a
  // new window and a missing touch would open unbounded windows.
  let touchPipe: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    touchPipe = await pipeline([
      ['SET', lastKey, String(nowMs)],
      ['EXPIRE', lastKey, Math.max(ttl, Math.ceil(idleGapMs / 1000) + 3600)],
    ]);
  } catch {
    touchPipe = null;
  }
  if (!touchPipe) {
    if (opensNewWindow) {
      try {
        await pipeline([['DECR', reqsKey]]);
      } catch {
        /* best-effort */
      }
    }
    await rollbackCall();
    return { ok: false, reason: 'redis-unavailable' };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    await rollbackCall();
    if (opensNewWindow) {
      try {
        await pipeline([['DECR', reqsKey]]);
      } catch {
        /* best-effort */
      }
    }
  };

  return {
    ok: true,
    rollback,
  };
}

// Re-export constants for tests / catalog docs without a circular import into
// upgrade.ts (upgrade.ts must stay free of Redis).
export {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from './upgrade-constants';
