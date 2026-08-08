import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY = 'intelligence:pizzint:seed:v1';

export async function getPizzintStatus(
  _ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  try {
    const result = await getCachedJson(SEED_KEY, true) as GetPizzintStatusResponse | null;
    if (!result?.pizzint) return { pizzint: undefined, tensionPairs: [] };
    return req.includeGdelt ? result : { pizzint: result.pizzint, tensionPairs: [] };
  } catch {
    return { pizzint: undefined, tensionPairs: [] };
  }
}
