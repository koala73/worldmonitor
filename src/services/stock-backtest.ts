import {
  MarketServiceClient,
  type BacktestStockResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';

const client = new MarketServiceClient('', {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

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
  const results: StockBacktestResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const result = await client.backtestStock({
        symbol: targets[i]!.symbol,
        name: targets[i]!.name,
        evalWindowDays,
      });
      if (result.available) results.push(result);
    } catch {
      // Skip failed individual backtest
    }
  }
  return results;
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
