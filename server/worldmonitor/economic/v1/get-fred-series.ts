/**
 * RPC: getFredSeries -- reads seeded FRED time series data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse, setResponseHeader } from '../../../_shared/response-headers';
import { ALLOWED_FRED_SERIES, applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';

export async function getFredSeries(
  ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  const seriesId = (req.seriesId ?? '').trim().toUpperCase();
  if (!ALLOWED_FRED_SERIES.has(seriesId)) {
    setResponseHeader(ctx.request, 'Cache-Control', 'no-store');
    throw new ValidationError([{ field: 'series_id', description: 'Unsupported FRED series ID' }]);
  }
  try {
    const seedKey = fredSeedKey(seriesId);
    const result = await getCachedJson(seedKey, true) as GetFredSeriesResponse | null;
    if (!result?.series) return markNoStoreFallbackResponse(ctx.request, { series: undefined });
    const limit = normalizeFredLimit(req.limit);
    return { series: applyFredObservationLimit(result.series, limit) };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { series: undefined });
  }
}
