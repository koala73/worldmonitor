import type {
  ServerContext,
  ListGpsInterferenceRequest,
  ListGpsInterferenceResponse,
  GpsJamHex,
  InterferenceLevel,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'intelligence:gpsjam:v2';
const REDIS_KEY_V1 = 'intelligence:gpsjam:v1';

interface GpsJamCachedHex {
  h3: string;
  lat: number;
  lon: number;
  level: string;
  region?: string;
  npAvg?: number;
  pct?: number;
  bad?: number;
  total?: number;
  sampleCount?: number;
  aircraftCount?: number;
}

interface GpsJamCachedData {
  hexes: GpsJamCachedHex[];
  stats?: {
    totalHexes?: number;
    highCount?: number;
    mediumCount?: number;
  };
  source?: string;
  fetchedAt?: string | number;
}

export const listGpsInterference = async (
  _ctx: ServerContext,
  req: ListGpsInterferenceRequest,
): Promise<ListGpsInterferenceResponse> => {
  let data = await getCachedJson<GpsJamCachedData>(REDIS_KEY, true);

  if (!data) {
    const v1 = await getCachedJson<GpsJamCachedData>(REDIS_KEY_V1, true);
    if (v1?.hexes) {
      data = {
        ...v1,
        source: v1.source || 'gpsjam.org (normalized)',
        hexes: v1.hexes.map((hex) => {
          if ('npAvg' in hex) return hex;
          const pct = hex.pct || 0;
          return {
            h3: hex.h3,
            lat: hex.lat,
            lon: hex.lon,
            level: hex.level,
            region: hex.region,
            npAvg: pct > 10 ? 0.3 : pct >= 2 ? 0.8 : 1.5,
            sampleCount: hex.bad || 0,
            aircraftCount: hex.total || 0,
          };
        }),
      };
    }
  }

  if (!data || !Array.isArray(data.hexes)) {
    return {
      hexes: [],
      stats: { totalHexes: 0, highCount: 0, mediumCount: 0 },
      source: '',
      fetchedAt: 0,
    };
  }

  const mapLevel = (level?: string): InterferenceLevel => {
    if (level === 'high') return 'INTERFERENCE_LEVEL_HIGH';
    if (level === 'medium') return 'INTERFERENCE_LEVEL_MEDIUM';
    return 'INTERFERENCE_LEVEL_LOW';
  };

  let hexes: GpsJamHex[] = data.hexes.map((h) => ({
    h3: h.h3 || '',
    lat: Number(h.lat) || 0,
    lon: Number(h.lon) || 0,
    level: mapLevel(h.level),
    npAvg: Number(h.npAvg) || 0,
    sampleCount: Number(h.sampleCount ?? h.bad) || 0,
    aircraftCount: Number(h.aircraftCount ?? h.total) || 0,
  }));

  if (req.region) {
    const internalHexes = data.hexes.filter((h) => h.region === req.region);
    hexes = internalHexes.map((h) => ({
      h3: h.h3 || '',
      lat: Number(h.lat) || 0,
      lon: Number(h.lon) || 0,
      level: mapLevel(h.level),
      npAvg: Number(h.npAvg) || 0,
      sampleCount: Number(h.sampleCount ?? h.bad) || 0,
      aircraftCount: Number(h.aircraftCount ?? h.total) || 0,
    }));
  }

  return {
    hexes,
    stats: {
      totalHexes: Number(data.stats?.totalHexes || hexes.length) || 0,
      highCount: Number(data.stats?.highCount) || hexes.filter((h) => h.level === 'INTERFERENCE_LEVEL_HIGH').length,
      mediumCount: Number(data.stats?.mediumCount) || hexes.filter((h) => h.level === 'INTERFERENCE_LEVEL_MEDIUM').length,
    },
    source: data.source || 'gpsjam.org',
    fetchedAt: data.fetchedAt ? new Date(data.fetchedAt).getTime() : Date.now(),
  };
};
