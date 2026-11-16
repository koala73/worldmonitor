/**
 * RPC: listSatelliteManeuvers -- serves the candidate manoeuvres that
 * scripts/seed-orbital-maneuvers.mjs publishes (#9110). Nothing is computed here.
 *
 * Every row is a candidate: a step in one element that left the satellite's own
 * trend and was confirmed by the next epoch. The per-satellite statuses say which
 * satellites could be judged, so an empty candidate list is never an all-clear.
 */
import type {
  ListSatelliteManeuversRequest,
  ListSatelliteManeuversResponse,
  ManeuverCandidate,
  ManeuverElementSet,
  SatelliteManeuverStatus,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ORBITAL_MANEUVERS_KEY } from '../../../_shared/cache-keys';
import { readCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

/** Must equal api/health.js SEED_META.orbitalManeuvers.maxStaleMin; pinned by tests. */
export const ORBITAL_MANEUVERS_MAX_STALE_MINUTES = 1440;

const NO_LIST_NOTE = 'No candidate list is stored, so no satellite was judged.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toElementSet(value: unknown): ManeuverElementSet | undefined {
  if (!isRecord(value)) return undefined;
  return {
    epoch: str(value.epoch),
    meanMotion: num(value.meanMotion),
    semiMajorAxisKm: num(value.semiMajorAxisKm),
    eccentricity: num(value.eccentricity),
    inclination: num(value.inclination),
    raan: num(value.raan),
    bstar: num(value.bstar),
  };
}

function toCandidate(value: unknown): ManeuverCandidate | null {
  if (!isRecord(value) || value.kind !== 'candidate') return null;
  const before = toElementSet(value.before);
  const after = toElementSet(value.after);
  if (!before || !after) return null;
  return {
    noradId: num(value.noradId),
    element: str(value.element),
    unit: str(value.unit),
    regime: str(value.regime),
    fromEpoch: str(value.fromEpoch),
    toEpoch: str(value.toEpoch),
    confirmedByEpoch: str(value.confirmedByEpoch),
    expected: num(value.expected),
    observed: num(value.observed),
    residual: num(value.residual),
    threshold: num(value.threshold),
    before,
    after,
  };
}

function toStatus(value: unknown): SatelliteManeuverStatus | null {
  if (!isRecord(value)) return null;
  return { noradId: num(value.noradId), status: str(value.status), regime: str(value.regime), candidateCount: num(value.candidateCount) };
}

function emptyList(): ListSatelliteManeuversResponse {
  return { candidates: [], satellites: [], evaluatedSatellites: 0, generatedAt: 0, detectionVersion: 0, methodNote: NO_LIST_NOTE, stale: true };
}

/** Shapes the stored list, optionally for one satellite; stale when absent, unreadable or older than the health limit. */
export function toManeuversResponse(value: unknown, nowMs: number, noradId = 0): ListSatelliteManeuversResponse {
  if (!isRecord(value) || !Array.isArray(value.candidates) || !Array.isArray(value.satellites) || !Number.isFinite(value.generatedAt)) {
    return emptyList();
  }
  const keep = (id: number) => noradId === 0 || id === noradId;
  const candidates = value.candidates.map(toCandidate).filter((c): c is ManeuverCandidate => c !== null && keep(c.noradId));
  const satellites = value.satellites.map(toStatus).filter((s): s is SatelliteManeuverStatus => s !== null && keep(s.noradId));
  const generatedAt = value.generatedAt as number;
  const method = isRecord(value.method) ? value.method : {};
  return {
    candidates,
    satellites,
    evaluatedSatellites: satellites.filter((s) => s.status === 'evaluated').length,
    generatedAt,
    detectionVersion: num(value.detectionVersion),
    methodNote: str(method.drag),
    stale: nowMs - generatedAt > ORBITAL_MANEUVERS_MAX_STALE_MINUTES * 60_000,
  };
}

/** Serves the seeded candidate list; a missing or unreadable key yields an uncached empty stale list. */
export async function listSatelliteManeuvers(
  ctx: ServerContext,
  req: ListSatelliteManeuversRequest,
): Promise<ListSatelliteManeuversResponse> {
  const read = await readCachedJson(ORBITAL_MANEUVERS_KEY, true);
  if (read.status === 'error') {
    const message = read.error instanceof Error ? read.error.message : String(read.error);
    console.warn(`[orbital-maneuvers] ${ORBITAL_MANEUVERS_KEY} read failed: ${message}`);
  }
  const noradId = Number.isInteger(req.noradId) && req.noradId > 0 ? req.noradId : 0;
  const response = read.status === 'hit' ? toManeuversResponse(read.value, Date.now(), noradId) : emptyList();
  // A missing list must not sit in the CDN for the slow tier's hour after the seeder recovers.
  return response.generatedAt === 0 ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
