import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES, type SensorProfile } from '../../../shared/orbital/sensor-profiles.js';

const DAY_MS = 86_400_000;
/** Mirrors the pass geometry limit without loading satellite.js on the main thread. */
export const PASS_QUERY_MAX_DAYS = 10;

export interface PassWindow {
  startMs: number;
  endMs: number;
}

const PROFILES_BY_ID = new Map(SENSOR_PROFILES.map((profile) => [profile.id, profile]));

export function profileFor(profileId: string): SensorProfile | undefined {
  return PROFILES_BY_ID.get(profileId);
}

export function assertPassQuery(point: GeoPoint, window: PassWindow): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    throw new RangeError('point must have a finite latitude within ±90 and longitude within ±180');
  }
  const { startMs, endMs } = window;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > PASS_QUERY_MAX_DAYS * DAY_MS) {
    throw new RangeError(`window must be finite, ordered and at most ${PASS_QUERY_MAX_DAYS} days long`);
  }
}
