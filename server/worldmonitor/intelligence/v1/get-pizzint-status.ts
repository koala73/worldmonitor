import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readCachedJson, logCacheReadError } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_KEY = 'intelligence:pizzint:seed:v1';

export async function getPizzintStatus(
  ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  try {
    const read = await readCachedJson(SEED_KEY, true);
    if (read.status === 'error') {
      logCacheReadError(SEED_KEY, read.error);
      return markNoStoreFallbackResponse(ctx.request, { pizzint: undefined, tensionPairs: [] });
    }
    const result = read.status === 'hit' ? read.value as GetPizzintStatusResponse | null : null;
    if (!result?.pizzint) return { pizzint: undefined, tensionPairs: [] };
    return req.includeGdelt ? result : { pizzint: result.pizzint, tensionPairs: [] };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { pizzint: undefined, tensionPairs: [] });
  }
}
