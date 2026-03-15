import type {
  ServerContext,
  GetShippingRatesRequest,
  GetShippingRatesResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'supply_chain:shipping:v2';

export async function getShippingRates(
  _ctx: ServerContext,
  _req: GetShippingRatesRequest,
): Promise<GetShippingRatesResponse> {
  try {
    const result = await getCachedJson(REDIS_CACHE_KEY, true) as GetShippingRatesResponse | null;
    return result ?? { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
