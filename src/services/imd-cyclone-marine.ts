import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import type { NaturalEvent, ForecastPoint, PastTrackPoint, CycloneAgencyObservation } from '@/types';
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function number(value: unknown, min = 0, max = Infinity): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function date(value: unknown): Date | undefined {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'string' ? Date.parse(value) : value;
  return number(ms, 1, 8.64e15) ? new Date(ms) : undefined;
}

function strings<K extends string>(raw: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) if (typeof raw[key] === 'string') result[key] = raw[key];
  return result;
}

function numbers<K extends string>(raw: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) if (number(raw[key])) result[key] = raw[key];
  return result;
}

function position(raw: Record<string, unknown>): raw is Record<string, unknown> & { lat: number; lon: number } {
  return number(raw.lat, -90, 90) && number(raw.lon, -180, 180);
}

function coordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && number(value[0], -180, 180) && number(value[1], -90, 90);
}

function rings(value: unknown): value is number[][][] {
  return Array.isArray(value) && value.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(coordinate));
}

function items<T>(value: unknown, mapper: (raw: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw) ? mapper(raw) : undefined;
    return item === undefined ? [] : [item];
  });
}

function mapAlert(raw: Record<string, unknown>): WeatherAlert | undefined {
  const onset = date(raw.onset);
  const expires = date(raw.expires);
  if (!nonBlank(raw.id) || !nonBlank(raw.event) || !nonBlank(raw.headline)
    || typeof raw.description !== 'string' || typeof raw.areaDesc !== 'string'
    || !onset || !expires || expires < onset
    || !Array.isArray(raw.coordinates) || !raw.coordinates.every(coordinate)
    || (raw.centroid !== undefined && !coordinate(raw.centroid))) return undefined;
  const severity = raw.severity;
  return {
    id: raw.id, event: raw.event, headline: raw.headline,
    description: raw.description, areaDesc: raw.areaDesc,
    onset, expires, coordinates: raw.coordinates,
    severity: severity === 'Extreme' || severity === 'Severe' || severity === 'Moderate' || severity === 'Minor' ? severity : 'Unknown',
    ...(coordinate(raw.centroid) ? { centroid: raw.centroid } : {}),
    ...(raw.geometryPrecision === 'polygon' || raw.geometryPrecision === 'point' || raw.geometryPrecision === 'country'
      ? { geometryPrecision: raw.geometryPrecision } : {}),
    ...strings(raw, ['countryCode', 'source', 'productKind', 'issuedBy', 'wind', 'visibility', 'seaState', 'sourceUrl']),
  };
}

