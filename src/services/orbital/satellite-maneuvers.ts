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
    const afterMs = Date.parse(candidate.toEpoch);
    if (!Number.isFinite(afterMs) || nowMs - afterMs > MANEUVER_MARKER_DAYS * DAY_MS) continue;
    const id = String(candidate.noradId);
    const held = recent.get(id);
    if (!held || Date.parse(held.toEpoch) < afterMs) recent.set(id, candidate);
  }
  return recent;
}

let cached: { promise: Promise<Map<string, ManeuverCandidate>>; loadedAt: number } | null = null;

/** Recent candidates, shared for 15 minutes. Never rejects: a failed read is an empty map and is retried next time. */
export function loadRecentManeuvers(nowMs = Date.now()): Promise<Map<string, ManeuverCandidate>> {
  if (cached && nowMs - cached.loadedAt < LIST_TTL_MS) return cached.promise;
  const entry = {
    loadedAt: nowMs,
    promise: getOrbitalClient().listSatelliteManeuvers({ noradId: 0 })
      .then((response) => recentManeuvers(response, Date.now()))
      .catch((error: unknown) => {
        console.warn('[orbital] candidate manoeuvres unavailable', error);
        if (cached === entry) cached = null;
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

/** The UTC day of the epoch after the step, YYYY-MM-DD. */
export function maneuverDay(candidate: ManeuverCandidate): string {
  return candidate.toEpoch.slice(0, 10);
}
