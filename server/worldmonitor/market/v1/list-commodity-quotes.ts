/**
 * RPC: ListCommodityQuotes
 * Fetches commodity futures quotes from Yahoo Finance.
 */

import type {
  ServerContext,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  CommodityQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { fetchYahooQuote } from './_shared';

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  try {
    const symbols = req.symbols;
    if (!symbols.length) return { quotes: [] };

    const results = await Promise.all(
      symbols.map(async (s) => {
        const yahoo = await fetchYahooQuote(s);
        if (!yahoo) return null;
        return {
          symbol: s,
          name: s,
          display: s,
          price: yahoo.price,
          change: yahoo.change,
          sparkline: yahoo.sparkline,
        } satisfies CommodityQuote;
      }),
    );

    return { quotes: results.filter((r): r is CommodityQuote => r !== null) };
  } catch {
    return { quotes: [] };
  }
}