function mapCyclone(raw: Record<string, unknown>): NaturalEvent | undefined {
  const observed = date(raw.date);
  if (!nonBlank(raw.id) || !nonBlank(raw.title) || !position(raw) || !observed) return undefined;
  return {
    id: raw.id, title: raw.title, lat: raw.lat, lon: raw.lon, date: observed,
    category: 'severeStorms', categoryTitle: typeof raw.categoryTitle === 'string' ? raw.categoryTitle : 'Tropical Cyclone',
    closed: raw.closed === true,
    ...strings(raw, ['description', 'sourceName', 'sourceUrl', 'stormId', 'stormName', 'basin', 'classification',
      'magnitudeUnit', 'coneGeometryKind', 'canonicalId', 'matchingConfidence']),
    ...numbers(raw, ['magnitude', 'stormCategory', 'windKt', 'pressureMb', 'movementDir', 'movementSpeedKt', 'windAveragingPeriodMinutes']),
    ...(Array.isArray(raw.canonicalAliases) ? { canonicalAliases: raw.canonicalAliases.filter((s): s is string => typeof s === 'string') } : {}),
    ...(raw.forecastTrack !== undefined ? { forecastTrack: items<ForecastPoint>(raw.forecastTrack, (p) =>
      position(p) && number(p.hour) && number(p.windKt) && number(p.category)
        ? { lat: p.lat, lon: p.lon, hour: p.hour, windKt: p.windKt, category: p.category, ...strings(p, ['geometryKind']) } : undefined) } : {}),
    ...(raw.pastTrack !== undefined ? { pastTrack: items<PastTrackPoint>(raw.pastTrack, (p) =>
      position(p) && number(p.windKt) && date(p.timestamp)
        ? { lat: p.lat, lon: p.lon, windKt: p.windKt, timestamp: date(p.timestamp)!.getTime(), ...strings(p, ['geometryKind']) } : undefined) } : {}),
    ...(rings(raw.conePolygon) ? { conePolygon: raw.conePolygon } : {}),
    ...(raw.windRadii !== undefined ? { windRadii: items<NonNullable<NaturalEvent['windRadii']>[number]>(raw.windRadii, (p) => ({
      ...(p.thresholdKt === null ? { thresholdKt: null } : numbers(p, ['thresholdKt'])),
      ...strings(p, ['thresholdLabel', 'geometryKind']),
      ...(Array.isArray(p.polygons) && p.polygons.every(rings) ? { polygons: p.polygons as number[][][][] } : {}),
    })) } : {}),
    ...(raw.agencyObservations !== undefined ? { agencyObservations: items<CycloneAgencyObservation>(raw.agencyObservations, (p) =>
      position(p) && date(p.observedAt) && typeof p.agency === 'string' && typeof p.agencyId === 'string' && typeof p.status === 'string'
        ? { agency: p.agency, agencyId: p.agencyId, status: p.status, lat: p.lat, lon: p.lon, observedAt: date(p.observedAt)!.getTime(),
          ...numbers(p, ['windKt', 'pressureMb', 'windAveragingPeriodMinutes']), ...strings(p, ['classification', 'sourceName', 'sourceUrl']) } : undefined) } : {}),
  };
}

export function mapImdSnapshot(snapshot: unknown): ImdMappedProducts {
  if (!record(snapshot)) return EMPTY;
  const cycloneEvents = items(snapshot.cycloneEvents, mapCyclone);
  const portAlerts = items(snapshot.portAlerts, mapAlert);
  const marineBulletins = items(snapshot.marineBulletins, mapAlert);
  const validCollections = [snapshot.cycloneEvents, snapshot.portAlerts, snapshot.marineBulletins].every(Array.isArray);
  const rejected = !validCollections || cycloneEvents.length !== (snapshot.cycloneEvents as unknown[])?.length
    || portAlerts.length !== (snapshot.portAlerts as unknown[])?.length
    || marineBulletins.length !== (snapshot.marineBulletins as unknown[])?.length;
  const coverage = snapshot.coverageState;
  let coverageState = coverage === 'ok' || coverage === 'degraded' || coverage === 'disabled' ? coverage : 'unavailable';
  if (rejected && (coverageState === 'ok' || coverageState === 'degraded')) coverageState = cycloneEvents.length + portAlerts.length + marineBulletins.length > 0 ? 'degraded' : 'unavailable';
  return {
    coverageState, cycloneEvents, portAlerts, marineBulletins,
    sourceName: typeof snapshot.sourceName === 'string' ? snapshot.sourceName : EMPTY.sourceName,
    sourceUrl: typeof snapshot.sourceUrl === 'string' ? snapshot.sourceUrl : EMPTY.sourceUrl,
  };
}

// A short handoff between natural/weather consumers, not a new source freshness claim.
const HANDOFF_MS = 60_000;
let accepted: { products: ImdMappedProducts; expiresAt: number } | undefined;
let pending: Promise<ImdMappedProducts> | undefined;

export async function fetchImdCycloneMarine(): Promise<ImdMappedProducts> {
  if (accepted && Date.now() < accepted.expiresAt) return accepted.products;
  if (pending) return pending;
  pending = (async () => {
    const hydrated = getHydratedData('imdCycloneMarine') ?? await ensureHydrated('imdCycloneMarine');
    const products = mapImdSnapshot(hydrated);
    if (products.coverageState === 'ok' || products.coverageState === 'degraded') {
      accepted = { products, expiresAt: Date.now() + HANDOFF_MS };
    } else accepted = undefined;
    return products;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
