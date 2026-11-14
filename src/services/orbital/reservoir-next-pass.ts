import { footprintBand, groundTrack, parseOrbitElements, ORBIT_ELEMENTS_MAX_AGE_DAYS, type OrbitElements } from '../../../shared/orbital/pass-geometry.js';
import type { OrbitalCatalog } from './catalog-shape';
import { profileFor } from './pass-query';

export const ICESAT2_PROFILE_ID = 'icesat-2';
export const RESERVOIR_NEXT_PASS_WINDOW_DAYS = 7;
const TRACK_STEP_S = 10;
const KM_PER_DEG_LAT = 111.32;
const DAY_MS = 86_400_000;

/** Lake extent the lidar must cross: [west, south, east, north] in degrees. */
export type ReservoirExtent = readonly [number, number, number, number];
export interface ReservoirPassSite { id: string; core: ReservoirExtent }

/**
 * A predicted ICESat-2 crossing, never a measurement: `pass` gives the first time the
 * ground track crosses the lake in the window, `none` is the normal answer when the
 * track misses it (ICESat-2 repeats each track every 91 days).
 */
export type ReservoirNextPass =
  | { status: 'pass'; timeMs: number; windowEndMs: number; elementsEpochMs: number }
  | { status: 'none'; windowEndMs: number; elementsEpochMs: number };

/** When a prediction stops being the next one: its crossing time, or the end of a no-crossing window. */
export function reservoirNextPassExpiresAt(pass: ReservoirNextPass): number {
  return pass.status === 'pass' ? pass.timeMs : pass.windowEndMs;
}

function crossesExtent(a: { lat: number; lon: number }, b: { lat: number; lon: number }, [w, s, e, n]: ReservoirExtent): number | null {
  // Liang-Barsky clip of the straight segment a->b against the box; returns the entry fraction.
  let t0 = 0;
  let t1 = 1;
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  for (const [p, q] of [[-dx, a.lon - w], [dx, e - a.lon], [-dy, a.lat - s], [dy, n - a.lat]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t0;
}

function expandExtent([w, s, e, n]: ReservoirExtent, km: number): ReservoirExtent {
  const dLat = km / KM_PER_DEG_LAT;
  const dLon = km / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos(((s + n) / 2) * Math.PI / 180)));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
}

function latestIcesatElements(catalog: OrbitalCatalog, nowMs: number): OrbitElements | null {
  const satellite = catalog.satellites.find(sat => sat.profileId === ICESAT2_PROFILE_ID);
  const record = satellite?.elementSets[satellite.elementSets.length - 1];
  if (!record) return null;
  const elements = parseOrbitElements(record);
  return nowMs - elements.epochMs <= ORBIT_ELEMENTS_MAX_AGE_DAYS * DAY_MS ? elements : null;
}

/** First predicted ICESat-2 crossing of each lake within the window, from the seeded orbital catalog. */
export function computeReservoirNextPasses(catalog: OrbitalCatalog, sites: readonly ReservoirPassSite[], nowMs = Date.now(), windowDays = RESERVOIR_NEXT_PASS_WINDOW_DAYS): Map<string, ReservoirNextPass> | null {
  const profile = profileFor(ICESAT2_PROFILE_ID);
  const elements = profile ? latestIcesatElements(catalog, nowMs) : null;
  if (!profile || !elements) return null;
  const windowEndMs = nowMs + windowDays * DAY_MS;
  const track = groundTrack(elements, { start: nowMs, end: windowEndMs }, TRACK_STEP_S);
  const halfSwathKm = footprintBand(profile.footprint, 500).farKm;
  const result = new Map<string, ReservoirNextPass>();
  for (const site of sites) {
    const box = expandExtent(site.core, halfSwathKm);
    let first: number | null = null;
    for (const segment of track) {
      for (let i = 1; i < segment.length && first === null; i++) {
        const t = crossesExtent(segment[i - 1]!, segment[i]!, box);
        if (t !== null) {
          const startMs = Date.parse(segment[i - 1]!.time);
          first = startMs + t * (Date.parse(segment[i]!.time) - startMs);
        }
      }
      if (first !== null) break;
    }
    result.set(site.id, first === null
      ? { status: 'none', windowEndMs, elementsEpochMs: elements.epochMs }
      : { status: 'pass', timeMs: Math.round(first), windowEndMs, elementsEpochMs: elements.epochMs });
  }
  return result;
}
