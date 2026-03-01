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
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_KEY = 'market:gulf-quotes:v1';
const REDIS_TTL = 480; // 8 min

let memCache: { data: ListGulfQuotesResponse; ts: number } | null = null;
const MEM_TTL = 480_000;

interface GulfSymbolMeta {
  symbol: string;
  name: string;
  country: string;
  flag: string;
  type: 'index' | 'currency' | 'oil';
}

const GULF_SYMBOLS: GulfSymbolMeta[] = [
  // Indices (7)
  { symbol: '^TASI', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: '🇸🇦', type: 'index' },
  { symbol: '^DFMGI', name: 'Dubai Financial Market', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: '^FTFADGI', name: 'Abu Dhabi ADX', country: 'UAE', flag: '🇦🇪', type: 'index' },
  { symbol: '^QSI', name: 'Qatar Stock Exchange', country: 'Qatar', flag: '🇶🇦', type: 'index' },
  { symbol: '^BKP.BH', name: 'Bahrain All Share', country: 'Bahrain', flag: '🇧🇭', type: 'index' },
  { symbol: '^KWSE', name: 'Kuwait Boursa', country: 'Kuwait', flag: '🇰🇼', type: 'index' },
  { symbol: '^MSM30', name: 'Muscat MSM 30', country: 'Oman', flag: '🇴🇲', type: 'index' },
  // Currencies (6)
  { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: '🇸🇦', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'UAE Dirham', country: 'UAE', flag: '🇦🇪', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'Qatari Riyal', country: 'Qatar', flag: '🇶🇦', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'Kuwaiti Dinar', country: 'Kuwait', flag: '🇰🇼', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'Bahraini Dinar', country: 'Bahrain', flag: '🇧🇭', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'Omani Rial', country: 'Oman', flag: '🇴🇲', type: 'currency' },
  // Oil benchmarks (2)
  { symbol: 'CL=F', name: 'WTI Crude', country: '', flag: '🛢️', type: 'oil' },
  { symbol: 'BZ=F', name: 'Brent Crude', country: '', flag: '🛢️', type: 'oil' },
];

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
