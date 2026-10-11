import { getRawJson } from '../../../_shared/redis';

// Seed-owned military flight snapshots written by scripts/seed-military-flights.mjs
// and read by list-military-flights.ts.
export const MILITARY_FLIGHTS_SEED_KEY = 'military:flights:v1';
export const MILITARY_FLIGHTS_STALE_KEY = 'military:flights:stale:v1';

const TRACKED_SET_TTL_MS = 60_000;

let trackedCache: { set: ReadonlySet<string> | null; expiresAt: number } | null = null;
let trackedInflight: Promise<ReadonlySet<string> | null> | null = null;

function collectHexCodes(payload: unknown, into: Set<string>): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const flights = (payload as { flights?: unknown }).flights;
  if (!Array.isArray(flights)) return false;
  for (const flight of flights) {
    if (!flight || typeof flight !== 'object') continue;
    const { hexCode, id } = flight as { hexCode?: unknown; id?: unknown };
    const hex = typeof hexCode === 'string' && hexCode ? hexCode : typeof id === 'string' ? id : '';
    if (hex) into.add(hex.trim().toLowerCase());
  }
  return true;
}

async function loadTrackedAircraft(): Promise<ReadonlySet<string> | null> {
  const set = new Set<string>();
  let found = false;
  for (const key of [MILITARY_FLIGHTS_SEED_KEY, MILITARY_FLIGHTS_STALE_KEY]) {
    try {
      if (collectHexCodes(await getRawJson(key), set)) found = true;
    } catch { /* an unreadable snapshot counts as absent */ }
  }
  return found ? set : null;
}

/**
 * ICAO24 addresses (lowercase) present in the current or last-good military
 * flight snapshot, or null when neither snapshot exists.
 *
 * The anonymous batch-details route uses this to spend the Wingbits credential
 * only on aircraft the map can actually show. Null means there is no snapshot
 * to check against (the desktop sidecar has no seed, or the seed is down), and
 * the caller keeps its previous behaviour.
 */
export async function getTrackedAircraftIcao24s(): Promise<ReadonlySet<string> | null> {
  const now = Date.now();
  if (trackedCache && now < trackedCache.expiresAt) return trackedCache.set;
  if (!trackedInflight) {
    trackedInflight = loadTrackedAircraft()
      .then((set) => {
        trackedCache = { set, expiresAt: Date.now() + TRACKED_SET_TTL_MS };
        return set;
      })
      .finally(() => { trackedInflight = null; });
  }
  return trackedInflight;
}

export function _resetTrackedAircraftCacheForTests(): void {
  trackedCache = null;
  trackedInflight = null;
}
