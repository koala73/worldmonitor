/**
 * Pure target-selection for the Premium Stock Analysis / Backtesting / Daily
 * Market Brief panels. No runtime imports — kept side-effect free so it can be
 * unit-tested without a DOM, localStorage, or RPC client.
 */

import type { MarketWatchlistEntry } from '@/services/market-watchlist';

export interface StockAnalysisTarget {
  symbol: string;
  name: string;
  display: string;
}

/**
 * Free tier (and the empty-watchlist baseline for every tier) analyses this
 * many tickers. PRO users get their full watchlist analysed, up to
 * STOCK_ANALYSIS_PRO_LIMIT — which mirrors the 50-entry storage cap enforced
 * in market-watchlist.ts.
 */
export const STOCK_ANALYSIS_FREE_LIMIT = 4;
export const STOCK_ANALYSIS_PRO_LIMIT = 50;

/** Indices (^GSPC) and FX/futures (EURUSD=X, GC=F) have no equity report. */
export function isAnalyzableSymbol(symbol: string): boolean {
  return !symbol.startsWith('^') && !symbol.includes('=');
}

/**
 * Resolve the ordered list of tickers to analyse.
 *
 * The user's watchlist picks come first (they care about those most), then the
 * panel is topped up with default symbols — so a watchlist with a single entry
 * never collapses the panel to one card (the original "tracking only one
 * ticker" bug).
 *
 * - Free tier: capped at STOCK_ANALYSIS_FREE_LIMIT.
 * - PRO tier: sized to the user's own analysable picks, floored at the free
 *   limit (an empty/tiny watchlist is never emptier than free) and capped at
 *   STOCK_ANALYSIS_PRO_LIMIT.
 *
 * `limitOverride`, when provided, can only *shrink* the resolved cap — callers
 * pass it to keep dependent fetches (history, backtests) aligned with an
 * already-resolved target list, never to grant more than the tier allows.
 */
export function selectStockAnalysisTargets(
  watchlistEntries: readonly MarketWatchlistEntry[],
  defaultSymbols: readonly { symbol: string; name: string; display: string }[],
  opts: { isPro: boolean; limitOverride?: number },
): StockAnalysisTarget[] {
  const userPicks: StockAnalysisTarget[] = watchlistEntries
    .filter((entry) => isAnalyzableSymbol(entry.symbol))
    .map((entry) => ({
      symbol: entry.symbol,
      name: entry.name || entry.symbol,
      display: entry.display || entry.symbol,
    }));

  const cap = opts.isPro
    ? Math.max(STOCK_ANALYSIS_FREE_LIMIT, Math.min(STOCK_ANALYSIS_PRO_LIMIT, userPicks.length))
    : STOCK_ANALYSIS_FREE_LIMIT;
  const limit = opts.limitOverride != null
    ? Math.max(0, Math.min(opts.limitOverride, cap))
    : cap;

  const seen = new Set<string>();
  const targets: StockAnalysisTarget[] = [];

  for (const entry of userPicks) {
    if (targets.length >= limit) break;
    if (seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    targets.push(entry);
  }

  for (const entry of defaultSymbols) {
    if (targets.length >= limit) break;
    if (!isAnalyzableSymbol(entry.symbol) || seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    targets.push({ symbol: entry.symbol, name: entry.name, display: entry.display });
  }

  return targets;
}
