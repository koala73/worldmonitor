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

export function hexesInMaritimeRegion(hexes, bounds) {
  return hexes.filter((h) => {
    const lat = h.lat || h.latitude || 0;
    const lon = h.lon || h.longitude || 0;
    return lat >= bounds.latRange[0] && lat <= bounds.latRange[1]
        && lon >= bounds.lonRange[0] && lon <= bounds.lonRange[1];
  });
}
