// Drawing helpers only: the map renderers import this on every visit, so the orbit maths
// (pass-geometry, satellite.js, the coverage tables) stays in pass-track.ts.
import type { Pass } from '../../../shared/orbital/pass-geometry.js';

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

export const passTrackKey = (pass: { noradId: number; timeMs: number }) => `${pass.noradId}:${pass.timeMs}`;

/** The segments joined into one run with continuous longitudes, which may leave -180..180. */
export function unwrap(segments: TrackPoint[][]): TrackPoint[] {
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

export const sideRings = (side: SwathSide): FootprintRing[] => splitAtAntimeridian(band([...side.inner], [...side.outer])!);

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

/** A longitude moved by whole turns to sit nearest `aroundLon`. */
const nearLon = (lon: number, aroundLon: number) => lon + 360 * Math.round((aroundLon - lon) / 360);

/** Positions moved together by the whole turns that bring the one at `anchor` nearest `aroundLon`, keeping them continuous. */
function shiftNear(positions: Array<[number, number]>, anchor: number, aroundLon: number): Array<[number, number]> {
  const by = nearLon(positions[anchor]![0], aroundLon) - positions[anchor]![0];
  return positions.map(([lon, lat]) => [lon + by, lat]);
}

/**
 * The part of each footprint band swept by a moment of the pass, and the cross-track line at that moment.
 * By default every piece is cut to -180..180; given `aroundLon`, pieces stay whole with longitudes
 * continuous near it, for a map that draws past ±180.
 */
export function sweptSwath(track: Pick<PassTrack, 'swath'>, timeMs: number, aroundLon?: number): SweptSwath {
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
    const swept = band([...inner.slice(0, k), innerAt], [...outer.slice(0, k), outerAt])!;
    if (aroundLon === undefined) {
      rings.push(...splitAtAntimeridian(swept));
      leadingEdge.push(...splitLine([innerAt, outerAt]));
      continue;
    }
    const whole = shiftNear(swept, k, aroundLon);
    rings.push(counterClockwise([...whole, whole[0]!]));
    leadingEdge.push([whole[k]!, whole[k + 1]!]);
  }
  return { rings, leadingEdge };
}

/** The track and footprint as whole shapes with longitudes continuous near `aroundLon`, for a map that draws past ±180. */
export function continuousTrack(track: Pick<PassTrack, 'segments' | 'swath' | 'closest'>, aroundLon: number): { path: Array<[number, number]>; footprint: FootprintRing[] } {
  const run = unwrap(track.segments).map((point): [number, number] => [point.lon, point.lat]);
  const times = track.segments.flat().map((point) => point.timeMs);
  const at = times.reduce((best, time, i) => (Math.abs(time - track.closest.timeMs) < Math.abs(times[best]! - track.closest.timeMs) ? i : best), 0);
  const footprint = track.swath.map((side) => {
    const ring = shiftNear(band([...side.inner], [...side.outer])!, Math.floor(side.inner.length / 2), aroundLon);
    return counterClockwise([...ring, ring[0]!]);
  });
  return { path: run.length > 0 ? shiftNear(run, at, aroundLon) : [], footprint };
}

/** A track position moved by whole turns to sit nearest `aroundLon`. */
export const pointNear = <T extends { lon: number }>(point: T, aroundLon: number): T => ({ ...point, lon: nearLon(point.lon, aroundLon) });

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

/** The looked-up point as drawn on the map: a reticle with a mono label of one or two lines. */
export interface OrbitalTarget {
  lat: number;
  lon: number;
  lines: string[];
}

export type FrameBounds = [[number, number], [number, number]];

/** How far past the swath line the frame reaches, so both of the swath's side edges show. */
const FRAME_MARGIN = 1.5;

/** A box centred on the point that holds the satellite at closest approach and the swath line imaged then, with a margin; longitudes continuous with the point. */
export function framingBounds(track: PassTrack, target: { lat: number; lon: number }): FrameBounds {
  const positions: Array<[number, number]> = [[track.closest.lon, track.closest.lat]];
  for (const line of sweptSwath(track, track.closest.timeMs).leadingEdge) positions.push(...line);
  const halfLon = FRAME_MARGIN * Math.max(...positions.map(([lon]) => Math.abs(nearLon(lon, target.lon) - target.lon)));
  const halfLat = FRAME_MARGIN * Math.max(...positions.map(([, lat]) => Math.abs(lat - target.lat)));
  return [[target.lon - halfLon, Math.max(-85, target.lat - halfLat)], [target.lon + halfLon, Math.min(85, target.lat + halfLat)]];
}
