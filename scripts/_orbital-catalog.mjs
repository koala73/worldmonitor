import { parseOrbitElements } from './shared/orbital/pass-geometry.js';
import { matchSensorProfile, SENSOR_INVENTORY_VERSION } from './shared/orbital/sensor-profiles.js';

export const ORBITAL_CATALOG_KEY = 'orbital:catalog:v1';
export const ORBITAL_CATALOG_ACTIVATION_KEY = 'seed-activated:orbital:catalog';
export const CELESTRAK_ACTIVE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
export const CATALOG_SCHEMA = 1;
// Today plus the 7 prior days the lookup lists past passes for.
export const RING_DAYS = 8;

const DAY_MS = 86_400_000;

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseable(omm) {
  try {
    const elements = parseOrbitElements(omm);
    return Number.isFinite(elements.epochMs) && elements.satrec?.error === 0 ? elements : null;
  } catch {
    return null;
  }
}

/** Profiled satellites only, one per NORAD id (the newest epoch wins), ordered by id. */
export function selectProfiledSatellites(records) {
  const byId = new Map();
  for (const omm of Array.isArray(records) ? records : []) {
    if (!omm || typeof omm !== 'object') continue;
    const elements = parseable(omm);
    if (!elements) continue;
    const profile = matchSensorProfile(elements.noradId, elements.name);
    if (!profile) continue;
    const held = byId.get(elements.noradId);
    if (held && held.epochMs >= elements.epochMs) continue;
    byId.set(elements.noradId, {
      epochMs: elements.epochMs,
      satellite: { noradId: elements.noradId, name: elements.name, profileId: profile.id, elements: omm },
    });
  }
  return [...byId.values()].map((entry) => entry.satellite).sort((a, b) => a.noradId - b.noradId);
}

/** Replaces the entry for `entry.day`, keeps the prior days inside the ring, oldest first. */
export function mergeRing(previousRing, entry, ringDays = RING_DAYS) {
  const oldestDay = utcDay(Date.parse(`${entry.day}T00:00:00Z`) - (ringDays - 1) * DAY_MS);
  const prior = (Array.isArray(previousRing) ? previousRing : [])
    .filter((held) => typeof held?.day === 'string' && held.day >= oldestDay && held.day < entry.day);
  return [...prior, entry].sort((a, b) => a.day.localeCompare(b.day));
}

export function buildCatalog({ records, previous, nowMs }) {
  const satellites = selectProfiledSatellites(records);
  const day = { day: utcDay(nowMs), fetchedAt: nowMs, elements: satellites.map((s) => s.elements) };
  return {
    schema: CATALOG_SCHEMA,
    inventoryVersion: SENSOR_INVENTORY_VERSION,
    source: CELESTRAK_ACTIVE_URL,
    fetchedAt: nowMs,
    satellites,
    ring: mergeRing(previous?.ring, day),
  };
}
