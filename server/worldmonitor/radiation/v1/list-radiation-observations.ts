import type {
  ListRadiationObservationsRequest,
  ListRadiationObservationsResponse,
  RadiationServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/radiation/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'radiation:observations:v1';
const DEFAULT_MAX_ITEMS = 18;
const MAX_ITEMS_LIMIT = 25;

// All fetch/parse/scoring logic lives in the Railway seed script
// (scripts/seed-radiation-watch.mjs). This handler reads pre-built
// data from Redis only (gold standard: Vercel reads, Railway writes).


function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}


function emptyResponse(): ListRadiationObservationsResponse {
  return {
    observations: [],
    fetchedAt: Date.now(),
    epaCount: 0,
    safecastCount: 0,
    anomalyCount: 0,
    elevatedCount: 0,
    spikeCount: 0,
    corroboratedCount: 0,
    lowConfidenceCount: 0,
    conflictingCount: 0,
    convertedFromCpmCount: 0,
  };
}

export const listRadiationObservations: RadiationServiceHandler['listRadiationObservations'] = async (
  _ctx: ServerContext,
  req: ListRadiationObservationsRequest,
): Promise<ListRadiationObservationsResponse> => {
  const maxItems = clampMaxItems(req.maxItems);
  try {
    const data = await getCachedJson(REDIS_CACHE_KEY, true) as ListRadiationObservationsResponse | null;
    if (!data?.observations?.length) return emptyResponse();
    return {
      ...data,
      observations: (data.observations ?? []).slice(0, maxItems),
    };
  } catch {
    return emptyResponse();
  }
};
