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

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  try {
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

    return { sectors };
  } catch {
    return { sectors: [] };
  }
}
