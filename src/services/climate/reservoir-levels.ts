import type {
  ListReservoirLevelsResponse,
  ReservoirLevel as ProtoReservoirLevel,
} from '@/generated/client/worldmonitor/climate/v1/service_client';

/** Status of a reservoir level, first matching rule wins (see scripts/_reservoir-levels.mjs). */
export type ReservoirLevelStatus =
  | 'no_recent_data'
  | 'record_low'
  | 'record_high'
  | 'falling_fast'
  | 'rising_fast'
  | 'low'
  | 'high'
  | 'normal'
  | 'insufficient_history';

const STATUSES: ReadonlySet<string> = new Set<ReservoirLevelStatus>([
  'no_recent_data', 'record_low', 'record_high', 'falling_fast', 'rising_fast', 'low', 'high', 'normal', 'insufficient_history',
]);

/**
 * One strategic reservoir or lake. Levels are ICESat-2 lidar water-surface heights in
 * metres above the EGM2008 geoid: lake level, not storage volume. Observations reach
 * NASA 50 to 70 days after the overpass, so `latest.observedAt` is never recent.
 */
export interface ReservoirLevel {
  id: string;
  name: string;
  country: string;
  riparians: string[];
  river: string;
  lat: number;
  lon: number;
  tags: string[];
  why: string;
  latest: { observedAt: Date; levelM: number; madM: number; segments: number; ageDays: number } | null;
  prevDate: string | null;
  changePrevM: number | null;
  change30dM: number | null;
  change90dM: number | null;
  change365dM: number | null;
  seasonalAnomalyM: number | null;
  seasonalZ: number | null;
  recordMinM: number | null;
  recordMaxM: number | null;
  recordStart: string | null;
  percentOfRange: number | null;
  recordLow: boolean;
  recordHigh: boolean;
  status: ReservoirLevelStatus;
  series: Array<{ date: string; levelM: number }>;
}

export interface ReservoirLevelsSnapshot {
  reservoirs: ReservoirLevel[];
  fetchedAt: Date | null;
  methodology: string;
  sourceName: string;
}

const num = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toDisplayReservoirLevel(proto: ProtoReservoirLevel): ReservoirLevel {
  const latest = proto.latest && proto.latest.date
    ? {
      observedAt: new Date(`${proto.latest.date}T00:00:00Z`),
      levelM: proto.latest.levelM,
      madM: proto.latest.madM,
      segments: proto.latest.segmentCount,
      ageDays: proto.latest.ageDays,
    }
    : null;
  return {
    id: proto.id,
    name: proto.name,
    country: proto.country,
    riparians: proto.riparians ?? [],
    river: proto.river,
    lat: proto.lat,
    lon: proto.lon,
    tags: proto.tags ?? [],
    why: proto.why,
    latest,
    prevDate: proto.prevDate || null,
    changePrevM: num(proto.changePrevM),
    change30dM: num(proto.change30dM),
    change90dM: num(proto.change90dM),
    change365dM: num(proto.change365dM),
    seasonalAnomalyM: num(proto.seasonalAnomalyM),
    seasonalZ: num(proto.seasonalZ),
    recordMinM: num(proto.recordMinM),
    recordMaxM: num(proto.recordMaxM),
    recordStart: proto.recordStart || null,
    percentOfRange: num(proto.percentOfRange),
    recordLow: proto.recordLow === true,
    recordHigh: proto.recordHigh === true,
    status: (STATUSES.has(proto.status) ? proto.status : 'insufficient_history') as ReservoirLevelStatus,
    series: (proto.series ?? []).map((p) => ({ date: p.date, levelM: p.levelM })),
  };
}

/** Null when the snapshot is unavailable (dataAvailable=false), so callers can tell it from an empty watchlist. */
export function toReservoirLevelsSnapshot(resp: ListReservoirLevelsResponse): ReservoirLevelsSnapshot | null {
  if (!resp.dataAvailable || !(resp.reservoirs ?? []).length) return null;
  const fetchedAt = Number(resp.fetchedAt);
  return {
    reservoirs: resp.reservoirs.map(toDisplayReservoirLevel),
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? new Date(fetchedAt) : null,
    methodology: resp.methodology ?? '',
    sourceName: resp.source?.name ?? '',
  };
}
