// Site fields for aviation notification payloads: the flat { city, lat, lon }
// shape published on aviation_closure / notam_closure, matching the keys
// weatherAlertNotifyLocation() publishes for weather_alert in
// scripts/_weather-alert-select.mjs. Keep the two vocabularies in lockstep --
// the downstream proximity matcher reads one shape for every event type.
//
// Reads both registry rows (flat lat/lon) and alert envelopes
// (location.{latitude,longitude}), so either can be handed straight in.
//
// Lives under scripts/ on purpose: the Railway seed crons build from a
// scripts-rooted Nixpacks source, so anything this path needs at runtime must
// sit inside scripts/. Reaching out to src/config/*.ts from here throws ENOENT
// in the container (see the AIRPORTS registry comment in seed-aviation.mjs).

/**
 * Build the notification site fields for an airport row or alert envelope.
 *
 * Coordinates are emitted as a PAIR or not at all, so a consumer never sees a
 * half-located site it might treat as a point.
 *
 * @param {{ city?: string, lat?: number, lon?: number,
 *           location?: { latitude?: number, longitude?: number } } | null | undefined} row
 * @returns {{ city?: string, lat?: number, lon?: number }}
 */
export function airportNotifyLocation(row) {
  if (!row || typeof row !== 'object') return {};

  const city = typeof row.city === 'string' && row.city.trim() !== '' ? row.city : undefined;

  const lat = row.lat ?? row.location?.latitude;
  const lon = row.lon ?? row.location?.longitude;

  // typeof BEFORE isFinite: Number(null), Number(''), Number([]) and
  // Number(false) all coerce to a finite 0, which is exactly the 0,0 in the
  // Gulf of Guinea this guard exists to suppress. Same rule, same reason, as
  // weatherAlertNotifyLocation() in scripts/_weather-alert-select.mjs.
  if (typeof lat !== 'number' || typeof lon !== 'number') return { ...(city ? { city } : {}) };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ...(city ? { city } : {}) };

  // 0,0 is the placeholder some alert envelopes carry for a row with no real
  // coordinates (seed-aviation.mjs builds FAA envelopes that way), not a real
  // airport. Defensive on today's notify paths -- both pass rows that carry
  // real coordinates -- but the placeholder is still written elsewhere in that
  // seeder, so the guard stays. An airport genuinely on the equator or the
  // prime meridian is kept: only the exact 0,0 pair is rejected.
  if (lat === 0 && lon === 0) return { ...(city ? { city } : {}) };

  return {
    ...(city ? { city } : {}),
    lat,
    lon,
  };
}
