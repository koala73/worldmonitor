/**
 * RPC: ListGulfQuotes -- reads seeded GCC market data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListGulfQuotesRequest,
  ListGulfQuotesResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_CACHE_KEY = 'market:gulf-quotes:v1';

export async function listGulfQuotes(
  ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListGulfQuotesResponse | null;
    return Array.isArray(seedData?.quotes) ? seedData : markNoStoreFallbackResponse(ctx.request, { quotes: [], rateLimited: false });
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { quotes: [], rateLimited: false });
  }
}
