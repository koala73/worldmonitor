/**
 * RPC: getFredSeriesBatch -- reads seeded FRED data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesBatchRequest,
  GetFredSeriesBatchResponse,
  FredSeries,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJsonBatch } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';
import { applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';

const ALLOWED_SERIES = new Set<string>([
  'WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS',
  'GDP', 'M2SL', 'DCOILWTICO', 'BAMLH0A0HYM2', 'ICSA', 'MORTGAGE30US',
  'GSCPI', // NY Fed Global Supply Chain Pressure Index (seeded by ais-relay, not FRED API)
  'T10Y3M', 'STLFSI4', // Economic Stress Index components (seeded by seed-economy.mjs)
  'DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS30', // yield curve tenors
  'BAMLC0A0CM', 'SOFR', // IG OAS spread + Secured Overnight Financing Rate (seeded by seed-economy.mjs)
  'ESTR', 'EURIBOR3M', 'EURIBOR6M', 'EURIBOR1Y', // ECB short rates (seeded by seed-ecb-short-rates.mjs)
]);

export async function getFredSeriesBatch(
  _ctx: ServerContext,
  req: GetFredSeriesBatchRequest,
): Promise<GetFredSeriesBatchResponse> {
  try {
    const normalized = req.seriesIds
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ALLOWED_SERIES.has(id));
    const limitedList = toUniqueSortedLimited(normalized, 20);
    const limit = normalizeFredLimit(req.limit);

    const keysById = new Map(limitedList.map((id) => [id, fredSeedKey(id)]));
    const cachedByKey = await getCachedJsonBatch([...keysById.values()], true);

    const results: Record<string, FredSeries> = {};
    for (const id of limitedList) {
      const cached = cachedByKey.get(keysById.get(id)!) as { series?: FredSeries } | undefined;
      if (cached?.series) results[id] = applyFredObservationLimit(cached.series, limit);
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
