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
import { CRYPTO_META, fetchCoinGeckoMarkets } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:crypto:v1';
const REDIS_CACHE_TTL = 600; // 10 min — CoinGecko rate-limited

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const ids = req.ids.length > 0 ? req.ids : Object.keys(CRYPTO_META);

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

  return result || { quotes: [] };
  } catch {
    return { quotes: [] };
  }
}
