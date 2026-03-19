/**
 * RPC: getTradeRestrictions -- reads seeded WTO MFN baseline overview data from Railway seed cache.
 * All external WTO API calls happen in seed-supply-chain-trade.mjs on Railway.
 */
import type {
  ServerContext,
  GetTradeRestrictionsRequest,
  GetTradeRestrictionsResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'trade:restrictions:v1:tariff-overview:50';

export async function getTradeRestrictions(
  _ctx: ServerContext,
  req: GetTradeRestrictionsRequest,
): Promise<GetTradeRestrictionsResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetTradeRestrictionsResponse | null;
    if (!result?.restrictions?.length) {
      return { restrictions: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
    }
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));
    return {
      restrictions: result.restrictions.slice(0, limit),
      fetchedAt: result.fetchedAt || new Date().toISOString(),
      upstreamUnavailable: false,
    };
  } catch {
    return { restrictions: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
