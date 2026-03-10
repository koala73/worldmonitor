/**
 * ListPredictionMarkets RPC -- proxies the Gamma API for Polymarket prediction
 * markets and the Kalshi API for Kalshi markets.
 *
 * Critical constraint: Gamma API is behind Cloudflare JA3 fingerprint detection
 * that blocks server-side TLS connections. The handler tries the fetch and
 * gracefully returns empty on failure. JA3 blocking is expected, not an error.
 */

import {
  MarketSource,
  type PredictionServiceHandler,
  type ServerContext,
  type ListPredictionMarketsRequest,
  type ListPredictionMarketsResponse,
  type PredictionMarket,
} from '../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

import { CHROME_UA, clampInt } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'prediction:markets:v1';
const REDIS_CACHE_TTL = 600; // 10 min
const BOOTSTRAP_KEY = 'prediction:markets-bootstrap:v1';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_CACHE_KEY = 'prediction:kalshi:v1';
const FETCH_TIMEOUT = 8000;

// ---------- Internal Gamma API types ----------

interface GammaMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
  endDate?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  markets?: GammaMarket[];
  closed?: boolean;
  endDate?: string;
}

// ---------- Internal Kalshi API types ----------

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_sub_title?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  close_time?: string;
  status?: string;
  market_type?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title: string;
  category?: string;
  markets?: KalshiMarket[];
}

// ---------- Bootstrap types ----------

interface BootstrapMarket {
  title: string;
  yesPrice: number;
  volume: number;
  url: string;
  endDate?: string;
  source?: 'kalshi' | 'polymarket';
}

interface BootstrapData {
  geopolitical?: BootstrapMarket[];
  tech?: BootstrapMarket[];
  finance?: BootstrapMarket[];
}

const KALSHI_CATEGORIES = ['economy', 'fed', 'inflation', 'markets', 'business'];

// ---------- Helpers ----------

/** Parse the yes-side price from a Gamma market's outcomePrices JSON string (0-1 scale). */
function parseYesPrice(market: GammaMarket): number {
  try {
    const pricesStr = market.outcomePrices;
    if (pricesStr) {
      const prices: string[] = JSON.parse(pricesStr);
      if (prices.length >= 1) {
        const parsed = parseFloat(prices[0]!);
        if (!isNaN(parsed)) return parsed; // 0-1 scale for proto
      }
    }
  } catch {
    /* keep default */
  }
  return 0.5;
}

/** Map a GammaEvent to a proto PredictionMarket (picks top market by volume). */
function mapEvent(event: GammaEvent, category: string): PredictionMarket {
  const topMarket = event.markets?.[0];
  const endDateStr = topMarket?.endDate ?? event.endDate;
  const closesAtMs = endDateStr ? Date.parse(endDateStr) : 0;

  return {
    id: event.id || '',
    title: topMarket?.question || event.title,
    yesPrice: topMarket ? parseYesPrice(topMarket) : 0.5,
    volume: event.volume ?? 0,
    url: `https://polymarket.com/event/${event.slug}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: category || '',
    source: MarketSource.MARKET_SOURCE_POLYMARKET,
    openInterest: 0,
  };
}

/** Map a GammaMarket to a proto PredictionMarket. */
function mapMarket(market: GammaMarket): PredictionMarket {
  const closesAtMs = market.endDate ? Date.parse(market.endDate) : 0;
  return {
    id: market.slug || '',
    title: market.question,
    yesPrice: parseYesPrice(market),
    volume: (market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0)) || 0,
    url: `https://polymarket.com/market/${market.slug}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: '',
    source: MarketSource.MARKET_SOURCE_POLYMARKET,
    openInterest: 0,
  };
}

