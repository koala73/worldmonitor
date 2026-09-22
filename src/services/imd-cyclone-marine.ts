import { createHydrationHandoff } from '@/services/hydration-handoff';
import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import type { NaturalEvent } from '@/types';
import type { WeatherAlert } from '@/services/weather';

export interface ImdProductHealth {
  status: string;
  reason?: string | null;
  recordCount: number;
  warningCount?: number;
  carried?: boolean;
}

export interface ImdCycloneMarineSnapshot {
  coverageState?: string;
  skipReason?: string | null;
  generatedAt?: number;
  products?: Record<string, ImdProductHealth>;
  cycloneEvents?: NaturalEvent[];
  portAlerts?: WeatherAlert[];
  marineBulletins?: WeatherAlert[];
  sourceName?: string;
  sourceUrl?: string;
  attribution?: string;
}

export interface ImdMappedProducts {
  coverageState: string;
  cycloneEvents: NaturalEvent[];
  portAlerts: WeatherAlert[];
  marineBulletins: WeatherAlert[];
  sourceName: string;
  sourceUrl: string;
}

const EMPTY: ImdMappedProducts = {
  coverageState: 'unavailable',
  cycloneEvents: [],
  portAlerts: [],
  marineBulletins: [],
  sourceName: 'India Meteorological Department',
  sourceUrl: 'https://api.imd.gov.in/public/api_reference.html',
};

function asDate(value: unknown, fallback: number): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime())) return new Date(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    return ['api.imd.gov.in', 'rsmcnewdelhi.imd.gov.in', 'mausam.imd.gov.in'].includes(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function coordinate(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [lon, lat] = value;
  return finite(lon) !== undefined && finite(lat) !== undefined && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
    ? [lon, lat] : undefined;
}

function coordinates(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const point = coordinate(item);
    return point ? [point] : [];
  });
}

function rings(value: unknown): number[][][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(ring => {
    const points = coordinates(ring);
    // Drop a malformed ring as a whole rather than inventing a new polygon.
    return Array.isArray(ring) && points.length === ring.length && points.length >= 4
      && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1] ? [points] : [];
  });
}

function positions(value: unknown): Record<string, unknown>[] {
  return records(value).filter(row => coordinate([row.lon, row.lat]));
}

function mapAlert(raw: Record<string, unknown>, generatedAt: number): WeatherAlert {
  const severity = text(raw.severity);
  const precision = raw.geometryPrecision;
  return {
    id: text(raw.id), event: text(raw.event), headline: text(raw.headline),
    description: text(raw.description), areaDesc: text(raw.areaDesc),
    severity: severity === 'Extreme' || severity === 'Severe' || severity === 'Moderate' || severity === 'Minor' ? severity : 'Unknown',
    onset: asDate(raw.onset, generatedAt), expires: asDate(raw.expires, generatedAt),
    coordinates: coordinates(raw.coordinates), centroid: coordinate(raw.centroid),
    countryCode: text(raw.countryCode), source: text(raw.source),
    geometryPrecision: precision === 'polygon' || precision === 'point' || precision === 'country' ? precision : undefined,
    productKind: text(raw.productKind), issuedBy: text(raw.issuedBy),
    wind: text(raw.wind), visibility: text(raw.visibility), seaState: text(raw.seaState),
    sourceUrl: sourceUrl(raw.sourceUrl),
  };
}

