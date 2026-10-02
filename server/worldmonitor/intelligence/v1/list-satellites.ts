import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListSatellitesRequest,
  ListSatellitesResponse,
  Satellite,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { readRequiredSeed } from '../../../_shared/required-seed';
import { normalizeSatelliteSnapshot } from '../../../../shared/intelligence-snapshots.js';

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
  satellites: SatelliteCacheItem[];
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
  // Invalid TLE records are dropped; a malformed or all-invalid snapshot is 503.
  const payload: SatelliteCacheResponse = await readRequiredSeed(
    REDIS_KEY,
    value => normalizeSatelliteSnapshot(value) ?? undefined,
  );

  const filterCountry = req.country?.trim().toUpperCase();
  const satellites = payload.satellites
    .map(toSatellite)
    .filter((satellite) => {
      if (!filterCountry) return true;
      return satellite.country.toUpperCase() === filterCountry;
    });

  return { satellites };
};
