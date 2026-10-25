import { RpcValidationError } from './billing-denial';

export type GeoArea =
  | { kind: 'bbox'; swLat: number; swLon: number; neLat: number; neLon: number }
  | { kind: 'radius'; lat: number; lon: number; radiusKm: number };
export type EventFilter = { area: GeoArea | null; sinceMs: number | null };
type Row = Record<string, unknown>;
type Point = { lat: number; lon: number };
export type RowLocator = { point(row: Row): Point | null; time(row: Row): number | null };
// `within` names an object inside the bucket that holds the list, for regional
// sub-lists such as events.westernPacific.events. Reported as `label.within`.
export type EventList = { label: string; list: string; locator: RowLocator; within?: string };
type Exclusions = { without_location: number; without_time: number };
export type GeoFilterReport = {
  area: Record<string, number | string> | null;
  since_days: number | null;
  excluded: Record<string, Exclusions>;
  oldest_held: Record<string, number>;
};

const DAY_MS = 86_400_000;
const EARTH_RADIUS_KM = 6371.0088;
const RADIUS_ARGS = ['lat', 'lon', 'radius_km'] as const;
const BBOX_FIELDS = ['sw_lat', 'sw_lon', 'ne_lat', 'ne_lon'] as const;

const latitude = (description: string) => ({ type: 'number', minimum: -90, maximum: 90, description });
const longitude = (description: string) => ({ type: 'number', minimum: -180, maximum: 180, description });

export const GEO_FILTER_PROPERTIES = {
  bbox: {
    type: 'object',
    description: 'Keep events inside this box. sw_lon > ne_lon crosses the antimeridian. Not combinable with lat/lon/radius_km.',
    required: [...BBOX_FIELDS],
    additionalProperties: false,
    properties: {
      sw_lat: latitude('South edge latitude.'),
      sw_lon: longitude('West edge longitude.'),
      ne_lat: latitude('North edge latitude.'),
      ne_lon: longitude('East edge longitude.'),
    },
  },
  lat: latitude('Centre latitude for radius_km; requires lon and radius_km.'),
  lon: longitude('Centre longitude for radius_km; requires lat and radius_km.'),
  radius_km: { type: 'number', exclusiveMinimum: 0, maximum: 2000, description: 'Keep events within this great-circle distance of lat/lon (max 2000).' },
  since_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Keep events dated within the last N days.' },
};

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

export function pointAt(lat: unknown, lon: unknown): Point | null {
  const y = coordinate(lat, 90);
  const x = coordinate(lon, 180);
  return y === null || x === null ? null : { lat: y, lon: x };
}

export function locationPoint(row: Row): Point | null {
  const location = row.location;
  return record(location) ? pointAt(location.latitude, location.longitude) : null;
}

