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

export const listAirQualityData: ClimateServiceHandler['listAirQualityData'] = async (
  _ctx: ServerContext,
  _req: ListAirQualityDataRequest,
): Promise<ListAirQualityDataResponse> => {
  const payload = (await getCachedJson(CLIMATE_AIR_QUALITY_KEY, true)) as Record<string, unknown> | null;
  const sourceStations = payload?.stations ?? payload?.alerts;
  return {
    stations: normalizeAirQualityStations(sourceStations),
    fetchedAt: normalizeAirQualityFetchedAt(payload),
  };
};
