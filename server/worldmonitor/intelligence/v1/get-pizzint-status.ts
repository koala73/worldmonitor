import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readCachedJson, logCacheReadError } from '../../../_shared/redis';
import { markNoCacheResponse, markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import pairs from '../../../../shared/gdelt-tension-pairs.json';

const SEED_KEY = 'intelligence:pizzint:seed:v1';
const TENSION_KEY = 'gdelt:bulk:dyad-tension:v1';

export async function getPizzintStatus(
  ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  // Recheck the source clock on every request; the route's slow cache tier
  // would otherwise keep numeric scores beyond the source freshness budget.
  if (req.includeGdelt) markNoCacheResponse(ctx.request);
  let failed = false;
  async function readKey(key: string): Promise<unknown> {
    try {
      const read = await readCachedJson(key, true);
      if (read.status === 'error') {
        logCacheReadError(key, read.error);
        failed = true;
      }
      return read.status === 'hit' ? read.value : null;
    } catch { failed = true; return null; }
  }
  const [pizza, tensions] = await Promise.all([
    readKey(SEED_KEY), req.includeGdelt ? readKey(TENSION_KEY) : null,
  ]);
  const seed = tensions as { updatedAt?: number; tensionPairs?: GetPizzintStatusResponse['tensionPairs'] } | null;
  const fresh = typeof seed?.updatedAt === 'number' && seed.updatedAt <= Date.now()
    && Date.now() - seed.updatedAt <= 45 * 60_000;
  const response: GetPizzintStatusResponse = {
    pizzint: (pizza as GetPizzintStatusResponse | null)?.pizzint,
    tensionPairs: fresh && Array.isArray(seed?.tensionPairs) ? seed.tensionPairs.filter(pair =>
      pair && pairs.some(config => config.id === pair.id)
      && Number.isFinite(pair.score) && pair.score >= 0 && pair.score <= 100
      && Number.isFinite(pair.changePercent)) : [],
  };
  return failed ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
