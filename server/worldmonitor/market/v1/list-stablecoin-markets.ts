/**
 * RPC: ListStablecoinMarkets
 * Fetches stablecoin peg health data from CoinGecko.
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
  Stablecoin,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray, fetchCryptoMarkets } from './_shared';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import stablecoinConfig from '../../../../shared/stablecoins.json';

const REDIS_CACHE_KEY = 'market:stablecoins:v1';
const REDIS_CACHE_TTL = 600; // 10 min — CoinGecko rate-limited

// ========================================================================
// Constants and cache
// ========================================================================

const DEFAULT_STABLECOIN_IDS = stablecoinConfig.ids.join(',');

let stablecoinCache: ListStablecoinMarketsResponse | null = null;
let stablecoinCacheTimestamp = 0;
const STABLECOIN_CACHE_TTL = 480_000; // 8 minutes
const SEED_FRESHNESS_MS = 45 * 60 * 1000; // 45 minutes

// ========================================================================
// Handler
// ========================================================================

async function trySeededStablecoins(): Promise<ListStablecoinMarketsResponse | null> {
  try {
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(REDIS_CACHE_KEY, true) as Promise<ListStablecoinMarketsResponse | null>,
      getCachedJson('seed-meta:market:stablecoins', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.stablecoins?.length) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    if (isFresh) return seedData;
    if (!process.env.SEED_FALLBACK_STABLECOINS) return seedData;
    return null;
  } catch {
    return null;
  }
}

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  const now = Date.now();
  if (stablecoinCache && now - stablecoinCacheTimestamp < STABLECOIN_CACHE_TTL) {
    return stablecoinCache;
  }

  // Try Railway-seeded data first
  const seeded = await trySeededStablecoins();
  if (seeded) {
    stablecoinCache = seeded;
    stablecoinCacheTimestamp = now;
    return seeded;
  }

  const parsedCoins = parseStringArray(req.coins);
  const coins = parsedCoins.length > 0
    ? parsedCoins.filter(c => /^[a-z0-9-]+$/.test(c)).join(',')
    : DEFAULT_STABLECOIN_IDS;

  const redisKey = `${REDIS_CACHE_KEY}:${coins}`;

  try {
  const result = await cachedFetchJson<ListStablecoinMarketsResponse>(redisKey, REDIS_CACHE_TTL, async () => {
    const coinIds = coins.split(',');
    const data = await fetchCryptoMarkets(coinIds);

    if (data.length === 0 && stablecoinCache) {
      console.warn('[stablecoin] empty response — returning stale cache');
      return null;
    }

    const stablecoins: Stablecoin[] = data.map(coin => {
      const price = coin.current_price || 0;
      const deviation = Math.abs(price - 1.0);
      let pegStatus: string;
      if (deviation <= 0.005) pegStatus = 'ON PEG';
      else if (deviation <= 0.01) pegStatus = 'SLIGHT DEPEG';
      else pegStatus = 'DEPEGGED';

      return {
        id: coin.id,
        symbol: (coin.symbol || '').toUpperCase(),
        name: coin.name || coin.id,
        price,
        deviation: +(deviation * 100).toFixed(3),
        pegStatus,
        marketCap: coin.market_cap || 0,
        volume24h: coin.total_volume || 0,
        change24h: coin.price_change_percentage_24h || 0,
        change7d: coin.price_change_percentage_7d_in_currency || 0,
        image: coin.image || '',
      };
    });

    if (stablecoins.length === 0) return null;

    const totalMarketCap = stablecoins.reduce((sum, c) => sum + c.marketCap, 0);
    const totalVolume24h = stablecoins.reduce((sum, c) => sum + c.volume24h, 0);
    const depeggedCount = stablecoins.filter(c => c.pegStatus === 'DEPEGGED').length;

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
  });

  if (result) {
    stablecoinCache = result;
    stablecoinCacheTimestamp = now;
  }

  return result || stablecoinCache || {
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
  } catch {
    return stablecoinCache || {
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
  }
}
