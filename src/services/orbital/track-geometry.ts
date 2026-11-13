import { footprintBand, groundTrack, type GroundTrackPoint, type OrbitElements, type Pass } from '../../../shared/orbital/pass-geometry.js';
import type { Footprint } from '../../../shared/orbital/sensor-profiles.js';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const MINUTE_MS = 60_000;

export interface TrackPoint {
  lon: number;
  lat: number;
  timeMs: number;
}

/** A closed, counter-clockwise ring of [lon, lat] positions, every longitude inside -180..180. */
export type FootprintRing = Array<[number, number]>;

/** A pass drawn on the map: where the satellite flew and the ground its sensor could see. */
export interface PassTrack {
  key: string;
  name: string;
  startMs: number;
  endMs: number;
  /** The sub-satellite point at closest approach to the looked-up point. */
  closest: TrackPoint;
  /** One path per side of the antimeridian, each ending on it so no line crosses the map. */
  segments: TrackPoint[][];
  footprint: FootprintRing[];
}

export type TrackPass = Pick<Pass, 'noradId' | 'name' | 'timeMs' | 'altitudeKm' | 'subSatellite'>;

export interface PassTrackOptions {
  trackHalfMinutes?: number;
  footprintHalfMinutes?: number;
  stepSeconds?: number;
}

export const passTrackKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

const toTrackPoint = (point: GroundTrackPoint): TrackPoint => ({ lon: point.lon, lat: point.lat, timeMs: Date.parse(point.time) });

/** Ends each segment on the antimeridian at the interpolated crossing, so neighbouring segments meet. */
function closeAtAntimeridian(segments: TrackPoint[][]): TrackPoint[][] {
  const closed = segments.map((segment) => [...segment]);
  for (let i = 0; i + 1 < closed.length; i += 1) {
    const before = closed[i]![closed[i]!.length - 1]!;
    const after = closed[i + 1]![0]!;
    const edge = before.lon >= 0 ? 180 : -180;
    const afterLon = after.lon + (edge > 0 ? 360 : -360);
    const span = afterLon - before.lon;
    if (span === 0) continue;
    const f = (edge - before.lon) / span;
    const lat = before.lat + (after.lat - before.lat) * f;
    const timeMs = before.timeMs + (after.timeMs - before.timeMs) * f;
    closed[i]!.push({ lon: edge, lat, timeMs });
    closed[i + 1]!.unshift({ lon: -edge, lat, timeMs });
  }
  return closed;
}

/** The segments joined into one run with continuous longitudes, which may leave -180..180. */
function unwrap(segments: TrackPoint[][]): TrackPoint[] {
  const run: TrackPoint[] = [];
  let shift = 0;
  for (const point of segments.flat()) {
    const previous = run[run.length - 1];
    let lon = point.lon + shift;
    if (previous && Math.abs(lon - previous.lon) > 180) {
      shift += lon < previous.lon ? 360 : -360;
      lon = point.lon + shift;
    }
    run.push({ ...point, lon });
  }
  return run;
}

function bearingDeg(from: TrackPoint, to: TrackPoint): number {
  const lat1 = from.lat * DEG;
  const lat2 = to.lat * DEG;
  const dLon = (to.lon - from.lon) * DEG;
  return Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)) / DEG;
}

/** The point a distance along a bearing, with its longitude kept continuous with the start. */
function destination(from: TrackPoint, bearing: number, distanceKm: number): [number, number] {
  const d = distanceKm / EARTH_RADIUS_KM;
  const lat1 = from.lat * DEG;
  const theta = bearing * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(theta));
  const dLon = Math.atan2(Math.sin(theta) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [from.lon + dLon / DEG, lat2 / DEG];
}

function headings(run: TrackPoint[]): number[] {
  return run.map((_, i) => bearingDeg(run[Math.max(0, i - 1)]!, run[Math.min(run.length - 1, i + 1)]!));
}

function edge(run: TrackPoint[], heading: number[], side: 'left' | 'right', distanceKm: number): Array<[number, number]> {
  const turn = side === 'right' ? 90 : -90;
  return run.map((point, i) => (distanceKm === 0 ? [point.lon, point.lat] : destination(point, heading[i]! + turn, distanceKm)));
}