function mapCyclone(raw: Record<string, unknown>, generatedAt: number): NaturalEvent {
  return {
    id: text(raw.id), title: text(raw.title), description: text(raw.description),
    lat: raw.lat as number, lon: raw.lon as number,
    date: asDate(raw.date, generatedAt), category: 'severeStorms',
    categoryTitle: text(raw.categoryTitle) || 'Tropical Cyclone', closed: raw.closed === true,
    stormId: text(raw.stormId), stormName: text(raw.stormName), basin: text(raw.basin),
    classification: text(raw.classification), windKt: finite(raw.windKt),
    sourceName: text(raw.sourceName), sourceUrl: sourceUrl(raw.sourceUrl),
    pastTrack: positions(raw.pastTrack).map(row => ({
      lat: row.lat as number, lon: row.lon as number, windKt: finite(row.windKt) ?? 0,
      timestamp: finite(row.timestamp) ?? 0, geometryKind: text(row.geometryKind),
    })),
    forecastTrack: positions(raw.forecastTrack).map(row => ({
      lat: row.lat as number, lon: row.lon as number, windKt: finite(row.windKt) ?? 0,
      hour: finite(row.hour) ?? 0, category: finite(row.category) ?? 0, geometryKind: text(row.geometryKind),
    })),
    conePolygon: rings(raw.conePolygon), coneGeometryKind: text(raw.coneGeometryKind),
    windRadii: records(raw.windRadii).map(row => ({
      thresholdKt: finite(row.thresholdKt), thresholdLabel: text(row.thresholdLabel),
      geometryKind: text(row.geometryKind),
      polygons: Array.isArray(row.polygons) ? row.polygons.map(rings).filter(polygon => polygon.length > 0) : [],
    })),
    agencyObservations: positions(raw.agencyObservations).map(row => ({
      agency: text(row.agency), agencyId: text(row.agencyId), observedAt: finite(row.observedAt) ?? generatedAt,
      lat: row.lat as number, lon: row.lon as number, windKt: finite(row.windKt),
      classification: text(row.classification), status: text(row.status),
      sourceName: text(row.sourceName), sourceUrl: sourceUrl(row.sourceUrl),
    })),
  };
}

export function mapImdSnapshot(snapshot: unknown): ImdMappedProducts {
  if (!isRecord(snapshot)) return { ...EMPTY, cycloneEvents: [], portAlerts: [], marineBulletins: [] };
  const generatedAt = asDate(snapshot.generatedAt, Date.now()).getTime();
  return {
    coverageState: text(snapshot.coverageState) || 'unavailable',
    cycloneEvents: positions(snapshot.cycloneEvents).filter(row => text(row.id)).map(event => mapCyclone(event, generatedAt)),
    portAlerts: records(snapshot.portAlerts).filter(row => text(row.id)).map(alert => mapAlert(alert, generatedAt)),
    marineBulletins: records(snapshot.marineBulletins).filter(row => text(row.id)).map(alert => mapAlert(alert, generatedAt)),
    sourceName: text(snapshot.sourceName) || EMPTY.sourceName,
    sourceUrl: sourceUrl(snapshot.sourceUrl) || EMPTY.sourceUrl,
  };
}

// getHydratedData() deletes a value when read, so the first of the two
// parallel loaders (weather + natural, data-loader.ts) drained the consume-once
// slot and the second fell through to the on-demand fetch or EMPTY. Both
// layers must share one accepted snapshot for the TTL window (#8354).
const hydrationHandoff = createHydrationHandoff<ImdMappedProducts>(
  'imdCycloneMarine',
  (value) => {
    const mapped = mapImdSnapshot(value as ImdCycloneMarineSnapshot | null | undefined);
    return mapped.coverageState === 'unavailable' &&
      mapped.cycloneEvents.length === 0 &&
      mapped.portAlerts.length === 0 &&
      mapped.marineBulletins.length === 0
      ? null
      : mapped;
  },
  // Only bridge the same-tick weather + natural loaders; a later refresh goes
  // back to the load path instead of replaying one snapshot for 30 minutes.
  { ttlMs: 60_000 },
);

export async function fetchImdCycloneMarine(): Promise<ImdMappedProducts> {
  return hydrationHandoff.getOrLoad(async () => {
    const hydrated = (getHydratedData('imdCycloneMarine') ?? await ensureHydrated('imdCycloneMarine')) as ImdCycloneMarineSnapshot | undefined;
    if (!hydrated) return EMPTY;
    return mapImdSnapshot(hydrated);
  }, EMPTY);
}
