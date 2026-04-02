/**
 * RPC: getEuGasStorage -- reads seeded EU aggregate gas storage data from Railway seed cache.
 * All external GIE AGSI+ calls happen in seed-gie-gas-storage.mjs on Railway.
 */

import type {
  ServerContext,
  GetEuGasStorageRequest,
  GetEuGasStorageResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:eu-gas-storage:v1';

function buildFallbackResult(): GetEuGasStorageResponse {
  return {
    fillPct: 0,
    fillPctChange1d: 0,
    gasDaysConsumption: 0,
    trend: '',
    history: [],
    seededAt: '0',
    updatedAt: '',
    unavailable: true,
  };
}

export async function getEuGasStorage(
  _ctx: ServerContext,
  _req: GetEuGasStorageRequest,
): Promise<GetEuGasStorageResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEuGasStorageResponse | null;
    if (result && !result.unavailable && typeof result.fillPct === 'number' && result.fillPct > 0) {
      return {
        ...result,
        // proto int64 seeded_at → string; normalize in case older seed wrote a number
        seededAt: String(result.seededAt ?? '0'),
        // coerce nulls → 0 for older cached blobs that pre-date the null-guard fix
        fillPctChange1d: result.fillPctChange1d ?? 0,
        gasDaysConsumption: result.gasDaysConsumption ?? 0,
      };
    }
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
