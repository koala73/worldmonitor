/**
 * RPC: ListAiTokens -- reads seeded AI token data from Railway seed cache.
 */

import type {
  ServerContext,
  ListAiTokensRequest,
  ListAiTokensResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'market:ai-tokens:v1';

type TokenSeedEntry = { name: string; symbol: string; price: number; change24h: number; change7d: number };

export async function listAiTokens(
  ctx: ServerContext,
  _req: ListAiTokensRequest,
): Promise<ListAiTokensResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { tokens: TokenSeedEntry[] } | null;
    if (!seedData?.tokens?.length) return markNoStoreFallbackResponse(ctx.request, { tokens: [] });
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
    return markNoStoreFallbackResponse(ctx.request, { tokens: [] });
  }
}