/** Map a KalshiMarket to a proto PredictionMarket. Caller must pre-filter for active binary markets. */
function mapKalshiMarket(market: KalshiMarket, category: string): PredictionMarket {
  const closesAtMs = market.close_time ? Date.parse(market.close_time) : 0;
  const yesPrice = parseFloat(market.last_price_dollars || '0.5');
  return {
    id: market.ticker,
    title: market.yes_sub_title || market.title,
    yesPrice: Number.isFinite(yesPrice) ? yesPrice : 0.5,
    volume: parseFloat(market.volume_fp || '0'),
    url: `https://kalshi.com/markets/${market.ticker}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: category || '',
    source: MarketSource.MARKET_SOURCE_KALSHI,
    openInterest: parseFloat(market.open_interest_fp || '0'),
  };
}

/** Fetch open markets from the Kalshi API. Returns null on failure. */
async function fetchKalshiMarkets(): Promise<PredictionMarket[] | null> {
  try {
    const result = await cachedFetchJson<PredictionMarket[]>(
      KALSHI_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const response = await fetch(
          `${KALSHI_BASE}/events?status=open&with_nested_markets=true&limit=40`,
          {
            headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          },
        );
        if (!response.ok) return null;

        const data = (await response.json()) as { events: KalshiEvent[]; cursor: string };
        const markets: PredictionMarket[] = [];
        for (const event of data.events) {
          if (!event.markets) continue;
          // Pick highest-volume active binary market from each event (single pass)
          let topMarket: KalshiMarket | null = null;
          let topVol = 0;
          for (const m of event.markets) {
            if (m.market_type !== 'binary' || m.status !== 'active') continue;
            const vol = parseFloat(m.volume_fp || '0');
            if (vol > topVol) { topMarket = m; topVol = vol; }
          }
          if (topMarket) markets.push(mapKalshiMarket(topMarket, event.category || ''));
        }
        return markets.length > 0 ? markets : null;
      },
    );
    return result || null;
  } catch {
    return null;
  }
}

// ---------- RPC ----------

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    const limit = clampInt(req.pageSize, 50, 1, 100);
    const includeKalshi = !req.category || KALSHI_CATEGORIES.includes(req.category);

    // Try Railway-seeded bootstrap data first (no Gamma API call needed)
    if (!req.query) {
      try {
        const bootstrap = await getCachedJson(BOOTSTRAP_KEY) as BootstrapData | null;
        if (bootstrap) {
          const isTech = req.category && ['ai', 'tech', 'crypto', 'science'].includes(req.category);
          const isFinance = req.category && KALSHI_CATEGORIES.includes(req.category);
          const variant = isTech ? bootstrap.tech
            : isFinance ? (bootstrap.finance || bootstrap.geopolitical)
            : bootstrap.geopolitical;
          if (variant && variant.length > 0) {
            const markets: PredictionMarket[] = variant.slice(0, limit).map((m) => ({
              id: m.url?.split('/').pop() || '',
              title: m.title,
              yesPrice: (m.yesPrice ?? 50) / 100, // bootstrap stores 0-100, proto uses 0-1
              volume: m.volume ?? 0,
              url: m.url || '',
              closesAt: m.endDate ? Date.parse(m.endDate) : 0,
              category: req.category || '',
              source: m.source === 'kalshi' ? MarketSource.MARKET_SOURCE_KALSHI : MarketSource.MARKET_SOURCE_POLYMARKET,
              openInterest: 0,
            }));
            return { markets, pagination: undefined };
          }
        }
      } catch { /* bootstrap read failed, fall through */ }
    }

    // Fallback: fetch from Gamma API and Kalshi API in parallel
    // Only start Kalshi fetch when the category warrants it
    const kalshiFetch = includeKalshi ? fetchKalshiMarkets() : Promise.resolve(null);

    const gammaFetch = cachedFetchJson<PredictionMarket[]>(
      `${REDIS_CACHE_KEY}:${req.category || 'all'}:${req.query || ''}:${req.pageSize || 50}`,
      REDIS_CACHE_TTL,
      async () => {
        const useEvents = !!req.category;
        const endpoint = useEvents ? 'events' : 'markets';
        const params = new URLSearchParams({
          closed: 'false',
          active: 'true',
          archived: 'false',
          end_date_min: new Date().toISOString(),
          order: 'volume',
          ascending: 'false',
          limit: String(limit),
        });
        if (useEvents) {
          params.set('tag_slug', req.category);
        }

        const response = await fetch(
          `${GAMMA_BASE}/${endpoint}?${params}`,
          {
            headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
          },
        );
        if (!response.ok) return null;

        const data: unknown = await response.json();
        let markets: PredictionMarket[];
        if (useEvents) {
          markets = (data as GammaEvent[]).map((e) => mapEvent(e, req.category));
        } else {
          markets = (data as GammaMarket[]).map(mapMarket);
        }

        if (req.query) {
          const q = req.query.toLowerCase();
          markets = markets.filter((m) => m.title.toLowerCase().includes(q));
        }

        return markets.length > 0 ? markets : null;
      },
    );

    const [gammaResult, kalshiResult] = await Promise.allSettled([gammaFetch, kalshiFetch]);

    const polymarketMarkets = gammaResult.status === 'fulfilled' && gammaResult.value ? gammaResult.value : [];

    let filteredKalshi: PredictionMarket[] = [];
    if (includeKalshi) {
      const kalshiMarkets = kalshiResult.status === 'fulfilled' && kalshiResult.value ? kalshiResult.value : [];
      filteredKalshi = kalshiMarkets;
      if (req.query && kalshiMarkets.length > 0) {
        const q = req.query.toLowerCase();
        filteredKalshi = kalshiMarkets.filter((m) => m.title.toLowerCase().includes(q));
      }
    }

    const allMarkets = [...polymarketMarkets, ...filteredKalshi];

    allMarkets.sort((a, b) => b.volume - a.volume);
    const finalMarkets = allMarkets.slice(0, limit);

    return finalMarkets.length > 0
      ? { markets: finalMarkets, pagination: undefined }
      : { markets: [], pagination: undefined };
  } catch {
    return { markets: [], pagination: undefined };
  }
};
