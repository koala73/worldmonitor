/**
 * RPC: GetSectorSummary
 * Fetches sector ETF performance from Finnhub.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
  SectorPerformance,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { fetchFinnhubQuote, fetchYahooQuotesBatch } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:sectors:v1';
const REDIS_CACHE_TTL = 180; // 3 min — Finnhub rate-limited

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  const apiKey = process.env.FINNHUB_API_KEY;

  try {
  const result = await cachedFetchJson<GetSectorSummaryResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
    const sectorSymbols = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
    const sectors: SectorPerformance[] = [];

    if (apiKey) {
      const results = await Promise.all(
        sectorSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
      );
      for (const r of results) {
        if (r) sectors.push({ symbol: r.symbol, name: r.symbol, change: r.changePercent });
      }
    }

    // Fallback to Yahoo Finance when Finnhub key is missing or returned nothing
    if (sectors.length === 0) {
      const batch = await fetchYahooQuotesBatch(sectorSymbols);
      for (const s of sectorSymbols) {
        const yahoo = batch.results.get(s);
        if (yahoo) sectors.push({ symbol: s, name: s, change: yahoo.change });
      }
    }

    return sectors.length > 0 ? { sectors } : null;
  });

  return result || { sectors: [] };
  } catch {
    return { sectors: [] };
  }
}
