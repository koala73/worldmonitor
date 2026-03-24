/**
 * RPC: GetReitCorrelation -- reads precomputed macro correlation data from Redis.
 *
 * Data flow:
 *   seed-reit-analytics.mjs → Redis reits:correlation:v1 → this handler
 */

import type {
  ServerContext,
  GetReitCorrelationRequest,
  GetReitCorrelationResponse,
} from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { REDIS_KEYS } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

export async function getReitCorrelation(
  _ctx: ServerContext,
  _req: GetReitCorrelationRequest,
): Promise<GetReitCorrelationResponse> {
  try {
    const data = await getCachedJson(REDIS_KEYS.correlation, true) as GetReitCorrelationResponse | null;

    if (!data) {
      return {
        indicators: [],
        correlations: [],
        regime: 4 as any, // NEUTRAL
        sectorRotation: [],
        yieldSpread: 0,
        lastUpdated: '',
      };
    }

    return data;
  } catch {
    return {
      indicators: [],
      correlations: [],
      regime: 4 as any,
      sectorRotation: [],
      yieldSpread: 0,
      lastUpdated: '',
    };
  }
}
