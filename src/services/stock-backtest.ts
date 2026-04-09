import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  MarketServiceClient,
  type BacktestStockResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { runThrottledTargetRequests } from '@/services/throttled-target-requests';
import { premiumFetch } from '@/services/premium-fetch';

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

export type StockBacktestResult = BacktestStockResponse;

const DEFAULT_LIMIT = 4;
const DEFAULT_EVAL_WINDOW_DAYS = 10;
export const STOCK_BACKTEST_FRESH_MS = 24 * 60 * 60 * 1000;

async function getTargets(limit: number) {
  const { getStockAnalysisTargets } = await import('./stock-analysis');
  return getStockAnalysisTargets(limit);
}

export async function fetchStockBacktestsForTargets(
  targets: Array<{ symbol: string; name: string }>,
  evalWindowDays = DEFAULT_EVAL_WINDOW_DAYS,
): Promise<StockBacktestResult[]> {
  return runThrottledTargetRequests(targets, async (target) => {
    return client.backtestStock({
      symbol: target.symbol,
      name: target.name,
        evalWindowDays,
    });
  });
}

export async function fetchStockBacktests(
  limit = DEFAULT_LIMIT,
  evalWindowDays = DEFAULT_EVAL_WINDOW_DAYS,
): Promise<StockBacktestResult[]> {
  return fetchStockBacktestsForTargets(await getTargets(limit), evalWindowDays);
}

export async function fetchStoredStockBacktests(
  limit = DEFAULT_LIMIT,
  evalWindowDays = DEFAULT_EVAL_WINDOW_DAYS,
): Promise<StockBacktestResult[]> {
  const targets = await getTargets(limit);
  const symbols = targets.map((target) => target.symbol);
  const response = await client.listStoredStockBacktests({
    symbols,
    evalWindowDays,
  });
  return response.items.filter((result) => result.available);
}

export function hasFreshStoredStockBacktests(
  items: StockBacktestResult[],
  symbols: string[],
  maxAgeMs = STOCK_BACKTEST_FRESH_MS,
): boolean {
  if (symbols.length === 0) return false;
  const bySymbol = new Map(items.map((item) => [item.symbol, item]));
  const now = Date.now();
  return symbols.every((symbol) => {
    const item = bySymbol.get(symbol);
    const ts = Date.parse(item?.generatedAt || '');
    return !!item?.available && Number.isFinite(ts) && (now - ts) <= maxAgeMs;
  });
}

export function getMissingOrStaleStoredStockBacktests(
  items: StockBacktestResult[],
  symbols: string[],
  maxAgeMs = STOCK_BACKTEST_FRESH_MS,
): string[] {
  const bySymbol = new Map(items.map((item) => [item.symbol, item]));
  const now = Date.now();
  return symbols.filter((symbol) => {
    const item = bySymbol.get(symbol);
    const ts = Date.parse(item?.generatedAt || '');
    return !(item?.available && Number.isFinite(ts) && (now - ts) <= maxAgeMs);
  });
}
