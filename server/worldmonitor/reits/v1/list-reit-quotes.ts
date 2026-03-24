/**
 * RPC: ListReitQuotes -- reads seeded REIT quote data + analytics from Redis.
 *
 * Data flow:
 *   seed-reit-quotes.mjs → Redis reits:quotes:v1 → this handler
 *   seed-reit-analytics.mjs → Redis reits:correlation:v1 → regime/rotation/briefing
 */

import type {
  ServerContext,
  ListReitQuotesRequest,
  ListReitQuotesResponse,
  ReitQuote,
} from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { parseStringArray, REDIS_KEYS } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

export async function listReitQuotes(
  _ctx: ServerContext,
  req: ListReitQuotesRequest,
): Promise<ListReitQuotesResponse> {
  const parsedSymbols = parseStringArray(req.symbols);

  try {
    // Load quotes
    const quotesData = await getCachedJson(REDIS_KEYS.quotes, true) as {
      quotes: ReitQuote[];
      stale: boolean;
      lastUpdated: string;
    } | null;

    // Load analytics (regime, rotation, briefing)
    const analyticsData = await getCachedJson(REDIS_KEYS.correlation, true) as {
      regime: string;
      sectorRotation: Array<{ sector: string; signal: string; reason: string }>;
      aiBriefing: string;
    } | null;

    if (!quotesData?.quotes?.length) {
      return {
        quotes: [],
        regime: 'REIT_REGIME_NEUTRAL' as any,
        aiBriefing: '',
        sectorRotation: [],
        stale: true,
        lastUpdated: '',
      };
    }

    let quotes = quotesData.quotes;

    // Filter by sector
    if (req.sector) {
      quotes = quotes.filter((q: ReitQuote) => q.sector === req.sector);
    }

    // Filter by market (us/china)
    if (req.market) {
      quotes = quotes.filter((q: ReitQuote) => q.market === req.market);
    }

    // Filter by specific symbols
    if (parsedSymbols.length > 0) {
      const symbolSet = new Set(parsedSymbols);
      quotes = quotes.filter((q: ReitQuote) => symbolSet.has(q.symbol));
    }

    // Map regime string to enum value
    const regimeMap: Record<string, number> = {
      REIT_REGIME_FAVORABLE: 1,
      REIT_REGIME_CAUTIOUS: 2,
      REIT_REGIME_STRESS: 3,
      REIT_REGIME_NEUTRAL: 4,
    };

    return {
      quotes,
      regime: (regimeMap[analyticsData?.regime || ''] || 4) as any,
      aiBriefing: analyticsData?.aiBriefing || '',
      sectorRotation: analyticsData?.sectorRotation || [],
      stale: quotesData.stale || false,
      lastUpdated: quotesData.lastUpdated || '',
    };
  } catch {
    return {
      quotes: [],
      regime: 'REIT_REGIME_NEUTRAL' as any,
      aiBriefing: '',
      sectorRotation: [],
      stale: true,
      lastUpdated: '',
    };
  }
}
