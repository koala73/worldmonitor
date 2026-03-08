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

export async function fetchStockAnalysesForTargets(targets: StockAnalysisTarget[]): Promise<StockAnalysisResult[]> {
  const results: StockAnalysisResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const result = await client.analyzeStock({
        symbol: targets[i]!.symbol,
        name: targets[i]!.name,
        includeNews: true,
      });
      if (result.available) results.push(result);
    } catch {
      // Skip failed individual analysis
    }
  }
  return results;
}

export async function fetchStockAnalyses(limit = DEFAULT_LIMIT): Promise<StockAnalysisResult[]> {
  return fetchStockAnalysesForTargets(getStockAnalysisTargets(limit));
}
