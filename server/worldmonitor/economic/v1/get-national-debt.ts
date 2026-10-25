/**
 * RPC: getNationalDebt -- reads seeded national debt data from Railway seed cache.
 * All external IMF/Treasury calls happen in seed-national-debt.mjs on Railway.
 */

import type {
  ServerContext,
  GetNationalDebtRequest,
  GetNationalDebtResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:national-debt:v1';

function buildFallbackResult(): GetNationalDebtResponse {
  return {
    entries: [],
    seededAt: '',
    unavailable: true,
  };
}

export async function getNationalDebt(
  _ctx: ServerContext,
  _req: GetNationalDebtRequest,
): Promise<GetNationalDebtResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetNationalDebtResponse | null;
    if (result && !result.unavailable && result.entries && result.entries.length > 0) return result;
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
