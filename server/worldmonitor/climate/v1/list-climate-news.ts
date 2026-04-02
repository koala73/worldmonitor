/**
 * ListClimateNews RPC -- reads seeded climate news data from Railway seed cache.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateNewsRequest,
  ListClimateNewsResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CLIMATE_NEWS_KEY } from '../../../_shared/cache-keys';

export const listClimateNews: ClimateServiceHandler['listClimateNews'] = async (
  _ctx: ServerContext,
  _req: ListClimateNewsRequest,
): Promise<ListClimateNewsResponse> => {
  try {
    const result = await getCachedJson(CLIMATE_NEWS_KEY, true) as ListClimateNewsResponse | null;
    return result ?? { items: [], fetchedAt: 0 };
  } catch {
    return { items: [], fetchedAt: 0 };
  }
};
