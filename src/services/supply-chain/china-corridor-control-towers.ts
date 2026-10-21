import type {
  GetChinaCorridorControlTowersResponse,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import {
  createUnavailableChinaCorridorControlTowerResponse,
  parseChinaCorridorWirePayload,
  type ChinaCorridorControlTowerResponse,
} from '../../../shared/china-corridor-control-towers';

type ChinaCorridorBreakerExecute = (
  operation: () => Promise<ChinaCorridorControlTowerResponse>,
  fallback: ChinaCorridorControlTowerResponse,
) => Promise<ChinaCorridorControlTowerResponse>;

export const CHINA_CORRIDOR_BREAKER_CACHE_POLICY = {
  // The server already owns healthy aggregate caching. Client-side last-good
  // caching would hide successful fail-closed responses behind stale data.
  cacheTtlMs: 0,
  maxCacheEntries: 0,
} as const;

export interface ChinaCorridorFetchDependencies {
  now: () => Date;
  getResponse: () => Promise<GetChinaCorridorControlTowersResponse>;
  execute: ChinaCorridorBreakerExecute;
}

export function parseChinaCorridorResponse(
  response: GetChinaCorridorControlTowersResponse,
): ChinaCorridorControlTowerResponse {
  const parsed = parseChinaCorridorWirePayload(response.payloadJson);
  const allUnavailable = parsed.corridors.every((corridor) =>
    corridor.availability === 'unavailable');
  if (
    response.generatedAt !== parsed.generatedAt
    || response.upstreamUnavailable !== allUnavailable
  ) {
    throw new Error('Invalid China corridor control-tower response');
  }
  return parsed;
}

export async function fetchChinaCorridorControlTowers(
  dependencies: ChinaCorridorFetchDependencies,
): Promise<ChinaCorridorControlTowerResponse> {
  const fallback = createUnavailableChinaCorridorControlTowerResponse(
    dependencies.now().toISOString(),
    'China corridor API response is unavailable.',
  );
  try {
    return await dependencies.execute(async () => {
      const response = await dependencies.getResponse();
      return parseChinaCorridorResponse(response);
    }, fallback);
  } catch {
    return fallback;
  }
}
