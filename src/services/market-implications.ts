import { toApiUrl } from '@/services/runtime';
import { getHydratedData } from '@/services/bootstrap';

export interface MarketImplicationCard {
  ticker: string;
  name: string;
  direction: string;
  timeframe: string;
  confidence: string;
  title: string;
  narrative: string;
  riskCaveat: string;
  driver: string;
}

export interface MarketImplicationsData {
  cards: MarketImplicationCard[];
  degraded: boolean;
  emptyReason: string;
  generatedAt: string;
}

// Cache keyed by frameworkId ('' = no framework). Avoids 100 users × 1 API call
// when all have the same framework selected — server serves from its own Redis key.
const cache = new Map<string, { data: MarketImplicationsData; cachedAt: number }>();
const CACHE_TTL = 10 * 60 * 1000;

export function getCachedMarketImplications(): MarketImplicationsData | null {
  return cache.get('')?.data ?? null;
}

export async function fetchMarketImplications(frameworkId = ''): Promise<MarketImplicationsData | null> {
  const now = Date.now();
  const cached = cache.get(frameworkId);
  if (cached && !cached.data.degraded && now - cached.cachedAt < CACHE_TTL) return cached.data;

  if (!frameworkId) {
    const hydrated = getHydratedData('marketImplications') as MarketImplicationsData | undefined;
    if (hydrated?.cards && Array.isArray(hydrated.cards) && hydrated.cards.length > 0 && !hydrated.degraded) {
      cache.set('', { data: hydrated, cachedAt: now });
      return hydrated;
    }
  }

  try {
    const url = new URL(toApiUrl('/api/intelligence/v1/list-market-implications'));
    if (frameworkId) url.searchParams.set('frameworkId', frameworkId);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return cached?.data ?? null;

    const raw = (await resp.json()) as MarketImplicationsData;
    if (!Array.isArray(raw.cards)) return cached?.data ?? null;

    cache.set(frameworkId, { data: raw, cachedAt: now });
    return raw;
  } catch {
    return cached?.data ?? null;
  }
}
