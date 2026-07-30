import type {
  ListSanctionsPressureRequest,
  ListSanctionsPressureResponse,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { isCallerPremium } from '../../../_shared/premium-check';

const REDIS_CACHE_KEY = 'sanctions:pressure:v1';
const DEFAULT_MAX_ITEMS = 25;
const MAX_ITEMS_LIMIT = 60;

// All fetch/parse/scoring logic lives in the Railway seed script
// (scripts/seed-sanctions-pressure.mjs). This handler reads pre-built
// data from Redis only (gold standard: Vercel reads, Railway writes).

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}

function emptyResponse(): ListSanctionsPressureResponse {
  return {
    entries: [],
    countries: [],
    programs: [],
    fetchedAt: '0',
    datasetDate: '0',
    totalCount: 0,
    sdnCount: 0,
    consolidatedCount: 0,
    newEntryCount: 0,
    vesselCount: 0,
    aircraftCount: 0,
  };
}

export const listSanctionsPressure: SanctionsServiceHandler['listSanctionsPressure'] = async (
  ctx: ServerContext,
  req: ListSanctionsPressureRequest,
): Promise<ListSanctionsPressureResponse> => {
  const isPro = await isCallerPremium(ctx.request);
  if (!isPro) return emptyResponse();

  const maxItems = clampMaxItems(req.maxItems);
  try {
    const data = await getCachedJson(REDIS_CACHE_KEY, true) as ListSanctionsPressureResponse & { _state?: unknown } | null;
    if (!data?.totalCount) return emptyResponse();
    const { _state: _discarded, ...rest } = data;
    return {
      ...rest,
      entries: (data.entries ?? []).slice(0, maxItems),
    };
  } catch {
    return emptyResponse();
  }
};
