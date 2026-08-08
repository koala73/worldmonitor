/**
 * RPC: ListStablecoinMarkets -- reads seeded stablecoin data from Railway seed cache.
 * Supports per-coin caching for efficient subset queries.
 * All external CoinGecko calls happen in ais-relay.cjs on Railway.
 * 
 * Redis Key Structure:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Key Pattern                      │ Description                 │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ market:stablecoins:v1            │ Legacy full payload         │
 * │ market:stablecoins:v1:ids        │ List of all coin IDs        │
 * │ market:stablecoins:v1:${id}      │ Individual coin data        │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * Benefits of per-coin keys:
 * 1. Cache efficiency: ?coins=tether reads only 1 key
 * 2. Better hit ratio: overlapping requests share cache
 * 3. Lower latency: smaller payloads
 * 
 * @see https://github.com/BitOpenCode/worldmonitor/issues/6321
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:stablecoins:v1';
const IDS_CACHE_KEY = 'market:stablecoins:v1:ids';
const COIN_KEY_PREFIX = 'market:stablecoins:v1:';

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

function buildResponse(stablecoins: any[]): ListStablecoinMarketsResponse {
  const totalMarketCap = stablecoins.reduce((sum: number, c: any) => sum + (c.marketCap || 0), 0);
  const totalVolume24h = stablecoins.reduce((sum: number, c: any) => sum + (c.volume24h || 0), 0);
  const depeggedCount = stablecoins.filter((c: any) => c.pegStatus === 'DEPEGGED').length;
  
  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalMarketCap,
      totalVolume24h,
      coinCount: stablecoins.length,
      depeggedCount,
      healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING',
    },
    stablecoins,
  };
}

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  try {
    // Get requested coin IDs from the request
    const coinIds = (req as any).coinIds as string[] | undefined;
    
    // Log request for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[Stablecoin] Request received:', {
        coinIds: coinIds?.length ? coinIds.join(',') : 'all',
      });
    }
    
    // If no specific coins requested, return all coins
    if (!coinIds || coinIds.length === 0) {
      // Get list of all coin IDs
      const allIds = await getCachedJson(IDS_CACHE_KEY, true) as string[] | null;
      
      if (allIds && Array.isArray(allIds) && allIds.length > 0) {
        // Read all coins by individual keys
        const coinKeys = allIds.map((id: string) => `${COIN_KEY_PREFIX}${id}`);
        const resultsMap = await getCachedJsonBatch(coinKeys);
        
        // Extract values from Map
        const stablecoins: any[] = [];
        for (const [key, value] of resultsMap) {
          if (value !== null && value !== undefined) {
            stablecoins.push(value);
          }
        }
        
        if (stablecoins.length > 0) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('[Stablecoin] Returning all coins from individual keys:', {
              count: stablecoins.length,
            });
          }
          return buildResponse(stablecoins);
        }
      }
      
      // Fallback to the legacy single key if per-coin cache is empty
      console.warn('[Stablecoin] Individual keys empty, falling back to legacy key');
      const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListStablecoinMarketsResponse | null;
      return seedData || EMPTY_RESPONSE;
    }
    
    // Read only requested coins
    const coinKeys = coinIds.map((id: string) => `${COIN_KEY_PREFIX}${id}`);
    const resultsMap = await getCachedJsonBatch(coinKeys);
    
    // Build response from fetched coins
    const stablecoins: any[] = [];
    for (let i = 0; i < coinIds.length; i++) {
      const key = coinKeys[i];
      const data = resultsMap.get(key);
      if (data !== null && data !== undefined) {
        stablecoins.push({ ...data, id: coinIds[i] });
      }
    }
    
    if (stablecoins.length === 0) {
      // Fallback to the legacy single key
      console.warn('[Stablecoin] Requested coins not found in individual keys, falling back to legacy key:', {
        requested: coinIds.join(','),
      });
      const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListStablecoinMarketsResponse | null;
      return seedData || EMPTY_RESPONSE;
    }
    
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[Stablecoin] Returning requested coins from individual keys:', {
        requested: coinIds.join(','),
        found: stablecoins.length,
      });
    }
    
    return buildResponse(stablecoins);
  } catch (error) {
    console.error('[Stablecoin] Error reading from Redis:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_RESPONSE;
  }
}

// ============================================================
// EXPORTS FOR TESTING
// ============================================================
export { EMPTY_RESPONSE };
export type { ListStablecoinMarketsResponse };