import { normalizeStockSymbol } from '../../shared/stock-symbol';
import { getRpcBaseUrl } from '@/services/rpc-client';
import type { BacktestStockResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import { runThrottledTargetRequests } from '@/services/throttled-target-requests';
import { premiumFetch } from '@/services/premium-fetch';
import { MarketServiceClient } from '@/services/generated-rpc-clients';

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

export type StockBacktestResult = BacktestStockResponse;

const DEFAULT_EVAL_WINDOW_DAYS = 10;
export const STOCK_BACKTEST_FRESH_MS = 24 * 60 * 60 * 1000;

async function getTargets(limitOverride?: number) {
  const { getStockAnalysisTargets } = await import('./stock-analysis');
  return getStockAnalysisTargets(limitOverride);
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
  limitOverride?: number,
  evalWindowDays = DEFAULT_EVAL_WINDOW_DAYS,
): Promise<StockBacktestResult[]> {
  return fetchStockBacktestsForTargets(await getTargets(limitOverride), evalWindowDays);
}

export async function fetchStoredStockBacktests(
  limitOverride?: number,
  evalWindowDays = DEFAULT_EVAL_WINDOW_DAYS,
): Promise<StockBacktestResult[]> {
  const targets = await getTargets(limitOverride);
  const symbols = targets.map((target) => target.symbol);
  const response = await client.listStoredStockBacktests({
    symbols,
    evalWindowDays,
  });
  return response.items.filter((result) => result.available);
}

function indexBacktestsBySymbol(items: StockBacktestResult[]): Map<string, StockBacktestResult> {
  const bySymbol = new Map<string, StockBacktestResult>();
  for (const item of items) {
    const symbol = normalizeStockSymbol(item.symbol);
    if (symbol) bySymbol.set(symbol, item);
  }
  return bySymbol;
}

function isFreshBacktest(item: StockBacktestResult | undefined, now: number, maxAgeMs: number): boolean {
  const ts = Date.parse(item?.generatedAt || '');
  return !!item?.available && Number.isFinite(ts) && (now - ts) <= maxAgeMs;
}

export function hasFreshStoredStockBacktests(
  items: StockBacktestResult[],
  symbols: string[],
  maxAgeMs = STOCK_BACKTEST_FRESH_MS,
): boolean {
  if (symbols.length === 0) return false;
  const bySymbol = indexBacktestsBySymbol(items);
  const now = Date.now();
  return symbols.every((symbol) => isFreshBacktest(bySymbol.get(normalizeStockSymbol(symbol)), now, maxAgeMs));
}

export function getMissingOrStaleStoredStockBacktests(
  items: StockBacktestResult[],
  symbols: string[],
  maxAgeMs = STOCK_BACKTEST_FRESH_MS,
): string[] {
  const bySymbol = indexBacktestsBySymbol(items);
  const now = Date.now();
  return symbols.filter((symbol) => !isFreshBacktest(bySymbol.get(normalizeStockSymbol(symbol)), now, maxAgeMs));
}
