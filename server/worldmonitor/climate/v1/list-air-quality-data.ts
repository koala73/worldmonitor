import type {
  ClimateServiceHandler,
  ListAirQualityDataRequest,
  ListAirQualityDataResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import {
  normalizeAirQualityFetchedAt,
  normalizeAirQualityStations,
} from '../../../_shared/air-quality-stations';
import { CLIMATE_AIR_QUALITY_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

export const listAirQualityData: ClimateServiceHandler['listAirQualityData'] = async (
  ctx: ServerContext,
  _req: ListAirQualityDataRequest,
): Promise<ListAirQualityDataResponse> => {
  const payload = (await getCachedJson(CLIMATE_AIR_QUALITY_KEY, true)) as Record<string, unknown> | null;
  const sourceStations = payload?.stations ?? payload?.alerts;
  if (!Array.isArray(sourceStations)) {
    return markNoStoreFallbackResponse(ctx.request, { stations: [], fetchedAt: 0 });
  }
  return {
    stations: normalizeAirQualityStations(sourceStations),
    fetchedAt: normalizeAirQualityFetchedAt(payload),
  };
};
