/**
 * Coordinate parsing for untrusted upstream feeds.
 *
 * Upstream traffic, weather and emergency feeds spell "no coordinate" as null,
 * '', '  ', false or an empty array. `Number()` turns every one of those into 0,
 * and 0,0 is a real place in the Gulf of Guinea, so a bare `Number()` publishes
 * a confidently wrong location instead of dropping an unplaceable record.
 *
 * The axis is part of the name because the valid range differs per axis and the
 * recurring mistake is applying the longitude bound to a latitude. There is no
 * range-free variant on purpose: a caller that geofences more tightly still
 * wants the coarse bound first.
 */

const LAT_LIMIT = 90;
const LON_LIMIT = 180;

function parseAxis(value, limit) {
  // Booleans, null, undefined, arrays and blank strings are missing data.
  // Numeric strings are legitimate: several 511 feeds quote their coordinates.
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= -limit && n <= limit ? n : null;
}

export function finiteLat(value) {
  return parseAxis(value, LAT_LIMIT);
}

export function finiteLon(value) {
  return parseAxis(value, LON_LIMIT);
}

/** A GeoJSON-order [lon, lat] position, or null when either axis is unusable. */
export function lonLatPair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = finiteLon(value[0]);
  const lat = finiteLat(value[1]);
  if (lon == null || lat == null) return null;
  return [lon, lat];
}
