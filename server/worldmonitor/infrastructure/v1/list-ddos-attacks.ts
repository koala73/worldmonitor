/**
 * ListInternetDdosAttacks RPC -- reads seeded DDoS summary data from Railway seed cache.
 * All external Cloudflare Radar API calls happen in seed-internet-outages.mjs on Railway.
 */

import type {
  ServerContext,
  ListInternetDdosAttacksRequest,
  ListInternetDdosAttacksResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'cf:radar:ddos:v1';

export async function listInternetDdosAttacks(
  _ctx: ServerContext,
  _req: ListInternetDdosAttacksRequest,
): Promise<ListInternetDdosAttacksResponse> {
  try {
    const data = await getCachedJson(SEED_CACHE_KEY, true) as ListInternetDdosAttacksResponse | null;
    return {
      protocol: data?.protocol || [],
      vector: data?.vector || [],
      dateRangeStart: data?.dateRangeStart || '',
      dateRangeEnd: data?.dateRangeEnd || '',
      topTargetLocations: data?.topTargetLocations || [],
    };
  } catch {
    return { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] };
  }
}
