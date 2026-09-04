import { TRUSTED_USER_ID_HEADER } from './mcp-internal-hmac';
import { getKeyPrefix } from './redis';
import { PRO_DAILY_QUOTA_TTL_SECONDS, secondsUntilUtcMidnight } from './pro-mcp-token';

/**
 * Daily Yahoo-history budget for `GET /api/market/v1/backtest-stock`.
 *
 * This is provider-work, not LLM spend: the handler is technical-only and
 * must not share `llm:direct-usage` / `dashboardAiCallsPerDay`. The largest
 * dashboard hydration is 50 Pro watchlist symbols, and stored snapshots stay
 * fresh for 24h, so a legitimate day is typically one miss per symbol plus
 * retries and same-day watchlist edits. 200 admits four full 50-symbol
 * hydrations without letting one paid identity rotate distinct symbols at
 * the 60/min route cap all day.
 */
export const BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT = 200;
export const BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;
export const BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE =
  'Stock backtest daily provider quota exceeded';
export const BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE =
  'Stock backtest provider quota unavailable';

export type BacktestStockQuotaReservation =
  | { ok: true; newCount: number; rollback: () => Promise<void> }
  | {
      ok: false;
      reason: 'cap-exceeded' | 'redis-unavailable';
      floor?: number;
      retryAfterSec: number;
    };

export type BacktestStockQuotaPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown; error?: unknown }>>;

export function backtestStockQuotaUserId(request: Request | undefined | null): string | null {
  if (!request) return null;
  const userId = request.headers.get(TRUSTED_USER_ID_HEADER)?.trim();
  return userId || null;
}

export function backtestStockProviderQuotaKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${getKeyPrefix()}provider:backtest-yahoo:${userId}:${yyyy}-${mm}-${dd}`;
}

export async function reserveBacktestStockProviderQuota(opts: {
  userId: string;
  pipeline: BacktestStockQuotaPipeline;
  date?: Date;
}): Promise<BacktestStockQuotaReservation> {
  const retryAfterSec = secondsUntilUtcMidnight(opts.date);
  const key = backtestStockProviderQuotaKey(opts.userId, opts.date);
  if (!key) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let pipeResult: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    pipeResult = await opts.pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  const incrEntry = pipeResult[0];
  if (incrEntry?.error != null) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  const incrRaw = incrEntry?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let rolledBack = false;
  const rollback = async (restoreExpiry = false): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await opts.pipeline([
        ['DECR', key],
        ...(restoreExpiry ? [['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS]] : []),
      ]);
    } catch {
      // Best-effort: over-counting by one is the cost-protection-correct direction.
    }
  };

  const expireEntry = pipeResult[1];
  const expireSucceeded =
    pipeResult.length === 2
    && expireEntry?.error == null
    && (expireEntry?.result === 1 || expireEntry?.result === '1');
  if (!expireSucceeded) {
    // If this was a newly-created key, DECR alone would leave a permanent
    // zero-valued orphan. Retry the TTL while refunding the unproved claim.
    await rollback(true);
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: BACKTEST_STOCK_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  if (newCount > BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT) {
    await rollback();
    return {
      ok: false,
      reason: 'cap-exceeded',
      floor: BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
      retryAfterSec,
    };
  }

  return { ok: true, newCount, rollback: () => rollback() };
}
