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
import { fetchYahooQuotesBatch, parseStringArray } from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:commodities:v1';
const REDIS_CACHE_TTL = 600; // 10 min — commodities move slower than indices

const fallbackCommodityCache = new Map<string, { data: ListCommodityQuotesResponse; ts: number }>();

function redisCacheKey(symbols: string[]): string {
  return `${REDIS_CACHE_KEY}:${[...symbols].sort().join(',')}`;
}

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  const symbols = parseStringArray(req.symbols);
  if (!symbols.length) return { quotes: [] };

  // Layer 0: bootstrap/seed data (written by Railway ais-relay)
  try {
    const bootstrap = await getCachedJson('market:commodities-bootstrap:v1', true) as ListCommodityQuotesResponse | null;
    if (bootstrap?.quotes?.length) {
      const symbolSet = new Set(symbols);
      const filtered = bootstrap.quotes.filter((q: CommodityQuote) => symbolSet.has(q.symbol));
      if (filtered.length > 0) {
        return { quotes: filtered };
      }
    }
  } catch {}

  const redisKey = redisCacheKey(symbols);

  try {
  const result = await cachedFetchJson<ListCommodityQuotesResponse>(redisKey, REDIS_CACHE_TTL, async () => {
    const batch = await fetchYahooQuotesBatch(symbols);
    const quotes: CommodityQuote[] = [];
    for (const s of symbols) {
      const yahoo = batch.results.get(s);
      if (yahoo) {
        quotes.push({ symbol: s, name: s, display: s, price: yahoo.price, change: yahoo.change, sparkline: yahoo.sparkline });
      }
    }
    return quotes.length > 0 ? { quotes } : null;
  });

  if (result) {
    if (fallbackCommodityCache.size > 50) fallbackCommodityCache.clear();
    fallbackCommodityCache.set(redisKey, { data: result, ts: Date.now() });
  }
  return result || fallbackCommodityCache.get(redisKey)?.data || { quotes: [] };
  } catch {
    return fallbackCommodityCache.get(redisKey)?.data || { quotes: [] };
  }
}
