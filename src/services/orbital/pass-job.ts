import {
  findPasses,
  ORBIT_ELEMENTS_MAX_AGE_DAYS,
  parseOrbitElements,
  type GeoPoint,
  type GeostationaryVisibility,
  type OmmRecord,
  type OrbitElements,
  type Pass,
} from '../../../shared/orbital/pass-geometry.js';
import { decidePassTier, type PassTier } from '../../../shared/orbital/tiers.js';
import { assertPassQuery, profileFor, type PassWindow } from './pass-query';

export type { PassWindow };

const DAY_MS = 86_400_000;
const DUPLICATE_PASS_MS = 60_000;

export interface CatalogSatellite {
  noradId: number;
  name: string;
  profileId: string;
  /** Every published element set for the satellite, oldest epoch first. */
  elementSets: OmmRecord[];
}

export interface PassJobInput {
  point: GeoPoint;
  window: PassWindow;
  nowMs: number;
  satellites: CatalogSatellite[];
}

export interface PointPass extends Pass {
  tier: PassTier;
  elementsEpochMs: number;
  /** Distance in days between the pass and the epoch of the orbit data it was computed from. */
  orbitAgeDays: number;
}

export type SatelliteOutcome =
  | { noradId: number; name: string; profileId: string; status: 'ok' | 'too-old' | 'invalid-elements' }
  | { noradId: number; name: string; profileId: string; status: 'geostationary'; visibility: GeostationaryVisibility };

export interface PassJobResult {
  passes: PointPass[];
  satellites: SatelliteOutcome[];
}

export interface PassJobHooks {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  batchSize?: number;
}

function parseSets(records: OmmRecord[]): OrbitElements[] {
  const parsed: OrbitElements[] = [];
  for (const record of records) {
    try {
      const elements = parseOrbitElements(record);
      if (elements.satrec.error === 0 && Number.isFinite(elements.epochMs) && Number.isFinite(elements.meanMotionRevPerDay) && elements.meanMotionRevPerDay > 0) parsed.push(elements);
    } catch {
      // A malformed element set is skipped; the satellite falls back to its other sets.
    }
  }
  return parsed.sort((a, b) => a.epochMs - b.epochMs);
}

/** Each element set owns the part of the window closest in time to its epoch, because propagating one set across days drifts. */
function segmentsByNearestEpoch(sets: OrbitElements[], window: PassWindow): Array<{ elements: OrbitElements; startMs: number; endMs: number }> {
  const segments: Array<{ elements: OrbitElements; startMs: number; endMs: number }> = [];
  sets.forEach((elements, index) => {
    const previous = sets[index - 1];
    const next = sets[index + 1];
    const startMs = Math.max(window.startMs, previous ? (previous.epochMs + elements.epochMs) / 2 : -Infinity);
    const endMs = Math.min(window.endMs, next ? (elements.epochMs + next.epochMs) / 2 : Infinity);
    if (endMs > startMs) segments.push({ elements, startMs, endMs });
  });
  return segments;
}

function satellitePasses(satellite: CatalogSatellite, input: PassJobInput): { outcome: SatelliteOutcome; passes: PointPass[] } {
  const identity = { noradId: satellite.noradId, name: satellite.name, profileId: satellite.profileId };
  const profile = profileFor(satellite.profileId);
  const sets = parseSets(satellite.elementSets);
  if (!profile || sets.length === 0) return { outcome: { ...identity, status: 'invalid-elements' }, passes: [] };

  const passes: PointPass[] = [];
  let anyFresh = false;
  const usable = sets.filter((elements) => (input.nowMs - elements.epochMs) / DAY_MS <= ORBIT_ELEMENTS_MAX_AGE_DAYS);
  const segments = usable.length > 0
    ? segmentsByNearestEpoch(usable, input.window)
    : [{ elements: sets[sets.length - 1]!, startMs: input.window.startMs, endMs: input.window.endMs }];
  for (const segment of segments) {
    const search = findPasses({
      elements: segment.elements,
      profile,
      point: input.point,
      window: { start: segment.startMs, end: segment.endMs },
      now: input.nowMs,
    });
    if (search.status === 'geostationary') {
      const latest = findPasses({ elements: segments[segments.length - 1]!.elements, profile, point: input.point, window: { start: input.window.startMs, end: input.window.endMs }, now: input.nowMs });
      const visibility = latest.status === 'geostationary' ? latest.visibility : search.visibility;
      return { outcome: { ...identity, status: 'geostationary', visibility }, passes: [] };
    }
    if (search.status === 'too-old') continue;
    anyFresh = true;
    for (const pass of search.passes) {
      if (passes.some((seen) => Math.abs(seen.timeMs - pass.timeMs) < DUPLICATE_PASS_MS)) continue;
      passes.push({
        ...pass,
        tier: decidePassTier(pass, profile, null, input.nowMs),
        elementsEpochMs: segment.elements.epochMs,
        orbitAgeDays: Math.abs(pass.timeMs - segment.elements.epochMs) / DAY_MS,
      });
    }
  }
  return { outcome: { ...identity, status: anyFresh ? 'ok' : 'too-old' }, passes };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Computes passes in small batches, yielding between them so a cancel or other work can run. Resolves null when cancelled. */
export async function runPassJob(input: PassJobInput, hooks: PassJobHooks = {}): Promise<PassJobResult | null> {
  assertPassQuery(input.point, input.window);
  const batchSize = hooks.batchSize ?? 4;
  const total = input.satellites.length;
  const passes: PointPass[] = [];
  const satellites: SatelliteOutcome[] = [];
  for (let index = 0; index < total; index += batchSize) {
    if (hooks.isCancelled?.()) return null;
    for (const satellite of input.satellites.slice(index, index + batchSize)) {
      const computed = satellitePasses(satellite, input);
      satellites.push(computed.outcome);
      passes.push(...computed.passes);
    }
    hooks.onProgress?.(Math.min(index + batchSize, total), total);
    await yieldToEventLoop();
  }
  if (hooks.isCancelled?.()) return null;
  passes.sort((a, b) => a.timeMs - b.timeMs);
  return { passes, satellites };
}

export type PassJobRequest =
  | { type: 'compute'; id: number; input: PassJobInput }
  | { type: 'cancel'; id: number };

export type PassJobReply =
  | { type: 'ready' }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; result: PassJobResult }
  | { type: 'error'; id: number; name: string; message: string };

export function createPassJobHandler(post: (reply: PassJobReply) => void): (request: PassJobRequest) => void {
  const cancelled = new Set<number>();
  return (request) => {
    if (request.type === 'cancel') {
      cancelled.add(request.id);
      return;
    }
    const { id, input } = request;
    const isCancelled = () => cancelled.has(id);
    runPassJob(input, { isCancelled, onProgress: (done, total) => post({ type: 'progress', id, done, total }) })
      .then((result) => {
        if (result) post({ type: 'result', id, result });
      })
      .catch((error: unknown) => {
        if (isCancelled()) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        post({ type: 'error', id, name: failure.name, message: failure.message });
      })
      .finally(() => cancelled.delete(id));
  };
}
