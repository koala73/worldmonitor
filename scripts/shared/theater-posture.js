/**
 * The theater posture rule, in one place.
 *
 * The AIS relay is the only writer of `theater-posture:sebuf:v1`: it holds the
 * AIS stream, seeds the USNI roster and fetches theater flights. The dashboard,
 * the MCP tools and the forecasts read the level it publishes and do not
 * recompute it. Before this module there were four rules (the relay, the
 * flights seeder writing the same key with zero vessels, the dashboard's own
 * recalculation with a country-instability boost, and the Insights fallback),
 * so the panel could show CRIT where the API said normal.
 *
 * Lives in `scripts/shared/` because both readers ship it: the seeder's
 * nixpacks container has only `scripts/`, and Dockerfile.relay copies this
 * file by name. `seed-military-flights.mjs` imports the same table.
 * `shared/analysis-military-posture-data.ts` carries the display metadata for
 * the same theaters; tests/theater-posture-rule.test.mjs holds the two tables
 * together.
 */

export const POSTURE_THEATERS = Object.freeze([
  { id: 'iran-theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
].map((theater) => Object.freeze(theater)));

const inBounds = (lat, lon, bounds) =>
  Number.isFinite(lat) && Number.isFinite(lon)
  && lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;

/**
 * Level for each theater from its aircraft and its vessel count.
 *
 * The thresholds were calibrated on aircraft. Vessels add to the aircraft
 * count, capped at half the elevated threshold, so naval traffic alone never
 * raises a level: strict-military AIS counts in busy seas (19 in the Baltic on
 * an ordinary day) would otherwise hold a theater at critical. Ship thresholds
 * of their own wait for the hourly vessel history below. A country's
 * instability score is not an input: a theater is rated on the forces in it.
 *
 * @param {Array<{ lat: number, lon: number, aircraftType?: string }>} flights
 * @param {ReadonlyMap<string, number>} vesselCounts by theater id
 */
export function calculateTheaterPostures(flights, vesselCounts, assessedAt = Date.now()) {
  const list = Array.isArray(flights) ? flights : [];
  return POSTURE_THEATERS.map((theater) => {
    const tf = list.filter((f) => f && inBounds(f.lat, f.lon, theater.bounds));
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const vessels = Math.max(0, Number(vesselCounts?.get(theater.id)) || 0);
    const activity = total + Math.min(vessels, Math.floor(theater.thresholds.elevated / 2));
    const postureLevel = activity >= theater.thresholds.critical ? 'critical'
      : activity >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers
      && awacs >= theater.strikeIndicators.minAwacs && fighters >= theater.strikeIndicators.minFighters;
    const activeOperations = [];
    if (strikeCapable) activeOperations.push('strike_capable');
    if (tankers > 0) activeOperations.push('aerial_refueling');
    if (awacs > 0) activeOperations.push('airborne_early_warning');
    if (vessels > 0) activeOperations.push('naval_presence');
    return { theater: theater.id, postureLevel, activeFlights: total, trackedVessels: vessels, activeOperations, assessedAt };
  });
}

/** Upper-cased, single-spaced ship name, for matching a USNI entry to an AIS contact. */
export function normalizeShipName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

/**
 * Ships on the USNI fleet tracker that are deployed or underway inside the
 * bounds, minus any the AIS stream already counted under the same name.
 * Carriers and their escorts often sail without AIS, so the roster is how the
 * server sees them. USNI positions are region centres, accurate to a region.
 */
export function countUsniVesselsInBounds(usniVessels, bounds, aisNames) {
  if (!Array.isArray(usniVessels)) return 0;
  const seen = new Set([...(aisNames ?? [])].map(normalizeShipName));
  let count = 0;
  for (const vessel of usniVessels) {
    if (!vessel || typeof vessel !== 'object') continue;
    if (vessel.deploymentStatus === 'in-port') continue;
    if (!inBounds(Number(vessel.regionLat), Number(vessel.regionLon), bounds)) continue;
    const name = normalizeShipName(vessel.name);
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    count += 1;
  }
  return count;
}

export const VESSEL_HISTORY_KEY = 'military:theater-vessels:history:v1';
/** Just under an hour, so a 10-minute loop that drifts still lands one entry an hour. */
export const VESSEL_HISTORY_MIN_GAP_MS = 55 * 60_000;
/** 31 days of hourly entries. */
export const VESSEL_HISTORY_MAX_ENTRIES = 31 * 24;
export const VESSEL_HISTORY_TTL_SECONDS = 40 * 86_400;

/**
 * Append one `{ at, theaters: { [id]: { ais, usni } } }` entry, at most one an
 * hour, keeping the newest VESSEL_HISTORY_MAX_ENTRIES. The 6-hour surge history
 * (military:surges:history:v1, 72 runs) is too short to calibrate ship
 * thresholds on; this series exists for that.
 */
export function appendVesselHistory(history, entry, { minGapMs = VESSEL_HISTORY_MIN_GAP_MS, max = VESSEL_HISTORY_MAX_ENTRIES } = {}) {
  const valid = (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item === 'object' && Number.isFinite(item.at));
  const last = valid[valid.length - 1];
  if (last && entry.at - last.at < minGapMs) return valid;
  return [...valid, entry].slice(-max);
}