function clipLon(ring: Array<[number, number]>, bound: number, keep: (lon: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (keep(a[0])) out.push(a);
    if (keep(a[0]) !== keep(b[0])) {
      const f = (bound - a[0]) / (b[0] - a[0]);
      out.push([bound, a[1] + (b[1] - a[1]) * f]);
    }
  }
  return out;
}

function counterClockwise(ring: FootprintRing): FootprintRing {
  let twiceArea = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) twiceArea += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return twiceArea < 0 ? [...ring].reverse() : ring;
}

/** Cuts a ring with continuous longitudes into pieces that each sit inside -180..180. */
function splitAtAntimeridian(ring: Array<[number, number]>): FootprintRing[] {
  const lons = ring.map(([lon]) => lon);
  const minShift = Math.floor((Math.min(...lons) + 180) / 360);
  const maxShift = Math.floor((Math.max(...lons) + 180) / 360);
  const pieces: FootprintRing[] = [];
  for (let k = minShift; k <= maxShift; k += 1) {
    const shifted = ring.map(([lon, lat]): [number, number] => [lon - 360 * k, lat]);
    const clipped = clipLon(clipLon(shifted, -180, (lon) => lon >= -180), 180, (lon) => lon <= 180);
    if (clipped.length < 3) continue;
    pieces.push(counterClockwise([...clipped, clipped[0]!]));
  }
  return pieces;
}

function footprintRings(run: TrackPoint[], footprint: Footprint, altitudeKm: number): FootprintRing[] {
  if (run.length < 2) return [];
  const band = footprintBand(footprint, altitudeKm);
  if (band.sides.length === 0 || !(band.farKm > band.nearKm)) return [];
  const heading = headings(run);
  const rings: Array<Array<[number, number]>> = band.nearKm === 0 && band.sides.length === 2
    ? [[...edge(run, heading, 'left', band.farKm), ...edge(run, heading, 'right', band.farKm).reverse()]]
    : band.sides.map((side) => [...edge(run, heading, side, band.farKm), ...edge(run, heading, side, band.nearKm).reverse()]);
  return rings.flatMap(splitAtAntimeridian);
}

function trackSegments(elements: OrbitElements, startMs: number, endMs: number, stepSeconds: number): TrackPoint[][] {
  try {
    return groundTrack(elements, { start: startMs, end: endMs }, stepSeconds)
      .map((segment) => segment.map(toTrackPoint))
      .filter((segment) => segment.length > 0);
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
}

/** The ground track around a pass's closest approach and the footprint its sensor covered there; null when the orbit gives no track. */
export function buildPassTrack(elements: OrbitElements, footprint: Footprint, pass: TrackPass, options: PassTrackOptions = {}): PassTrack | null {
  const { trackHalfMinutes = 12, footprintHalfMinutes = 4, stepSeconds = 20 } = options;
  const startMs = pass.timeMs - trackHalfMinutes * MINUTE_MS;
  const endMs = pass.timeMs + trackHalfMinutes * MINUTE_MS;
  const segments = trackSegments(elements, startMs, endMs, stepSeconds);
  if (segments.flat().length < 2) return null;
  const near = trackSegments(elements, pass.timeMs - footprintHalfMinutes * MINUTE_MS, pass.timeMs + footprintHalfMinutes * MINUTE_MS, stepSeconds);
  return {
    key: passTrackKey(pass),
    name: pass.name,
    startMs,
    endMs,
    closest: { lon: pass.subSatellite.lon, lat: pass.subSatellite.lat, timeMs: pass.timeMs },
    segments: closeAtAntimeridian(segments),
    footprint: footprintRings(unwrap(near), footprint, pass.altitudeKm),
  };
}

/** Where the satellite was over the ground at a moment of the track, held at the track's ends outside it. */
export function trackPositionAt(track: PassTrack, timeMs: number): TrackPoint {
  const points = track.segments.flat();
  const first = points[0]!;
  if (timeMs <= first.timeMs) return first;
  for (const segment of track.segments) {
    for (let i = 1; i < segment.length; i += 1) {
      const a = segment[i - 1]!;
      const b = segment[i]!;
      if (timeMs > b.timeMs) continue;
      const f = b.timeMs === a.timeMs ? 0 : (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
      return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, timeMs };
    }
  }
  return points[points.length - 1]!;
}
