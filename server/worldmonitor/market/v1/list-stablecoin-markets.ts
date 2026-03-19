/**
 * RPC: ListStablecoinMarkets -- reads seeded stablecoin data from Railway seed cache.
 * All external CoinGecko calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:stablecoins:v1';

const EMPTY_RESPONSE: ListStablecoinMarketsResponse = {
  timestamp: new Date().toISOString(),
  summary: {
    totalMarketCap: 0,
    totalVolume24h: 0,
    coinCount: 0,
    depeggedCount: 0,
    healthStatus: 'UNAVAILABLE',
  },
  stablecoins: [],
};

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  _req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListStablecoinMarketsResponse | null;
    return seedData || EMPTY_RESPONSE;
  } catch {
    return EMPTY_RESPONSE;
  }
}
