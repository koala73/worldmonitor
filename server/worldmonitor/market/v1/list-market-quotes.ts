/**
 * RPC: ListMarketQuotes -- reads seeded stock/index data from Railway seed cache.
 * All external Finnhub/Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const parsedSymbols = parseStringArray(req.symbols);

  try {
    const bootstrap = await getCachedJson(BOOTSTRAP_KEY, true) as ListMarketQuotesResponse | null;
    if (!bootstrap?.quotes?.length) {
      return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
    }

    if (parsedSymbols.length > 0) {
      const symbolSet = new Set(parsedSymbols);
      const filtered = bootstrap.quotes.filter((q: MarketQuote) => symbolSet.has(q.symbol));
      return { quotes: filtered, finnhubSkipped: false, skipReason: '', rateLimited: false };
    }

    return bootstrap;
  } catch {
    return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
  }
}
