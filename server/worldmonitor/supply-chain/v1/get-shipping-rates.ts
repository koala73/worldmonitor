import type {
  ServerContext,
  GetShippingRatesRequest,
  GetShippingRatesResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'supply_chain:shipping:v2';
const REDIS_CACHE_TTL = 3600;

export async function getShippingRates(
  _ctx: ServerContext,
  _req: GetShippingRatesRequest,
): Promise<GetShippingRatesResponse> {
  try {
    const result = await cachedFetchJson<GetShippingRatesResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => null,
    );

    return result ?? { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
