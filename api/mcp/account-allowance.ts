import type { McpAuthContext, McpHandlerDeps } from './types';
import { dailyAllowanceResetAt, isSharedRestCounter, readDailyAllowance, type McpBudget } from './quota';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
  freeAccountCallsKey,
  freeAccountLastActivityKey,
  freeAccountRequestsKey,
} from './free-account-allowance';
import { READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT } from '../../shared/free-account-allowance-scripts.mjs';

export interface McpAllowanceStatus {
  access: 'subscription' | 'free-account';
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: string;
  requestWindows: {
    used: number;
    limit: number;
    remaining: number;
    idleGapMs: number;
    active: boolean;
    expiresAt: string | null;
  } | null;
  sharedWithRestApi: boolean;
}

function redisInteger(raw: unknown, missingValue?: number): number | null {
  if (raw === null || raw === undefined) return missingValue ?? null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasRedisResult(entry: unknown): entry is { result: unknown; error?: unknown } {
  return typeof entry === 'object'
    && entry !== null
    && Object.prototype.hasOwnProperty.call(entry, 'result');
}

export async function readAccountAllowance(
  context: Extract<McpAuthContext, { kind: 'pro' | 'user_key' }>,
  deps: Pick<McpHandlerDeps, 'redisPipeline'>,
  budget?: McpBudget,
  freeAccountAllowance = false,
  nowMs = Date.now(),
): Promise<McpAllowanceStatus | null> {
  if (!freeAccountAllowance) {
    const allowance = await readDailyAllowance(context.userId, deps.redisPipeline, budget, nowMs);
    if (!allowance) return null;
    return { access: 'subscription', ...allowance, requestWindows: null, sharedWithRestApi: isSharedRestCounter(budget) };
  }
  const resetsAt = dailyAllowanceResetAt(nowMs);
  const limit = FREE_ACCOUNT_CALLS_PER_DAY;

  const commands: Array<Array<string | number>> = [[
    'EVAL',
    READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT,
    3,
    freeAccountCallsKey(context.userId, nowMs),
    freeAccountRequestsKey(context.userId, nowMs),
    freeAccountLastActivityKey(context.userId, nowMs),
  ]];

  let result: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    result = await deps.redisPipeline(commands, 5_000, true);
  } catch {
    result = null;
  }
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  if (
    !Array.isArray(result)
    || result.length < commands.length
    || !hasRedisResult(firstResult)
    || result.some((entry) => entry?.error !== undefined && entry?.error !== null)
  ) {
    return null;
  }

  const tuple = firstResult.result;
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    return null;
  }
  const [rawCalls, rawRequests, rawActivityPttl] = tuple;
  const callsMissing = rawCalls === null;
  const requestsMissing = rawRequests === null;
  const storedCalls = redisInteger(rawCalls, 0);
  const storedRequests = redisInteger(rawRequests, 0);
  const rawPttl = redisInteger(rawActivityPttl);
  if (
    rawCalls === undefined
    || rawRequests === undefined
    || storedCalls === null
    || storedCalls < 0
    || storedRequests === null
    || storedRequests < 0
    || callsMissing !== requestsMissing
    || storedRequests > storedCalls
    || rawPttl === null
    || rawPttl < -2
    || rawPttl === -1
    || (rawPttl > 0 && storedCalls === 0)
  ) {
    return null;
  }
  const used = Math.min(storedCalls, FREE_ACCOUNT_CALLS_PER_DAY);
  const requestUsed = Math.min(storedRequests, FREE_ACCOUNT_REQUESTS_PER_DAY);
  const pttl = rawPttl > 0 ? rawPttl : null;
  const requestWindows = {
    used: requestUsed,
    limit: FREE_ACCOUNT_REQUESTS_PER_DAY,
    remaining: Math.max(0, FREE_ACCOUNT_REQUESTS_PER_DAY - requestUsed),
    idleGapMs: FREE_ACCOUNT_IDLE_GAP_MS,
    active: pttl !== null,
    expiresAt: pttl === null ? null : new Date(nowMs + pttl).toISOString(),
  };

  const remaining = Math.max(0, limit - used);

  return {
    access: 'free-account',
    used,
    limit,
    remaining,
    resetsAt,
    requestWindows,
    sharedWithRestApi: false,
  };
}

