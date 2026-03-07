import { MARKET_SYMBOLS } from '@/config';
import {
  MarketServiceClient,
  type AnalyzeStockResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { getMarketWatchlistEntries } from '@/services/market-watchlist';

const client = new MarketServiceClient('', {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

export type StockAnalysisResult = AnalyzeStockResponse;

export interface StockAnalysisTarget {
  symbol: string;
  name: string;
  display: string;
}

const DEFAULT_LIMIT = 4;

function isAnalyzableSymbol(symbol: string): boolean {
  return !symbol.startsWith('^') && !symbol.includes('=');
}

export function getStockAnalysisTargets(limit = DEFAULT_LIMIT): StockAnalysisTarget[] {
  const customEntries = getMarketWatchlistEntries().filter((entry) => isAnalyzableSymbol(entry.symbol));
  const baseEntries = customEntries.length > 0
    ? customEntries.map((entry) => ({
        symbol: entry.symbol,
        name: entry.name || entry.symbol,
        display: entry.display || entry.symbol,
      }))
    : MARKET_SYMBOLS.filter((entry) => isAnalyzableSymbol(entry.symbol));

  const seen = new Set<string>();
  const targets: StockAnalysisTarget[] = [];
  for (const entry of baseEntries) {
    if (seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    targets.push({ symbol: entry.symbol, name: entry.name, display: entry.display });
    if (targets.length >= limit) break;
  }
  return targets;
}

export async function fetchStockAnalyses(limit = DEFAULT_LIMIT): Promise<StockAnalysisResult[]> {
  const targets = getStockAnalysisTargets(limit);
  const results = await Promise.allSettled(
    targets.map((target) => client.analyzeStock({
      symbol: target.symbol,
      name: target.name,
      includeNews: true,
    })),
  );

  return results
    .flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    .filter((result) => result.available);
}
