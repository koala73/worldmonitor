/**
 * RPC: ListCryptoQuotes -- reads seeded crypto data from Railway seed cache.
 * All external CoinGecko calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CRYPTO_META, parseStringArray } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:crypto:v1';

const SYMBOL_TO_ID = new Map(Object.entries(CRYPTO_META).map(([id, m]) => [m.symbol, id]));

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const parsedIds = parseStringArray(req.ids);
  const ids = parsedIds.length > 0 ? parsedIds : Object.keys(CRYPTO_META);

  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { quotes: CryptoQuote[] } | null;
    if (!seedData?.quotes?.length) return { quotes: [] };

    const allIds = new Set(ids);
    const filtered = allIds.size === 0
      ? seedData.quotes
      : seedData.quotes.filter((q) => allIds.has(SYMBOL_TO_ID.get(q.symbol) ?? ''));

    return { quotes: filtered };
  } catch {
    return { quotes: [] };
  }
}
