import { MARKET_SYMBOLS } from '@/config';
import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  MarketServiceClient,
  type AnalyzeStockResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { getMarketWatchlistEntries } from '@/services/market-watchlist';
import { runThrottledTargetRequests } from '@/services/throttled-target-requests';
import { premiumFetch } from '@/services/premium-fetch';
import { isProUser } from '@/services/widget-store';
import {
  selectStockAnalysisTargets,
  type StockAnalysisTarget,
} from '@/services/stock-analysis-targets';

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

export type StockAnalysisResult = AnalyzeStockResponse;

export {
  isAnalyzableSymbol,
  selectStockAnalysisTargets,
  STOCK_ANALYSIS_FREE_LIMIT,
  STOCK_ANALYSIS_PRO_LIMIT,
} from '@/services/stock-analysis-targets';
export type { StockAnalysisTarget } from '@/services/stock-analysis-targets';

/**
 * Tier-aware watchlist resolution: the user's analysable picks lead, then the
 * panel is topped up with default symbols. `limitOverride` only shrinks the
 * resolved cap — callers pass it to keep dependent fetches aligned with an
 * already-resolved target list. See selectStockAnalysisTargets for the rules.
 */
export function getStockAnalysisTargets(limitOverride?: number): StockAnalysisTarget[] {
  return selectStockAnalysisTargets(getMarketWatchlistEntries(), MARKET_SYMBOLS, {
    isPro: isProUser(),
    limitOverride,
  });
}

export async function fetchStockAnalysesForTargets(targets: StockAnalysisTarget[]): Promise<StockAnalysisResult[]> {
  return runThrottledTargetRequests(targets, async (target) => {
    return client.analyzeStock({
      symbol: target.symbol,
      name: target.name,
        includeNews: true,
    });
  });
}

export async function fetchStockAnalyses(limitOverride?: number): Promise<StockAnalysisResult[]> {
  return fetchStockAnalysesForTargets(getStockAnalysisTargets(limitOverride));
}
