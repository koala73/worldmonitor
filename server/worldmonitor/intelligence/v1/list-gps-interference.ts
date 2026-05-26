import type {
  IntelligenceServiceHandler,
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
  h3?: string;
  lat?: number;
  lon?: number;
  level?: string;
  region?: string;
  npAvg?: number;
  pct?: number;
  bad?: number;
  total?: number;
  sampleCount?: number;
  aircraftCount?: number;
}

interface GpsJamCachedData {
  hexes?: GpsJamCachedHex[];
  stats?: {
    totalHexes?: number;
    highCount?: number;
    mediumCount?: number;
  };
  source?: string;
  fetchedAt?: string | number;
}

function toLevel(level: string | undefined): InterferenceLevel {
  if (level === 'high') return 'INTERFERENCE_LEVEL_HIGH';
  if (level === 'medium') return 'INTERFERENCE_LEVEL_MEDIUM';
  return 'INTERFERENCE_LEVEL_LOW';
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toFetchedAt(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  if (!value) return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeHex(hex: GpsJamCachedHex): GpsJamHex {
  return {
    h3: String(hex.h3 || ''),
    lat: toNumber(hex.lat),
    lon: toNumber(hex.lon),
    level: toLevel(hex.level),
    npAvg: toNumber(hex.npAvg),
    sampleCount: toNumber(hex.sampleCount ?? hex.bad),
    aircraftCount: toNumber(hex.aircraftCount ?? hex.total),
  };
}

async function loadGpsJamData(): Promise<GpsJamCachedData | null> {
  const current = await getCachedJson(REDIS_KEY, true);
  if (current && typeof current === 'object') {
    return current as GpsJamCachedData;
  }

  const legacy = await getCachedJson(REDIS_KEY_V1, true);
  if (!legacy || typeof legacy !== 'object') return null;
  const payload = legacy as GpsJamCachedData;
  if (!Array.isArray(payload.hexes)) return null;

  return {
    ...payload,
    source: payload.source || 'gpsjam.org (normalized)',
    hexes: payload.hexes.map((hex) => {
      if (typeof hex.npAvg === 'number') return hex;
      const pct = toNumber(hex.pct);
      return {
        ...hex,
        npAvg: pct > 10 ? 0.3 : pct >= 2 ? 0.8 : 1.5,
        sampleCount: toNumber(hex.bad),
        aircraftCount: toNumber(hex.total),
      };
    }),
  };
}

export const listGpsInterference: IntelligenceServiceHandler['listGpsInterference'] = async (
  _ctx: ServerContext,
  req: ListGpsInterferenceRequest,
): Promise<ListGpsInterferenceResponse> => {
  const data = await loadGpsJamData();
  if (!data || !Array.isArray(data.hexes)) {
    return {
      hexes: [],
      stats: { totalHexes: 0, highCount: 0, mediumCount: 0 },
      source: '',
      fetchedAt: 0,
    };
  }

  const regionFilter = req.region?.trim().toLowerCase();
  const filtered = regionFilter
    ? data.hexes.filter((hex) => String(hex.region || '').toLowerCase() === regionFilter)
    : data.hexes;

  const hexes = filtered.map(normalizeHex);
  const stats = regionFilter
    ? {
        totalHexes: hexes.length,
        highCount: hexes.filter((hex) => hex.level === 'INTERFERENCE_LEVEL_HIGH').length,
        mediumCount: hexes.filter((hex) => hex.level === 'INTERFERENCE_LEVEL_MEDIUM').length,
      }
    : {
        totalHexes: toNumber(data.stats?.totalHexes || hexes.length),
        highCount: toNumber(data.stats?.highCount || hexes.filter((hex) => hex.level === 'INTERFERENCE_LEVEL_HIGH').length),
        mediumCount: toNumber(data.stats?.mediumCount || hexes.filter((hex) => hex.level === 'INTERFERENCE_LEVEL_MEDIUM').length),
      };
  return {
    hexes,
    stats,
    source: data.source || 'gpsjam.org',
    fetchedAt: toFetchedAt(data.fetchedAt),
  };
};
