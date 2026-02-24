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
import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:stablecoins:v1';
const REDIS_CACHE_TTL = 180; // 3 min — CoinGecko rate-limited

// ========================================================================
// Constants and cache
// ========================================================================

const DEFAULT_STABLECOIN_IDS = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';

let stablecoinCache: ListStablecoinMarketsResponse | null = null;
let stablecoinCacheTimestamp = 0;
const STABLECOIN_CACHE_TTL = 120_000; // 2 minutes

// ========================================================================
// Types
// ========================================================================

interface CoinGeckoStablecoinItem {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency?: number;
  image: string;
}

// ========================================================================
// Handler
// ========================================================================

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  const now = Date.now();
  if (stablecoinCache && now - stablecoinCacheTimestamp < STABLECOIN_CACHE_TTL) {
    return stablecoinCache;
  }

  const coins = req.coins.length > 0
    ? req.coins.filter(c => /^[a-z0-9-]+$/.test(c)).join(',')
    : DEFAULT_STABLECOIN_IDS;

  // Redis shared cache (cross-instance)
  const redisKey = `${REDIS_CACHE_KEY}:${coins}`;
  const redisCached = (await getCachedJson(redisKey)) as ListStablecoinMarketsResponse | null;
  if (redisCached?.stablecoins?.length) {
    stablecoinCache = redisCached;
    stablecoinCacheTimestamp = now;
    return redisCached;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coins}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (resp.status === 429 && stablecoinCache) return stablecoinCache;
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);

    const data = (await resp.json()) as CoinGeckoStablecoinItem[];

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
        name: coin.name,
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

    const totalMarketCap = stablecoins.reduce((sum, c) => sum + c.marketCap, 0);
    const totalVolume24h = stablecoins.reduce((sum, c) => sum + c.volume24h, 0);
    const depeggedCount = stablecoins.filter(c => c.pegStatus === 'DEPEGGED').length;

    const result: ListStablecoinMarketsResponse = {
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

    stablecoinCache = result;
    stablecoinCacheTimestamp = now;
    setCachedJson(redisKey, result, REDIS_CACHE_TTL).catch(() => {});
    return result;
  } catch {
    if (stablecoinCache) return stablecoinCache;
    return {
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
