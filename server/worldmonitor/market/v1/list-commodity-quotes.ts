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
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:commodities:v1';
const REDIS_CACHE_TTL = 180; // 3 min — commodities move slower than indices

function redisCacheKey(symbols: string[]): string {
  return `${REDIS_CACHE_KEY}:${[...symbols].sort().join(',')}`;
}

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  try {
    const symbols = req.symbols;
    if (!symbols.length) return { quotes: [] };

    // Redis shared cache
    const redisKey = redisCacheKey(symbols);
    const cached = (await getCachedJson(redisKey)) as ListCommodityQuotesResponse | null;
    if (cached?.quotes?.length) return cached;

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

    const response: ListCommodityQuotesResponse = { quotes: results.filter((r): r is CommodityQuote => r !== null) };
    if (response.quotes.length > 0) {
      setCachedJson(redisKey, response, REDIS_CACHE_TTL).catch(() => {});
    }
    return response;
  } catch {
    return { quotes: [] };
  }
}
