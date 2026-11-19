import { footprintBand, groundTrack, type GroundTrackPoint, type OrbitElements } from '../../../shared/orbital/pass-geometry.js';
import type { Footprint } from '../../../shared/orbital/sensor-profiles.js';
import { passTrackKey, sideRings, unwrap, type PassTrack, type SwathSide, type TrackPass, type TrackPoint } from './track-geometry';

// Building a track needs the orbit maths, so it lives apart from the drawing helpers the map renderers import.

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const MINUTE_MS = 60_000;

export interface PassTrackOptions {
  trackHalfMinutes?: number;
  footprintHalfMinutes?: number;
  stepSeconds?: number;
}

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
