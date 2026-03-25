/**
 * RPC: ListEtfFlows -- reads seeded BTC spot ETF data from Railway seed cache.
 * All external Yahoo Finance calls happen in ais-relay.cjs on Railway.
 */

import type {
  ServerContext,
  ListEtfFlowsRequest,
  ListEtfFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:etf-flows:v1';

const EMPTY_RESPONSE: ListEtfFlowsResponse = {
  timestamp: new Date().toISOString(),
  summary: {
    etfCount: 0,
    totalVolume: 0,
    totalEstFlow: 0,
    netDirection: 'UNAVAILABLE',
    inflowCount: 0,
    outflowCount: 0,
  },
  etfs: [],
  rateLimited: false,
};

export async function listEtfFlows(
  _ctx: ServerContext,
  _req: ListEtfFlowsRequest,
): Promise<ListEtfFlowsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListEtfFlowsResponse | null;
    return seedData || EMPTY_RESPONSE;
  } catch {
    return EMPTY_RESPONSE;
  }
}
