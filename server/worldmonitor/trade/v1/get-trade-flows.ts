/**
 * RPC: getTradeFlows -- reads seeded WTO trade flow data from Railway seed cache.
 * All external WTO API calls happen in seed-supply-chain-trade.mjs on Railway.
 */
import type {
  ServerContext,
  GetTradeFlowsRequest,
  GetTradeFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'trade:flows:v1';

function isValidCode(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

export async function getTradeFlows(
  _ctx: ServerContext,
  req: GetTradeFlowsRequest,
): Promise<GetTradeFlowsResponse> {
  try {
    const reporter = isValidCode(req.reportingCountry) ? req.reportingCountry : '840';
    const partner = isValidCode(req.partnerCountry) ? req.partnerCountry : '000';
    const years = Math.max(1, Math.min(req.years > 0 ? req.years : 10, 30));

    const seedKey = `${SEED_KEY_PREFIX}:${reporter}:${partner}:${years}`;
    const result = await getCachedJson(seedKey, true) as GetTradeFlowsResponse | null;
    if (!result?.flows?.length) {
      return { flows: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
    }
    return result;
  } catch {
    return { flows: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
