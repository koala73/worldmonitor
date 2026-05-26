import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListSatellitesRequest,
  ListSatellitesResponse,
  Satellite,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'intelligence:satellites:tle:v1';

interface SatelliteCacheItem {
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
}

interface SatelliteCacheResponse {
  satellites?: SatelliteCacheItem[];
}

function toNumber(value: number | string | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toSatellite(item: SatelliteCacheItem): Satellite {
  return {
    id: String(item.id || item.noradId || ''),
    name: item.name || '',
    country: item.country || '',
    type: item.type || '',
    alt: toNumber(item.alt),
    velocity: toNumber(item.velocity),
    inclination: toNumber(item.inclination),
    line1: item.line1 || '',
    line2: item.line2 || '',
  };
}

export const listSatellites: IntelligenceServiceHandler['listSatellites'] = async (
  _ctx: ServerContext,
  req: ListSatellitesRequest,
): Promise<ListSatellitesResponse> => {
  const cached = await getCachedJson(REDIS_KEY, true);
  if (!cached || typeof cached !== 'object') {
    return { satellites: [] };
  }

  const payload = cached as SatelliteCacheResponse;
  if (!Array.isArray(payload.satellites)) {
    return { satellites: [] };
  }

  const filterCountry = req.country?.trim().toUpperCase();
  const satellites = payload.satellites
    .map(toSatellite)
    .filter((satellite) => {
      if (!filterCountry) return true;
      return satellite.country.toUpperCase() === filterCountry;
    });

  return { satellites };
};
