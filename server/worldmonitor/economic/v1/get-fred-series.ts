/**
 * RPC: getFredSeries -- reads seeded FRED time series data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';

export async function getFredSeries(
  _ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  try {
    const seedKey = fredSeedKey(req.seriesId);
    const result = await getCachedJson(seedKey, true) as GetFredSeriesResponse | null;
    if (!result?.series) return { series: undefined };
    const limit = normalizeFredLimit(req.limit);
    return { series: applyFredObservationLimit(result.series, limit) };
  } catch {
    return { series: undefined };
  }
}
