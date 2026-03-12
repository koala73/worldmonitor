/**
 * RPC: ListGulfQuotes
 * Fetches GCC stock indices, Gulf currencies, and oil benchmarks from Yahoo Finance.
 *
 * Inspired by https://github.com/koala73/worldmonitor/pull/641 (@aa5064).
 */

import type {
  ServerContext,
  ListGulfQuotesRequest,
  ListGulfQuotesResponse,
  GulfQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { fetchYahooQuotesBatch } from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import gulfConfig from '../../../../shared/gulf.json';

const REDIS_KEY = 'market:gulf-quotes:v1';
const REDIS_TTL = 480; // 8 min

const SEED_FRESHNESS_MS = 90 * 60_000; // 90 min — Railway seeds every hour

let memCache: { data: ListGulfQuotesResponse; ts: number } | null = null;
const MEM_TTL = 480_000;

interface GulfSymbolMeta {
  symbol: string;
  name: string;
  country: string;
  flag: string;
  type: 'index' | 'currency' | 'oil';
}

const GULF_SYMBOLS: GulfSymbolMeta[] = gulfConfig.symbols as GulfSymbolMeta[];

const ALL_SYMBOLS = GULF_SYMBOLS.map(s => s.symbol);
const META_MAP = new Map(GULF_SYMBOLS.map(s => [s.symbol, s]));

export async function listGulfQuotes(
  _ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  const now = Date.now();

  if (memCache && now - memCache.ts < MEM_TTL) {
    return memCache.data;
  }

  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_KEY, true) as Promise<ListGulfQuotesResponse | null>,
      getCachedJson('seed-meta:market:gulf-quotes', true) as Promise<{ fetchedAt?: number } | null>,
    ]);
    if (seedData?.quotes?.length) {
      const fetchedAt = seedMeta?.fetchedAt ?? 0;
      const isFresh = now - fetchedAt < SEED_FRESHNESS_MS;
      if (isFresh || !process.env.SEED_FALLBACK_GULF) {
        memCache = { data: seedData, ts: now };
        return seedData;
      }
    }
  } catch { /* fall through to live fetch */ }

  try {
    const result = await cachedFetchJson<ListGulfQuotesResponse>(REDIS_KEY, REDIS_TTL, async () => {
      const batch = await fetchYahooQuotesBatch(ALL_SYMBOLS);

      const quotes: GulfQuote[] = [];
      for (const sym of ALL_SYMBOLS) {
        const yahoo = batch.results.get(sym);
        const meta = META_MAP.get(sym)!;
        if (yahoo) {
          quotes.push({
            symbol: sym,
            name: meta.name,
            country: meta.country,
            flag: meta.flag,
            type: meta.type,
            price: yahoo.price,
            change: yahoo.change,
            sparkline: yahoo.sparkline,
          });
        }
      }

      // Safe: read-only snapshot — cachedFetchJson coalesces concurrent calls but
      // memCache is only written after the fetcher resolves, never inside it.
      if (quotes.length === 0 && memCache) return null;
      if (quotes.length === 0) {
        return batch.rateLimited
          ? { quotes: [], rateLimited: true }
          : null;
      }

      return { quotes, rateLimited: false };
    });

    if (result?.quotes?.length) {
      memCache = { data: result, ts: now };
    }

    return result || memCache?.data || { quotes: [], rateLimited: false };
  } catch {
    return memCache?.data || { quotes: [], rateLimited: false };
  }
}
