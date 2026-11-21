import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { EventPair } from './event-imagery';

/** Window event a map popup's "Open evidence" sends with the object's point; the app opens the point lookup. */
export const ORBITAL_EVIDENCE_EVENT = 'wm:orbital-open-evidence';

/** Window event a map popup's "Before / after" sends with the event's point, time and found pair; the app opens Compare. */
export const ORBITAL_EVENT_COMPARE_EVENT = 'wm:orbital-open-event-compare';

export interface OrbitalEventCompareDetail {
  point: GeoPoint;
  eventMs: number;
  pair: Extract<EventPair, { status: 'ok' }>;
}
