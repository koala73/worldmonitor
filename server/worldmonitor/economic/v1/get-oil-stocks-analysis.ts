/**
 * RPC: getOilStocksAnalysis -- reads seeded IEA oil stocks analysis from Railway seed cache.
 * Key written by afterPublish hook in seed-iea-oil-stocks.mjs.
 */

import type {
  ServerContext,
  GetOilStocksAnalysisRequest,
  GetOilStocksAnalysisResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'energy:oil-stocks-analysis:v1';

function buildFallbackResult(): GetOilStocksAnalysisResponse {
  return {
    updatedAt: '',
    dataMonth: '',
    ieaMembers: [],
    belowObligation: [],
    unavailable: true,
  };
}

export async function getOilStocksAnalysis(
  _ctx: ServerContext,
  _req: GetOilStocksAnalysisRequest,
): Promise<GetOilStocksAnalysisResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetOilStocksAnalysisResponse | null;
    if (result && Array.isArray(result.ieaMembers) && result.ieaMembers.length > 0) {
      return { ...result, unavailable: false };
    }
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
