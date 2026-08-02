/**
 * RPC: ListMarketQuotes -- reads seeded stock/index data from Railway seed cache.
 * All external Finnhub/Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';

export function filterMarketQuotes(
  bootstrap: ListMarketQuotesResponse,
  symbols: string[],
): ListMarketQuotesResponse {
  if (symbols.length === 0) return bootstrap;
  const symbolSet = new Set(symbols);
  return {
    ...bootstrap,
    quotes: bootstrap.quotes.filter((quote) => symbolSet.has(quote.symbol)),
  };
}

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

    return filterMarketQuotes(bootstrap, parsedSymbols);
  } catch {
    return { quotes: [], finnhubSkipped: false, skipReason: '', rateLimited: false };
  }
}
