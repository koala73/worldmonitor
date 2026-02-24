/**
 * RPC: ListMarketQuotes
 * Fetches stock/index quotes from Finnhub (stocks) and Yahoo Finance (indices/futures).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { YAHOO_ONLY_SYMBOLS, fetchFinnhubQuote, fetchYahooQuotesBatch } from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:quotes:v1';
const REDIS_CACHE_TTL = 120; // 2 min — shared across all Vercel instances

const quotesCache = new Map<string, { data: ListMarketQuotesResponse; timestamp: number }>();
const QUOTES_CACHE_TTL = 120_000; // 2 minutes (in-memory fallback)

function cacheKey(symbols: string[]): string {
  return [...symbols].sort().join(',');
}

function redisCacheKey(symbols: string[]): string {
  return `${REDIS_CACHE_KEY}:${[...symbols].sort().join(',')}`;
}

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const now = Date.now();
  const key = cacheKey(req.symbols);

  // Layer 1: in-memory cache (same instance)
  const memCached = quotesCache.get(key);
  if (memCached && now - memCached.timestamp < QUOTES_CACHE_TTL) {
    return memCached.data;
  }

  // Layer 2: Redis shared cache (cross-instance)
  const redisKey = redisCacheKey(req.symbols);
  const redisCached = (await getCachedJson(redisKey)) as ListMarketQuotesResponse | null;
  if (redisCached?.quotes?.length) {
    quotesCache.set(key, { data: redisCached, timestamp: now });
    return redisCached;
  }

  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    const symbols = req.symbols;
    if (!symbols.length) return { quotes: [], finnhubSkipped: !apiKey, skipReason: !apiKey ? 'FINNHUB_API_KEY not configured' : '' };

    const finnhubSymbols = symbols.filter((s) => !YAHOO_ONLY_SYMBOLS.has(s));
    const yahooSymbols = symbols.filter((s) => YAHOO_ONLY_SYMBOLS.has(s));

    const quotes: MarketQuote[] = [];

    // Fetch Finnhub quotes (only if API key is set)
    if (finnhubSymbols.length > 0 && apiKey) {
      const results = await Promise.all(
        finnhubSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
      );
      for (const r of results) {
        if (r) {
          quotes.push({
            symbol: r.symbol,
            name: r.symbol,
            display: r.symbol,
            price: r.price,
            change: r.changePercent,
            sparkline: [],
          });
        }
      }
    }

    // Fetch Yahoo Finance quotes for indices/futures (staggered to avoid 429)
    if (yahooSymbols.length > 0) {
      const batch = await fetchYahooQuotesBatch(yahooSymbols);
      for (const s of yahooSymbols) {
        const yahoo = batch.get(s);
        if (yahoo) {
          quotes.push({
            symbol: s,
            name: s,
            display: s,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }
    }

    // Stale-while-revalidate: if Yahoo rate-limited and no fresh data, serve cached
    if (quotes.length === 0 && memCached) {
      return memCached.data;
    }

    const result: ListMarketQuotesResponse = { quotes, finnhubSkipped: !apiKey, skipReason: !apiKey ? 'FINNHUB_API_KEY not configured' : '' };
    if (quotes.length > 0) {
      quotesCache.set(key, { data: result, timestamp: now });
      setCachedJson(redisKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    if (memCached) return memCached.data;
    return { quotes: [], finnhubSkipped: false, skipReason: '' };
  }
}
