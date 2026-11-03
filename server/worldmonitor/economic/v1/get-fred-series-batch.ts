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
import { ALLOWED_FRED_SERIES, applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';

export async function getFredSeriesBatch(
  _ctx: ServerContext,
  req: GetFredSeriesBatchRequest,
): Promise<GetFredSeriesBatchResponse> {
  try {
    const normalized = req.seriesIds
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ALLOWED_FRED_SERIES.has(id));
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