// Seeders write a missing date as 0 (e.g. `new Date(fromdate || 0).getTime()`),
// so a non-positive instant is unknown time, not 1970.
export function epochMs(value: unknown): number | null {
  const ms = typeof value === 'number' ? value
    : typeof value === 'string' ? (/^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value)) : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function locator(point: (row: Row) => Point | null, timeField: string): RowLocator {
  return { point, time: row => epochMs(row[timeField]) };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseEventFilter(params: Row, toolName: string): EventFilter {
  const violations: { field: string; description: string }[] = [];
  const reject = (field: string, description: string) => violations.push({ field, description });
  const radiusGiven = RADIUS_ARGS.filter(key => params[key] !== undefined);
  let area: GeoArea | null = null;
  if (params.bbox !== undefined) {
    if (radiusGiven.length) reject('bbox', 'Use bbox or lat/lon/radius_km, not both.');
    const box = record(params.bbox) ? params.bbox : {};
    const swLat = finite(box.sw_lat), swLon = finite(box.sw_lon), neLat = finite(box.ne_lat), neLon = finite(box.ne_lon);
    if (swLat === null || swLon === null || neLat === null || neLon === null) reject('bbox', 'bbox needs numeric sw_lat, sw_lon, ne_lat and ne_lon.');
    else if (swLat > neLat) reject('bbox.sw_lat', 'sw_lat must not exceed ne_lat.');
    else area = { kind: 'bbox', swLat, swLon, neLat, neLon };
  } else if (radiusGiven.length) {
    const lat = finite(params.lat), lon = finite(params.lon), radiusKm = finite(params.radius_km);
    if (lat === null || lon === null || radiusKm === null) {
      reject(RADIUS_ARGS.find(key => finite(params[key]) === null) ?? 'radius_km', 'lat, lon and radius_km are required together.');
    } else area = { kind: 'radius', lat, lon, radiusKm };
  }
  let sinceMs: number | null = null;
  if (params.since_days !== undefined) {
    const days = finite(params.since_days);
    if (days === null) reject('since_days', 'Expected integer.');
    else sinceMs = days * DAY_MS;
  }
  if (violations.length) throw new RpcValidationError(toolName, violations);
  return { area, sinceMs };
}

const radians = (degrees: number) => degrees * Math.PI / 180;

function distanceKm(a: Point, b: Point): number {
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function contains(area: GeoArea, point: Point): boolean {
  if (area.kind === 'radius') return distanceKm({ lat: area.lat, lon: area.lon }, point) <= area.radiusKm;
  if (point.lat < area.swLat || point.lat > area.neLat) return false;
  return area.swLon <= area.neLon
    ? point.lon >= area.swLon && point.lon <= area.neLon
    : point.lon >= area.swLon || point.lon <= area.neLon;
}

export function filterRows<T>(rows: T[], locate: RowLocator, filter: EventFilter, now: number) {
  const cutoff = filter.sinceMs === null ? null : now - filter.sinceMs;
  let withoutLocation = 0;
  let withoutTime = 0;
  const kept = rows.filter((row) => {
    let keep = true;
    if (filter.area) {
      const point = record(row) ? locate.point(row) : null;
      if (point === null) withoutLocation++;
      keep = point !== null && contains(filter.area, point);
    }
    if (cutoff !== null) {
      const time = record(row) ? locate.time(row) : null;
      // Count a missing date only for rows the area kept, so the count never
      // blames distant or unlocated rows on their dates.
      if (time === null && keep) withoutTime++;
      keep = keep && time !== null && time >= cutoff;
    }
    return keep;
  });
  return { rows: kept, withoutLocation, withoutTime };
}

function areaReport(area: GeoArea | null): GeoFilterReport['area'] {
  if (!area) return null;
  return area.kind === 'bbox'
    ? { kind: 'bbox', sw_lat: area.swLat, sw_lon: area.swLon, ne_lat: area.neLat, ne_lon: area.neLon }
    : { kind: 'radius', lat: area.lat, lon: area.lon, radius_km: area.radiusKm };
}

function listRows(data: Row, { label, list, within }: EventList): unknown[] | null {
  const parent = data[label];
  const bucket = within === undefined ? parent : record(parent) ? parent[within] : undefined;
  return record(bucket) && Array.isArray(bucket[list]) ? bucket[list] as unknown[] : null;
}

const listKey = ({ label, within }: EventList) => within === undefined ? label : `${label}.${within}`;

// The oldest dated row per list, read before any other filter narrows the
// lists, so oldest_held describes what is stored rather than what matched.
export function oldestDatedRows(data: Row, lists: readonly EventList[]): Record<string, number> {
  const oldest: Record<string, number> = {};
  for (const entry of lists) {
    for (const row of listRows(data, entry) ?? []) {
      const time = record(row) ? entry.locator.time(row) : null;
      const key = listKey(entry);
      if (time !== null && (oldest[key] === undefined || time < oldest[key]!)) oldest[key] = time;
    }
  }
  return oldest;
}

// Narrows each list in place. Returns null when no geo or time argument was passed.
export function filterEventLists(data: Row, lists: readonly EventList[], params: Row, toolName: string, stored: Record<string, number>, now = Date.now()): GeoFilterReport | null {
  const filter = parseEventFilter(params, toolName);
  if (!filter.area && filter.sinceMs === null) return null;
  const excluded: Record<string, Exclusions> = {};
  const oldestHeld: Record<string, number> = {};
  const cutoff = filter.sinceMs === null ? null : now - filter.sinceMs;
  for (const entry of lists) {
    const rows = listRows(data, entry);
    if (rows === null) continue;
    const key = listKey(entry);
    const result = filterRows(rows, entry.locator, filter, now);
    const parent = data[entry.label] as Row;
    (entry.within === undefined ? parent : parent[entry.within] as Row)[entry.list] = result.rows;
    if (result.withoutLocation || result.withoutTime) {
      excluded[key] = { without_location: result.withoutLocation, without_time: result.withoutTime };
    }
    // The stored list does not reach back to the cutoff: the window is wider than what is held.
    if (cutoff !== null && stored[key] !== undefined && stored[key]! > cutoff) oldestHeld[key] = stored[key]!;
  }
  return { area: areaReport(filter.area), since_days: filter.sinceMs === null ? null : filter.sinceMs / DAY_MS, excluded, oldest_held: oldestHeld };
}

// Reports exclusions only for lists the response still carries.
export function attachGeoFilter(out: Row, report: GeoFilterReport | null): Row {
  if (!report) return out;
  const carried = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([key]) => key.split('.')[0]! in out));
  out.geo_filter = { ...report, excluded: carried(report.excluded), oldest_held: carried(report.oldest_held) };
  return out;
}

export const GEO_FILTER_OUTPUT_SCHEMA = {
  type: 'object',
  description: 'Present only when bbox, lat/lon/radius_km or since_days was passed. excluded counts rows dropped per list for lacking coordinates or a date. oldest_held names lists whose oldest dated row is newer than the since_days cutoff: the window is wider than the data held.',
  properties: {
    area: { type: ['object', 'null'], properties: {
      kind: { enum: ['bbox', 'radius'] },
      sw_lat: { type: 'number' }, sw_lon: { type: 'number' }, ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
      lat: { type: 'number' }, lon: { type: 'number' }, radius_km: { type: 'number' },
    } },
    since_days: { type: ['integer', 'null'] },
    excluded: { type: 'object', additionalProperties: { type: 'object', properties: {
      without_location: { type: 'integer', minimum: 0 }, without_time: { type: 'integer', minimum: 0 },
    } } },
    oldest_held: { type: 'object', description: 'Epoch milliseconds of the oldest dated row per list, when that is newer than the cutoff.', additionalProperties: { type: 'integer' } },
  },
};
