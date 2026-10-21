/**
 * RPC: ListCryptoSectors -- reads seeded crypto sector data from Railway seed cache.
 */

import type {
  ServerContext,
  ListCryptoSectorsRequest,
  ListCryptoSectorsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'market:crypto-sectors:v1';

export async function listCryptoSectors(
  ctx: ServerContext,
  _req: ListCryptoSectorsRequest,
): Promise<ListCryptoSectorsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { sectors: Array<{ id: string; name: string; change: number }> } | null;
    if (!Array.isArray(seedData?.sectors)) return markNoStoreFallbackResponse(ctx.request, { sectors: [] });
    return { sectors: seedData.sectors };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { sectors: [] });
  }
}
