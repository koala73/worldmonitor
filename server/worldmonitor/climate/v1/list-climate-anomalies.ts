/**
 * ListClimateAnomalies RPC -- reads seeded climate data from Railway seed cache.
 * All external Open-Meteo API calls happen in seed-climate.mjs on Railway.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'climate:anomalies:v1';

export const listClimateAnomalies: ClimateServiceHandler['listClimateAnomalies'] = async (
  _ctx: ServerContext,
  _req: ListClimateAnomaliesRequest,
): Promise<ListClimateAnomaliesResponse> => {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as ListClimateAnomaliesResponse | null;
    return { anomalies: result?.anomalies || [], pagination: undefined };
  } catch {
    return { anomalies: [], pagination: undefined };
  }
};
