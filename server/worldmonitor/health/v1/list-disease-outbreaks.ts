import type {
  HealthServiceHandler,
  ServerContext,
  ListDiseaseOutbreaksRequest,
  ListDiseaseOutbreaksResponse,
} from '../../../../src/generated/server/worldmonitor/health/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'health:disease-outbreaks:v1';

export const listDiseaseOutbreaks: HealthServiceHandler['listDiseaseOutbreaks'] = async (
  _ctx: ServerContext,
  _req: ListDiseaseOutbreaksRequest,
): Promise<ListDiseaseOutbreaksResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true)) as ListDiseaseOutbreaksResponse | null;
  return data ?? { outbreaks: [], fetchedAt: 0 };
};
