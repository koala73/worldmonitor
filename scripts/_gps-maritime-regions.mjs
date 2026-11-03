// Shipping-zone boxes for GPS interference. The forecast detector
// (seed-forecasts.mjs) emits a forecast per box from the hexes inside it, and
// the resolver (_forecast-resolution-eval.mjs) counts the same hexes in the
// same box at the deadline, so both sides must read this one definition.

export const MARITIME_REGIONS = Object.freeze({
  'Eastern Mediterranean': { latRange: [33, 37], lonRange: [25, 37] },
  'Red Sea': { latRange: [11, 22], lonRange: [32, 54] },
  'Persian Gulf': { latRange: [20, 32], lonRange: [45, 60] },
  'Black Sea': { latRange: [40, 48], lonRange: [26, 42] },
  'Baltic Sea': { latRange: [52, 65], lonRange: [10, 32] },
});

// The detector emits a zone at this many hexes, and a GPS forecast resolves
// YES when the zone still holds this many on the deadline-day snapshot. The
// rule and its version ride on every spec so a row read under an older rule
// (#8990: the emission-day count) can never be scored as if it were this one.
export const GPS_ZONE_MIN_HEXES = 3;
export const GPS_RESOLUTION_RULE = 'persistence';
export const GPS_RESOLUTION_RULE_VERSION = 1;

// Above this many hexes the floor is never in doubt (#9012). Over 120 days of
// gpsjam.org snapshots (2026-06-09 to 10-06) the Red Sea peaked at 9 hexes and
// was below the floor on the day-7 snapshot in 23 of 55 windows. The other four
// zones never held fewer than 28 and were at or above it in 452 of 452 windows,
// so a forecast there could not resolve NO. The detector emits only zones at or
// under this. Counts from 10 to 27 were never observed, so a zone there emits
// nothing until its rate is measured.
export const GPS_ZONE_MAX_UNCERTAIN_HEXES = 9;

// The share of emitted windows that still held the floor on the day-7
// snapshot: 32 of 55 in the replay above. Zones at 7 to 9 hexes held it 8 of 9
// times, too few to fit a separate rate; recalibrate once more Red Sea windows
// resolve.
export const GPS_ZONE_PERSISTENCE_PROBABILITY = 0.58;

export function hexesInMaritimeRegion(hexes, bounds) {
  return hexes.filter((h) => {
    const lat = h.lat || h.latitude || 0;
    const lon = h.lon || h.longitude || 0;
    return lat >= bounds.latRange[0] && lat <= bounds.latRange[1]
        && lon >= bounds.lonRange[0] && lon <= bounds.lonRange[1];
  });
}
