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

const SEED_CACHE_KEY = 'market:gulf-quotes:v1';

export async function listGulfQuotes(
  _ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListGulfQuotesResponse | null;
    return seedData || { quotes: [], rateLimited: false };
  } catch {
    return { quotes: [], rateLimited: false };
  }
}
