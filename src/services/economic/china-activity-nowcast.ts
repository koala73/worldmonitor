import type {
  GetChinaActivityNowcastResponse,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import {
  evaluateChinaActivityNowcast,
  isChinaActivityNowcastUpstreamUnavailable,
  parseChinaActivityNowcastWirePayload,
  type ChinaActivityNowcastResponse,
} from '../../../shared/china-activity-nowcast';

type ChinaActivityNowcastBreakerExecute = (
  operation: () => Promise<ChinaActivityNowcastResponse>,
  fallback: ChinaActivityNowcastResponse,
) => Promise<ChinaActivityNowcastResponse>;

export const CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY = {
  // The endpoint owns the healthy aggregate cache. A browser last-good value
  // would hide current missingness or an explicit insufficient-data result.
  cacheTtlMs: 0,
  maxCacheEntries: 0,
} as const;

export interface ChinaActivityNowcastFetchDependencies {
  now: () => Date;
  getResponse: () => Promise<GetChinaActivityNowcastResponse>;
  execute: ChinaActivityNowcastBreakerExecute;
}

export function parseChinaActivityNowcastResponse(
  response: GetChinaActivityNowcastResponse,
): ChinaActivityNowcastResponse {
  const parsed = parseChinaActivityNowcastWirePayload(response.payloadJson);
  if (
    response.generatedAt !== parsed.evaluatedAt
    || response.methodVersion !== parsed.methodVersion
    || response.comparisonState !== parsed.state
    || response.upstreamUnavailable !== isChinaActivityNowcastUpstreamUnavailable(parsed)
  ) {
    throw new Error('Invalid China activity nowcast response');
  }
  return parsed;
}

export async function fetchChinaActivityNowcast(
  dependencies: ChinaActivityNowcastFetchDependencies,
): Promise<ChinaActivityNowcastResponse> {
  const fallback = evaluateChinaActivityNowcast({
    evaluatedAt: dependencies.now().toISOString(),
    officialObservations: [],
    proxyObservations: [],
  });
  try {
    return await dependencies.execute(async () => {
      const response = await dependencies.getResponse();
      return parseChinaActivityNowcastResponse(response);
    }, fallback);
  } catch {
    return fallback;
  }
}
