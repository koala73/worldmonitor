/**
 * Candidate orbit manoeuvres for the satellite card and a watched site's satellite list (#9110).
 *
 * Reads the public candidate list the manoeuvre seeder publishes. A candidate is a step in a
 * satellite's orbit elements that left its own trend; it is never shown as a confirmed burn.
 * Every failure, and a stale list, reads as "no marker": the marker only ever adds a fact.
 */
import type { ListSatelliteManeuversResponse, ManeuverCandidate } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';

export type { ManeuverCandidate };

/** A candidate older than this, by the epoch after the step, no longer marks the satellite. */
export const MANEUVER_MARKER_DAYS = 14;
const DAY_MS = 86_400_000;
const LIST_TTL_MS = 15 * 60_000;

const getOrbitalClient = createLazyClient(() => new OrbitalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

/** The newest recent candidate per satellite, keyed by NORAD id; empty for a stale list. */
export function recentManeuvers(response: ListSatelliteManeuversResponse, nowMs: number): Map<string, ManeuverCandidate> {
  const recent = new Map<string, ManeuverCandidate>();
  if (response.stale) return recent;
  for (const candidate of response.candidates) {
    const afterMs = candidate.toEpoch;
    if (!Number.isFinite(afterMs) || nowMs - afterMs > MANEUVER_MARKER_DAYS * DAY_MS) continue;
    const id = String(candidate.noradId);
    const held = recent.get(id);
    if (!held || held.toEpoch < afterMs) recent.set(id, candidate);
  }
  return recent;
}

/** When the first of these candidates ages out of the marker window, or Infinity. */
function firstExpiryMs(recent: ReadonlyMap<string, ManeuverCandidate>): number {
  let first = Number.POSITIVE_INFINITY;
  for (const candidate of recent.values()) first = Math.min(first, candidate.toEpoch + MANEUVER_MARKER_DAYS * DAY_MS);
  return first;
}

/** A failed read answers "no marker" for this long, so an open sheet does not refetch and redraw every tick. */
const FAILURE_TTL_MS = 60_000;

let cached: { promise: Promise<Map<string, ManeuverCandidate>>; expiresAt: number } | null = null;

/**
 * Recent candidates, shared for 15 minutes, or until the first of them ages out of the marker
 * window. Never rejects: a failed read is an empty map for a minute, then retried.
 */
export function loadRecentManeuvers(nowMs = Date.now()): Promise<Map<string, ManeuverCandidate>> {
  if (cached && nowMs < cached.expiresAt) return cached.promise;
  const entry = {
    expiresAt: nowMs + LIST_TTL_MS,
    promise: getOrbitalClient().listSatelliteManeuvers({ noradId: 0 })
      .then((response) => {
        const recent = recentManeuvers(response, Date.now());
        entry.expiresAt = Math.min(entry.expiresAt, firstExpiryMs(recent));
        return recent;
      })
      .catch((error: unknown) => {
        console.warn('[orbital] candidate manoeuvres unavailable', error);
        entry.expiresAt = Math.min(entry.expiresAt, Date.now() + FAILURE_TTL_MS);
        return new Map<string, ManeuverCandidate>();
      }),
  };
  cached = entry;
  return entry.promise;
}

/** Test hook: forget the shared list. */
export function resetManeuverCache(): void {
  cached = null;
}

/** The locale key under orbitalWatch.satelliteSites and its values for one candidate's change. */
export function maneuverChange(candidate: ManeuverCandidate): { key: string; values: Record<string, string> } {
  const size = Math.abs(candidate.residual);
  if (candidate.element === 'semiMajorAxis') {
    return { key: candidate.residual >= 0 ? 'maneuverRaised' : 'maneuverLowered', values: { km: size.toFixed(1) } };
  }
  const deg = size < 0.1 ? size.toFixed(3) : size.toFixed(2);
  return { key: candidate.element === 'inclination' ? 'maneuverInclination' : 'maneuverPlane', values: { deg } };
}

const SYMBOL: Record<string, string> = { semiMajorAxis: 'a', inclination: 'i', raan: 'Ω' };
const utcMinute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The receipt's values for the locale key maneuverReceipt: the element in both element sets, how
 * far the step left the trend, the threshold it crossed, and the two epochs compared (#9110).
 * The node is shown as published; the trend it is judged against has J2 regression removed.
 */
export function maneuverReceipt(candidate: ManeuverCandidate): Record<string, string> | null {
  const { before, after } = candidate;
  if (!before || !after) return null;
  const km = candidate.element === 'semiMajorAxis';
  const value = (set: NonNullable<ManeuverCandidate['before']>) => (km ? set.semiMajorAxisKm : candidate.element === 'inclination' ? set.inclination : set.raan);
  const fmt = (n: number) => (km ? `${n.toFixed(2)} km` : `${n.toFixed(4)}°`);
  const delta = (n: number) => (km ? `${n >= 0 ? '+' : ''}${n.toFixed(2)} km` : `${n >= 0 ? '+' : ''}${n.toFixed(4)}°`);
  return {
    symbol: SYMBOL[candidate.element] ?? candidate.element,
    before: fmt(value(before)),
    after: fmt(value(after)),
    residual: delta(candidate.residual),
    threshold: `±${km ? `${candidate.threshold.toFixed(2)} km` : `${candidate.threshold.toFixed(4)}°`}`,
    from: utcMinute(candidate.fromEpoch),
    to: utcMinute(candidate.toEpoch),
  };
}

/** The UTC day of the epoch after the step, YYYY-MM-DD. */
export function maneuverDay(candidate: ManeuverCandidate): string {
  return new Date(candidate.toEpoch).toISOString().slice(0, 10);
}
