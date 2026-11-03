/**
 * ListClimateAnomalies RPC -- reads seeded climate data from Railway seed cache.
 * All external Open-Meteo API calls happen in the climate seed scripts on Railway.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';
import { CLIMATE_ANOMALIES_KEY } from '../../../_shared/cache-keys';

export const listClimateAnomalies: ClimateServiceHandler['listClimateAnomalies'] = async (
  _ctx: ServerContext,
  _req: ListClimateAnomaliesRequest,
): Promise<ListClimateAnomaliesResponse> => {
  const result = await readRequiredSeed(CLIMATE_ANOMALIES_KEY, value => {
    const data = value as ListClimateAnomaliesResponse | null;
    return data && Array.isArray(data.anomalies) ? data : undefined;
  });
  return { anomalies: result.anomalies, pagination: result.pagination };
};
