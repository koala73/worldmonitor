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
  /** The footprint's edges sample by sample, so a replay can draw the ground swept so far. */
  swath: SwathSide[];
}

/** One band of a footprint: its two edges, sampled at the same moments, with longitudes continuous along the track. */
export interface SwathSide {
  timesMs: number[];
  inner: Array<[number, number]>;
  outer: Array<[number, number]>;
}

/** The ground a sensor had swept by a moment of its pass, and the line it was imaging then. */
export interface SweptSwath {
  rings: FootprintRing[];
  leadingEdge: Array<Array<[number, number]>>;
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

/** The swath edge on one side, its longitudes kept continuous along the track; null when it wraps over a pole. */
function edge(run: TrackPoint[], heading: number[], side: 'left' | 'right', distanceKm: number): Array<[number, number]> | null {
  const turn = side === 'right' ? 90 : -90;
  const points: Array<[number, number]> = [];
  for (let i = 0; i < run.length; i += 1) {
    const point = run[i]!;
    let [lon, lat] = distanceKm === 0 ? [point.lon, point.lat] : destination(point, heading[i]! + turn, distanceKm);
    lon += 360 * Math.round((point.lon - lon) / 360);
    const previous = points[points.length - 1];
    if (previous && Math.abs(lon - previous[0]) > 90) return null;
    points.push([lon, lat]);
  }
  return points;
}

function band(left: Array<[number, number]> | null, right: Array<[number, number]> | null): Array<[number, number]> | null {
  return left && right ? [...left, ...right.reverse()] : null;
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

function swathSides(run: TrackPoint[], footprint: Footprint, altitudeKm: number): SwathSide[] {
  if (run.length < 2) return [];
  const reach = footprintBand(footprint, altitudeKm);
  if (reach.sides.length === 0 || !(reach.farKm > reach.nearKm)) return [];
  const heading = headings(run);
  const timesMs = run.map((point) => point.timeMs);
  const pairs = reach.nearKm === 0 && reach.sides.length === 2
    ? [[edge(run, heading, 'left', reach.farKm), edge(run, heading, 'right', reach.farKm)]]
    : reach.sides.map((side) => [edge(run, heading, side, reach.nearKm), edge(run, heading, side, reach.farKm)]);
  return pairs.flatMap(([inner, outer]) => (inner && outer ? [{ timesMs, inner, outer }] : []));
}

const sideRings = (side: SwathSide): FootprintRing[] => splitAtAntimeridian(band([...side.inner], [...side.outer])!);

/** Cuts a line with continuous longitudes into pieces that each sit inside -180..180. */
function splitLine(line: Array<[number, number]>): Array<Array<[number, number]>> {
  const pieces: Array<Array<[number, number]>> = [];
  let piece: Array<[number, number]> = [];
  let shift = Math.floor((line[0]![0] + 180) / 360);
  for (const [lon, lat] of line) {
    const k = Math.floor((lon + 180) / 360);
    if (k !== shift && piece.length > 0) {
      const last = piece[piece.length - 1]!;
      const bound = k > shift ? 180 : -180;
      const local = lon - 360 * shift;
      const f = (bound - last[0]) / (local - last[0]);
      const crossLat = last[1] + (lat - last[1]) * f;
      piece.push([bound, crossLat]);
      pieces.push(piece);
      piece = [[-bound, crossLat]];
      shift = k;
    }
    piece.push([lon - 360 * shift, lat]);
  }
  if (piece.length > 1) pieces.push(piece);
  return pieces;
}

const lerp = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** The part of each footprint band swept by a moment of the pass, and the cross-track line at that moment. */
export function sweptSwath(track: Pick<PassTrack, 'swath'>, timeMs: number): SweptSwath {
  const rings: FootprintRing[] = [];
  const leadingEdge: Array<Array<[number, number]>> = [];
  for (const side of track.swath) {
    const { timesMs, inner, outer } = side;
    if (timesMs.length < 2 || timeMs <= timesMs[0]!) continue;
    let k = timesMs.findIndex((t) => t >= timeMs);
    if (k < 0) k = timesMs.length - 1;
    const f = timesMs[k] === timesMs[k - 1] ? 1 : Math.min(1, (timeMs - timesMs[k - 1]!) / (timesMs[k]! - timesMs[k - 1]!));
    const innerAt = lerp(inner[k - 1]!, inner[k]!, f);
    const outerAt = lerp(outer[k - 1]!, outer[k]!, f);
    rings.push(...splitAtAntimeridian(band([...inner.slice(0, k), innerAt], [...outer.slice(0, k), outerAt])!));
    leadingEdge.push(...splitLine([innerAt, outerAt]));
  }
  return { rings, leadingEdge };
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
  const swath = swathSides(unwrap(near), footprint, pass.altitudeKm);
  return {
    key: passTrackKey(pass),
    name: pass.name,
    startMs,
    endMs,
    closest: { lon: pass.subSatellite.lon, lat: pass.subSatellite.lat, timeMs: pass.timeMs },
    segments: closeAtAntimeridian(segments),
    footprint: swath.flatMap(sideRings),
    swath,
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
