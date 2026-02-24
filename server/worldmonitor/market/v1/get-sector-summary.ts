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
import { fetchFinnhubQuote } from './_shared';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:sectors:v1';
const REDIS_CACHE_TTL = 180; // 3 min — Finnhub rate-limited

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  try {
    // Redis shared cache (cross-instance)
    const cached = (await getCachedJson(REDIS_CACHE_KEY)) as GetSectorSummaryResponse | null;
    if (cached?.sectors?.length) return cached;

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return { sectors: [] };

    // Sector ETF symbols
    const sectorSymbols = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
    const results = await Promise.all(
      sectorSymbols.map((s) => fetchFinnhubQuote(s, apiKey)),
    );

    const sectors: SectorPerformance[] = [];
    for (const r of results) {
      if (r) {
        sectors.push({
          symbol: r.symbol,
          name: r.symbol,
          change: r.changePercent,
        });
      }
    }

    const result: GetSectorSummaryResponse = { sectors };
    if (sectors.length > 0) {
      setCachedJson(REDIS_CACHE_KEY, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { sectors: [] };
  }
}
