/**
 * RPC: ListCryptoSectors -- reads seeded crypto sector data from Railway seed cache.
 */

import type {
  ServerContext,
  ListCryptoSectorsRequest,
  ListCryptoSectorsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:crypto-sectors:v1';

export async function listCryptoSectors(
  _ctx: ServerContext,
  _req: ListCryptoSectorsRequest,
): Promise<ListCryptoSectorsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as { sectors: Array<{ id: string; name: string; change: number }> } | null;
    if (!seedData?.sectors?.length) return { sectors: [] };
    return { sectors: seedData.sectors };
  } catch {
    return { sectors: [] };
  }
}
