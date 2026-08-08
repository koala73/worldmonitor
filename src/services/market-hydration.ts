import type { MarketSymbolMeta } from '@/services/market-watchlist';

export interface HydratedMarketQuote {
  symbol: string;
  name?: string;
  display?: string;
  price?: number | null;
  change?: number | null;
  sparkline?: number[];
}

/**
 * Select a bootstrap snapshot only when it completely covers the current
 * effective selection. Results are filtered and ordered to match that
 * selection; `null` tells the caller to use the live parameterized RPC.
 */
export function selectCompleteHydratedMarketQuotes<T extends HydratedMarketQuote>(
  effectiveSymbols: readonly MarketSymbolMeta[],
  hydratedQuotes: readonly T[] | null | undefined,
): T[] | null {
  if (effectiveSymbols.length === 0 || !hydratedQuotes?.length) return null;
  const bySymbol = new Map(hydratedQuotes.map((quote) => [quote.symbol, quote]));
  const ordered: T[] = [];
  for (const meta of effectiveSymbols) {
    const quote = bySymbol.get(meta.symbol);
    if (!quote) return null;
    ordered.push(quote);
  }
  return ordered;
}
