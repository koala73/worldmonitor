/**
 * RPC: ListDefiTokens -- reads seeded DeFi token data from Railway seed cache.
 */

import type {
  ServerContext,
  ListDefiTokensRequest,
  ListDefiTokensResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:defi-tokens:v1';

type TokenSeedEntry = { name: string; symbol: string; price: number; change24h: number; change7d: number };

export async function listDefiTokens(
  _ctx: ServerContext,
  _req: ListDefiTokensRequest,
): Promise<ListDefiTokensResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { tokens: TokenSeedEntry[] } | null;
    if (!seedData?.tokens?.length) return { tokens: [] };
    const tokens: CryptoQuote[] = seedData.tokens.map(t => ({
      name: t.name,
      symbol: t.symbol,
      price: t.price,
      change: t.change24h,
      change7d: t.change7d,
      sparkline: [],
    }));
    return { tokens };
  } catch {
    return { tokens: [] };
  }
}
