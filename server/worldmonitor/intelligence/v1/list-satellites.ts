import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListSatellitesRequest,
  ListSatellitesResponse,
  Satellite,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'intelligence:satellites:tle:v1';

export const listSatellites: IntelligenceServiceHandler['listSatellites'] = async (
  _ctx: ServerContext,
  req: ListSatellitesRequest,
): Promise<ListSatellitesResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true)) as any;

  if (!data || !Array.isArray(data.satellites)) {
    return { satellites: [] };
  }

  let satellites: Satellite[] = data.satellites.map((s: any) => ({
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
    satellites = satellites.filter(s => s.country === req.country);
  }

  return { satellites };
};
