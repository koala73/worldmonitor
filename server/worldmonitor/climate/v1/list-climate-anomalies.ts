/**
 * ListClimateAnomalies RPC -- reads seeded climate data from Railway seed cache.
 * All external Open-Meteo API calls happen in the climate seed scripts on Railway.
 */

import {
  ApiError,
  type ClimateServiceHandler,
  type ServerContext,
  type ListClimateAnomaliesRequest,
  type ListClimateAnomaliesResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { logCacheReadError, readCachedJson } from '../../../_shared/redis';
import { CLIMATE_ANOMALIES_KEY } from '../../../_shared/cache-keys';

export const listClimateAnomalies: ClimateServiceHandler['listClimateAnomalies'] = async (
  _ctx: ServerContext,
  _req: ListClimateAnomaliesRequest,
): Promise<ListClimateAnomaliesResponse> => {
  const cached = await readCachedJson(CLIMATE_ANOMALIES_KEY, true);
  if (cached.status === 'error') logCacheReadError(CLIMATE_ANOMALIES_KEY, cached.error);
  const result = cached.status === 'hit' ? cached.value as ListClimateAnomaliesResponse | null : null;
  if (!result || !Array.isArray(result.anomalies)) {
    throw new ApiError(503, 'Climate anomalies cache unavailable', '');
  }
  return { anomalies: result.anomalies, pagination: result.pagination };
};
