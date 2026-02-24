/**
 * ListPredictionMarkets RPC -- proxies the Gamma API for Polymarket prediction markets.
 *
 * Critical constraint: Gamma API is behind Cloudflare JA3 fingerprint detection
 * that blocks server-side TLS connections. The handler tries the fetch and
 * gracefully returns empty on failure -- identical to the existing api/polymarket.js
 * behavior. This is expected, not an error.
 */

import type {
  PredictionServiceHandler,
  ServerContext,
  ListPredictionMarketsRequest,
  ListPredictionMarketsResponse,
  PredictionMarket,
} from '../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'prediction:markets:v1';
const REDIS_CACHE_TTL = 300; // 5 min

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
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
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  markets?: GammaMarket[];
  closed?: boolean;
}

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
  // Pick the top market from the event (first one is typically highest volume)
  const topMarket = event.markets?.[0];

  return {
    id: event.id || '',
    title: topMarket?.question || event.title,
    yesPrice: topMarket ? parseYesPrice(topMarket) : 0.5,
    volume: event.volume ?? 0,
    url: `https://polymarket.com/event/${event.slug}`,
    closesAt: 0,
    category: category || '',
  };
}

/** Map a GammaMarket to a proto PredictionMarket. */
function mapMarket(market: GammaMarket): PredictionMarket {
  return {
    id: market.slug || '',
    title: market.question,
    yesPrice: parseYesPrice(market),
    volume: (market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0)) || 0,
    url: `https://polymarket.com/market/${market.slug}`,
    closesAt: 0,
    category: '',
  };
}

// ---------- RPC ----------

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    // Redis shared cache (cross-instance)
    const cacheKey = `${REDIS_CACHE_KEY}:${req.category || 'all'}:${req.query || ''}:${req.pagination?.pageSize || 50}`;
    const cached = (await getCachedJson(cacheKey)) as ListPredictionMarketsResponse | null;
    if (cached?.markets?.length) return cached;

    // Determine endpoint: events (with tag_slug) or markets
    const useEvents = !!req.category;
    const endpoint = useEvents ? 'events' : 'markets';

    // Build query params
    const limit = Math.max(1, Math.min(100, req.pagination?.pageSize || 50));
    const params = new URLSearchParams({
      closed: 'false',
      order: 'volume',
      ascending: 'false',
      limit: String(limit),
    });

    if (useEvents) {
      params.set('tag_slug', req.category);
    }

    // Fetch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let markets: PredictionMarket[];
    try {
      const response = await fetch(
        `${GAMMA_BASE}/${endpoint}?${params}`,
        {
          headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
          signal: controller.signal,
        },
      );
      clearTimeout(timer);

      if (!response.ok) {
        return { markets: [], pagination: undefined };
      }

      const data: unknown = await response.json();

      if (useEvents) {
        const events = data as GammaEvent[];
        markets = events.map((e) => mapEvent(e, req.category));
      } else {
        const rawMarkets = data as GammaMarket[];
        markets = rawMarkets.map(mapMarket);
      }
    } catch {
      clearTimeout(timer);
      // Expected: Cloudflare blocks server-side TLS connections
      return { markets: [], pagination: undefined };
    }

    // Optional query filter (case-insensitive title match)
    if (req.query) {
      const q = req.query.toLowerCase();
      markets = markets.filter((m) =>
        m.title.toLowerCase().includes(q),
      );
    }

    const result: ListPredictionMarketsResponse = { markets, pagination: undefined };
    if (markets.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    // Catch-all: return empty on ANY failure
    return { markets: [], pagination: undefined };
  }
};
