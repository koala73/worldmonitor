import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListSatellitesRequest,
  ListSatellitesResponse,
  Satellite,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'intelligence:satellites:tle:v1';

interface SatelliteCache {
  satellites: Array<{
    id?: string;
    noradId?: string;
    name?: string;
    country?: string;
    type?: string;
    alt?: number | string;
    velocity?: number | string;
    inclination?: number | string;
    line1?: string;
    line2?: string;
  }>;
}

export const listSatellites: IntelligenceServiceHandler['listSatellites'] = async (
  _ctx: ServerContext,
  req: ListSatellitesRequest,
): Promise<ListSatellitesResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true)) as unknown as SatelliteCache;

  if (!data || !Array.isArray(data.satellites)) {
    return { satellites: [] };
  }

  let satellitesArr: Satellite[] = data.satellites.map((s) => ({
    id: String(s.id || s.noradId || ''),
    name: s.name || '',
    country: s.country || '',
    type: s.type || '',
    alt: Number(s.alt) || 0,
    velocity: Number(s.velocity) || 0,
    inclination: Number(s.inclination) || 0,
    line1: s.line1 || '',
    line2: s.line2 || '',
  }));

  if (req.country) {
    satellitesArr = satellitesArr.filter(s => s.country === req.country);
  }

  return { satellites: satellitesArr };
};
