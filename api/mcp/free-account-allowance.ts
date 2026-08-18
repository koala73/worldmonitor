/**
 * Free-account MCP allowance (#6716) — MCP call-site only.
 *
 * Two fail-closed counters for authenticated callers whose Pro gate returned
 * `free_account` (a confirmed free verdict), NOT generic insufficient-tier or
 * billing-verification states:
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
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * One Redis-side reservation owns all three keys. Redis serializes scripts, so
 * concurrent calls cannot observe a counter and later apply a stale rollback.
 * Every rejection returns before the first write; every admission writes the
 * counters, their end-of-day TTLs, and refreshed last activity together.
 *
 * Result codes:
 *   1  admitted
 *   0  allowance exhausted
 *  -1  stored state was malformed (fail closed)
 */
const RESERVE_FREE_ACCOUNT_ALLOWANCE_SCRIPT = `
local function non_negative_integer(raw)
  if raw == false or raw == nil then return 0 end
  local value = tonumber(raw)
  if value == nil or value < 0 or value ~= math.floor(value) then return nil end
  return value
end

local calls_raw = redis.call('GET', KEYS[1])
local requests_raw = redis.call('GET', KEYS[2])
local last_raw = redis.call('GET', KEYS[3])
local calls = non_negative_integer(calls_raw)
local requests = non_negative_integer(requests_raw)
local last = nil
if last_raw ~= false and last_raw ~= nil then
  last = non_negative_integer(last_raw)
end
local calls_missing = calls_raw == false or calls_raw == nil
local requests_missing = requests_raw == false or requests_raw == nil
local last_present = last_raw ~= false and last_raw ~= nil
if calls == nil or requests == nil or (last_present and last == nil) then
  return {-1}
end
if calls_missing ~= requests_missing or requests > calls or (last_present and calls == 0) then
  return {-1}
end

local now_ms = tonumber(ARGV[1])
local idle_gap_ms = tonumber(ARGV[2])
local calls_limit = tonumber(ARGV[3])
local requests_limit = tonumber(ARGV[4])
local opens_window = last == nil or now_ms - last >= idle_gap_ms
local activity_value = ARGV[1]
if last ~= nil and last > now_ms then activity_value = last_raw end

if calls >= calls_limit then return {0} end
if opens_window and requests >= requests_limit then return {0} end

calls = calls + 1
if opens_window then requests = requests + 1 end
redis.call('SET', KEYS[1], tostring(calls), 'EX', ARGV[5])
if opens_window then
  redis.call('SET', KEYS[2], tostring(requests), 'EX', ARGV[5])
end
redis.call('SET', KEYS[3], activity_value, 'PX', ARGV[2])
return {1}
`;

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reserve one free-account MCP tool call.
 *
 * The single EVAL reply is the authorization decision. Redis/transport errors,
 * malformed stored state, and malformed replies all fail closed before tool
 * dispatch. A denial changes none of the three allowance keys.
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
  if (!userId || typeof userId !== 'string' || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  const callsLimit = opts?.callsPerDay ?? FREE_ACCOUNT_CALLS_PER_DAY;
  const requestsLimit = opts?.requestsPerDay ?? FREE_ACCOUNT_REQUESTS_PER_DAY;
  const idleGapMs = opts?.idleGapMs ?? FREE_ACCOUNT_IDLE_GAP_MS;
  if (!validLimit(callsLimit) || !validLimit(requestsLimit) || !Number.isSafeInteger(idleGapMs) || idleGapMs < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }
  const callsKey = freeAccountCallsKey(userId, nowMs);
  const reqsKey = freeAccountRequestsKey(userId, nowMs);
  const lastKey = freeAccountLastActivityKey(userId, nowMs);
  const ttl = dayTtlSeconds(nowMs);

  let response: Awaited<ReturnType<PipelineFn>> = null;
  try {
    response = await pipeline([[
      'EVAL',
      RESERVE_FREE_ACCOUNT_ALLOWANCE_SCRIPT,
      3,
      callsKey,
      reqsKey,
      lastKey,
      nowMs,
      idleGapMs,
      callsLimit,
      requestsLimit,
      ttl,
    ]]);
  } catch {
    response = null;
  }

  const entry = response?.[0];
  if (
    !response
    || response.length !== 1
    || !entry
    || (entry.error !== undefined && entry.error !== null)
    || !Array.isArray(entry.result)
  ) {
    return { ok: false, reason: 'redis-unavailable' };
  }
  const status = asFiniteNumber(entry.result[0]);
  if (status === 1) return { ok: true };
  if (status === 0) return { ok: false, reason: 'allowance-exhausted' };
  return { ok: false, reason: 'redis-unavailable' };
}

// Re-export constants for tests / catalog docs without a circular import into
// upgrade.ts (upgrade.ts must stay free of Redis).
export {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from './upgrade-constants';
