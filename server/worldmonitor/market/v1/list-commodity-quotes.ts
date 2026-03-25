/**
 * RPC: ListCommodityQuotes -- reads seeded commodity data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  CommodityQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const BOOTSTRAP_KEY = 'market:commodities-bootstrap:v1';

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  const symbols = parseStringArray(req.symbols);
  if (!symbols.length) return { quotes: [] };

  try {
    const bootstrap = await getCachedJson(BOOTSTRAP_KEY, true) as ListCommodityQuotesResponse | null;
    if (!bootstrap?.quotes?.length) return { quotes: [] };

    const symbolSet = new Set(symbols);
    const filtered = bootstrap.quotes.filter((q: CommodityQuote) => symbolSet.has(q.symbol));
    return { quotes: filtered };
  } catch {
    return { quotes: [] };
  }
}
