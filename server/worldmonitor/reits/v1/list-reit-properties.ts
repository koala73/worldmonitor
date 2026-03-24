/**
 * RPC: ListReitProperties -- reads curated property locations + exposure scores from Redis.
 *
 * Data flow:
 *   seed-reit-properties.mjs → Redis reits:properties:v1 → this handler
 */

import type {
  ServerContext,
  ListReitPropertiesRequest,
  ListReitPropertiesResponse,
  ReitProperty,
} from '../../../../src/generated/server/worldmonitor/reits/v1/service_server';
import { REDIS_KEYS } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

export async function listReitProperties(
  _ctx: ServerContext,
  req: ListReitPropertiesRequest,
): Promise<ListReitPropertiesResponse> {
  try {
    const data = await getCachedJson(REDIS_KEYS.properties, true) as {
      properties: ReitProperty[];
      exposureSummaries: Array<{
        reitSymbol: string;
        disasterExposureScore: number;
        seismicZoneCount: number;
        wildfireRiskCount: number;
        hurricaneCorridorCount: number;
      }>;
      lastUpdated: string;
    } | null;

    if (!data?.properties?.length) {
      return { properties: [], exposureSummaries: [], lastUpdated: '' };
    }

    let properties = data.properties;

    // Filter by sector
    if (req.sector) {
      properties = properties.filter((p: ReitProperty) => p.sector === req.sector);
    }

    // Filter by REIT symbol
    if (req.reitSymbol) {
      properties = properties.filter((p: ReitProperty) => p.reitSymbol === req.reitSymbol);
    }

    // Filter exposure summaries to match returned properties
    const returnedSymbols = new Set(properties.map((p: ReitProperty) => p.reitSymbol));
    const exposureSummaries = (data.exposureSummaries || [])
      .filter(e => returnedSymbols.has(e.reitSymbol));

    return {
      properties,
      exposureSummaries,
      lastUpdated: data.lastUpdated || '',
    };
  } catch {
    return { properties: [], exposureSummaries: [], lastUpdated: '' };
  }
}
