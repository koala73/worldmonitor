/**
 * RPC: getEuYieldCurve -- reads seeded ECB Euro Area AAA sovereign yield curve from Redis.
 * All external ECB API calls happen in scripts/seed-yield-curve-eu.mjs on Railway.
 */

import type {
  ServerContext,
  GetEuYieldCurveRequest,
  GetEuYieldCurveResponse,
  EuYieldCurveData,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'economic:yield-curve-eu:v1';

export async function getEuYieldCurve(
  _ctx: ServerContext,
  _req: GetEuYieldCurveRequest,
): Promise<GetEuYieldCurveResponse> {
  try {
    const cached = await getCachedJson(CACHE_KEY, true);
    if (!cached) return { unavailable: true };

    const data = cached as EuYieldCurveData & { rates?: Record<string, number> };
    if (!data.rates || Object.keys(data.rates).length === 0) return { unavailable: true };

    return { data, unavailable: false };
  } catch {
    return { unavailable: true };
  }
}
