/**
 * RPC: ListCryptoQuotes
 * Fetches cryptocurrency quotes from CoinGecko markets API.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CRYPTO_META, fetchCoinGeckoMarkets, parseStringArray } from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:crypto:v1';
const REDIS_CACHE_TTL = 600; // 10 min — CoinGecko rate-limited

const SEED_FRESHNESS_MS = 45 * 60 * 1000; // 45 minutes

const fallbackCryptoCache = new Map<string, { data: ListCryptoQuotesResponse; ts: number }>();

const SYMBOL_TO_ID = new Map(Object.entries(CRYPTO_META).map(([id, m]) => [m.symbol, id]));

async function trySeededCrypto(ids: string[]): Promise<ListCryptoQuotesResponse | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<{ quotes: CryptoQuote[] } | null>,
      getCachedJson('seed-meta:market:crypto', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.quotes?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    const allIds = new Set(ids);
    const filtered = allIds.size === 0
      ? seedData.quotes
      : seedData.quotes.filter((q) => allIds.has(SYMBOL_TO_ID.get(q.symbol) ?? ''));

    if (filtered.length === 0) return null;
    if (isFresh || !process.env.SEED_FALLBACK_CRYPTO) return { quotes: filtered };
    return null;
  } catch {
    return null;
  }
}

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const parsedIds = parseStringArray(req.ids);
  const ids = parsedIds.length > 0 ? parsedIds : Object.keys(CRYPTO_META);

  // Try Railway-seeded data first
  const seeded = await trySeededCrypto(ids);
  if (seeded) return seeded;

  const cacheKey = `${REDIS_CACHE_KEY}:${[...ids].sort().join(',')}`;

  try {
  const result = await cachedFetchJson<ListCryptoQuotesResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
    const items = await fetchCoinGeckoMarkets(ids);

    if (items.length === 0) {
      throw new Error('CoinGecko returned no data');
    }

    const byId = new Map(items.map((c) => [c.id, c]));
    const quotes: CryptoQuote[] = [];

    for (const id of ids) {
      const coin = byId.get(id);
      if (!coin) continue;
      const meta = CRYPTO_META[id];
      const prices = coin.sparkline_in_7d?.price;
      const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);

      quotes.push({
        name: meta?.name || id,
        symbol: meta?.symbol || id.toUpperCase(),
        price: coin.current_price ?? 0,
        change: coin.price_change_percentage_24h ?? 0,
        sparkline,
      });
    }

    if (quotes.every(q => q.price === 0)) {
      throw new Error('CoinGecko returned all-zero prices');
    }

    return quotes.length > 0 ? { quotes } : null;
  });

  if (result) {
    if (fallbackCryptoCache.size > 50) fallbackCryptoCache.clear();
    fallbackCryptoCache.set(cacheKey, { data: result, ts: Date.now() });
  }
  return result || fallbackCryptoCache.get(cacheKey)?.data || { quotes: [] };
  } catch {
    return fallbackCryptoCache.get(cacheKey)?.data || { quotes: [] };
  }
}
