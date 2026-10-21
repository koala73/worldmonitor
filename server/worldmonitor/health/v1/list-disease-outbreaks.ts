import type {
  HealthServiceHandler,
  ServerContext,
  ListDiseaseOutbreaksRequest,
  ListDiseaseOutbreaksResponse,
} from '../../../../src/generated/server/worldmonitor/health/v1/service_server';

import { ApiError } from '../../../../src/generated/server/worldmonitor/health/v1/service_server';
import { logCacheReadError, readCachedJson } from '../../../_shared/redis';

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
  const cached = await readCachedJson(REDIS_KEY, true);
  if (cached.status === 'error') logCacheReadError(REDIS_KEY, cached.error);
  const data = cached.status === 'hit' ? cached.value as Partial<ListDiseaseOutbreaksResponse> | null : null;
  if (!data || !Array.isArray(data.outbreaks)
    || typeof data.fetchedAt !== 'number' || !Number.isFinite(data.fetchedAt) || data.fetchedAt <= 0) {
    throw new ApiError(503, 'Disease outbreaks cache unavailable', '');
  }
  return {
    outbreaks: data.outbreaks,
    fetchedAt: data.fetchedAt,
    alertLevelMethodologyVersion: data.alertLevelMethodologyVersion ?? FALLBACK_METHODOLOGY_VERSION,
  };
};
