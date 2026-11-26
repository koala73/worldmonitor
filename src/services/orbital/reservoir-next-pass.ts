import { footprintBand, groundTrack, parseOrbitElements, ORBIT_ELEMENTS_MAX_AGE_DAYS, type OrbitElements } from '../../../shared/orbital/pass-geometry.js';
import type { OrbitalCatalog } from './catalog-shape';
import { profileFor } from './pass-query';

export const RESERVOIR_NEXT_PASS_WINDOW_DAYS = 7;
const TRACK_STEP_S = 10;
const KM_PER_DEG_LAT = 111.32;
const DAY_MS = 86_400_000;

/** Lake extent the lidar must cross: [west, south, east, north] in degrees. */
export type ReservoirExtent = readonly [number, number, number, number];
export interface ReservoirPassSite { id: string; core: ReservoirExtent }

export { ICESAT2_PROFILE_ID, reservoirNextPassExpiresAt, type ReservoirNextPass } from './reservoir-next-pass-expiry';
import { ICESAT2_PROFILE_ID, type ReservoirNextPass } from './reservoir-next-pass-expiry';

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

type PassCatalog = Pick<OrbitalCatalog, 'satellites'>;

function latestIcesatElements(catalog: PassCatalog, nowMs: number): OrbitElements | null {
  const satellite = catalog.satellites.find(sat => sat.profileId === ICESAT2_PROFILE_ID);
  const record = satellite?.elementSets[satellite.elementSets.length - 1];
  if (!record) return null;
  const elements = parseOrbitElements(record);
  return nowMs - elements.epochMs <= ORBIT_ELEMENTS_MAX_AGE_DAYS * DAY_MS ? elements : null;
}

/** Orbit samples are generated and scanned one day of track at a time, so each step is a few milliseconds of work. */
const TRACK_CHUNK_MS = DAY_MS;

/**
 * Resolves each lake's first crossing a day of ground track at a time and yields after every day.
 * Consecutive chunks share one sample so no segment is lost at a chunk boundary, which keeps the
 * result identical to scanning the whole window in one go.
 */
function* reservoirNextPassSteps(catalog: PassCatalog, sites: readonly ReservoirPassSite[], nowMs: number, windowDays: number): Generator<void, Map<string, ReservoirNextPass> | null> {
  const profile = profileFor(ICESAT2_PROFILE_ID);
  const elements = profile ? latestIcesatElements(catalog, nowMs) : null;
  if (!profile || !elements) return null;
  const windowEndMs = nowMs + windowDays * DAY_MS;
  const halfSwathKm = footprintBand(profile.footprint, 500).farKm;
  const boxes = new Map(sites.map(site => [site.id, expandExtent(site.core, halfSwathKm)] as const));
  const found = new Map<string, number>();
  for (let chunkStart = nowMs; chunkStart < windowEndMs && found.size < boxes.size; chunkStart += TRACK_CHUNK_MS) {
    const chunkEnd = Math.min(windowEndMs, chunkStart + TRACK_CHUNK_MS + TRACK_STEP_S * 1000);
    const track = groundTrack(elements, { start: chunkStart, end: chunkEnd }, TRACK_STEP_S);
    for (const [id, box] of boxes) {
      if (found.has(id)) continue;
      for (const segment of track) {
        for (let i = 1; i < segment.length && !found.has(id); i++) {
          const t = crossesExtent(segment[i - 1]!, segment[i]!, box);
          if (t !== null) {
            const startMs = Date.parse(segment[i - 1]!.time);
            found.set(id, startMs + t * (Date.parse(segment[i]!.time) - startMs));
          }
        }
        if (found.has(id)) break;
      }
    }
    yield;
  }
  const result = new Map<string, ReservoirNextPass>();
  for (const site of sites) {
    const first = found.get(site.id);
    result.set(site.id, first === undefined
      ? { status: 'none', windowEndMs, elementsEpochMs: elements.epochMs }
      : { status: 'pass', timeMs: Math.round(first), windowEndMs, elementsEpochMs: elements.epochMs });
  }
  return result;
}

/**
 * First predicted ICESat-2 crossing of each lake within the window, from the seeded orbital catalog.
 * Synchronous: it holds the thread for the whole window (about 150 ms), so browser code uses the async form instead.
 */
export function computeReservoirNextPasses(catalog: PassCatalog, sites: readonly ReservoirPassSite[], nowMs = Date.now(), windowDays = RESERVOIR_NEXT_PASS_WINDOW_DAYS): Map<string, ReservoirNextPass> | null {
  const steps = reservoirNextPassSteps(catalog, sites, nowMs, windowDays);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Same answer as `computeReservoirNextPasses`, yielding to the event loop between day-sized steps. Resolves null when cancelled or when there is no usable ICESat-2 element set. */
export async function computeReservoirNextPassesChunked(
  catalog: PassCatalog,
  sites: readonly ReservoirPassSite[],
  hooks: { isCancelled?: () => boolean } = {},
  nowMs = Date.now(),
  windowDays = RESERVOIR_NEXT_PASS_WINDOW_DAYS,
): Promise<Map<string, ReservoirNextPass> | null> {
  const steps = reservoirNextPassSteps(catalog, sites, nowMs, windowDays);
  for (;;) {
    if (hooks.isCancelled?.()) return null;
    const step = steps.next();
    if (step.done) return step.value;
    await yieldToEventLoop();
  }
}
