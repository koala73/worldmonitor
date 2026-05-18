import type {
  HealthServiceHandler,
  ServerContext,
  ListDiseaseOutbreaksRequest,
  ListDiseaseOutbreaksResponse,
} from '../../../../src/generated/server/worldmonitor/health/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'health:disease-outbreaks:v1';

// Transitional read tolerance: cached payloads written before the
// alertLevelMethodologyVersion field was added (or by an older seeder
// revision) will not carry the field. Defaulting to 'v1' matches the
// initial published version in scripts/_disease-outbreaks-helpers.mjs,
// so old caches keep validating against the new proto contract until
// the next seed publish stamps the field explicitly.
const FALLBACK_METHODOLOGY_VERSION = 'v1';

export const listDiseaseOutbreaks: HealthServiceHandler['listDiseaseOutbreaks'] = async (
  _ctx: ServerContext,
  _req: ListDiseaseOutbreaksRequest,
): Promise<ListDiseaseOutbreaksResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true)) as Partial<ListDiseaseOutbreaksResponse> | null;
  return {
    outbreaks: data?.outbreaks ?? [],
    fetchedAt: data?.fetchedAt ?? 0,
    alertLevelMethodologyVersion: data?.alertLevelMethodologyVersion ?? FALLBACK_METHODOLOGY_VERSION,
  };
};
