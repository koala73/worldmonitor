// src/data/renderAltitude.js — pure priority-chain helper for aircraft render
// altitude.
//
// The globe needs ELLIPSOIDAL height (h = H + N). OpenSky's `geo_altitude`
// (state-vector index 13) is already WGS84 geometric/ellipsoidal — the
// correct value to hand `Cartesian3.fromDegrees(lon, lat, h)` verbatim.
// `baro_altitude` (index 7) is barometric/MSL-referenced (and, unlike a true
// GPS-derived geo_altitude, also carries non-standard-pressure QNH error) —
// it is only a VISUAL FALLBACK when geo_altitude is missing, corrected by
// adding the local geoid undulation N (src/data/geoid.js) so it at least
// lands close to the ellipsoid instead of sinking into high-elevation
// terrain. This module makes NO claim that baro+N is geometrically exact.
//
// Kept as a small standalone module (rather than inlined in flights.js) so
// it can be unit-tested in isolation and reused verbatim by the military
// flights layer (Task 7).

/**
 * @param {object} params
 * @param {number|null|undefined} params.geoAltM - OpenSky geo_altitude (m, WGS84 ellipsoidal), if reported.
 * @param {number|null|undefined} params.baroAltM - Barometric/MSL altitude (m), if reported.
 * @param {boolean} params.onGround - OpenSky on_ground flag.
 * @param {number|null|undefined} params.surfaceM - Cached ellipsoidal ground height at this lat/lon (Task 3's cachedEllipsoidalGround), if warm.
 * @param {number|null|undefined} [params.geoidN] - Geoid undulation N (m) at this lat/lon; treated as 0 when absent.
 * @returns {number|null} Ellipsoidal render height in metres, or `null` (sentinel) when
 *   none of the above are usable — the caller applies its OWN existing sticky/default
 *   fallback (this helper never invents one, so it can't drift from the caller's policy).
 */
export function pickRenderAltitudeM({ geoAltM, baroAltM, onGround, surfaceM, geoidN }) {
  if (onGround && Number.isFinite(surfaceM)) {
    return surfaceM;
  }
  if (Number.isFinite(geoAltM)) {
    return geoAltM;
  }
  if (Number.isFinite(baroAltM)) {
    return baroAltM + (Number.isFinite(geoidN) ? geoidN : 0);
  }
  return null;
}

/**
 * Ground-surface reuse for a TAXIING on-ground aircraft.
 *
 * The ellipsoidal-ground cache (Task 3) keys by exact 5-decimal-rounded
 * lat/lon (~1.1 m). The warm-up batch resolves the CURRENT poll's fix for a
 * LATER poll, but an aircraft that moves more than ~1 m between polls (any
 * taxiing traffic — polls are tens of seconds apart) rounds to a fresh key
 * every poll, so `cachedEllipsoidalGround(currentLat, currentLon)` misses
 * indefinitely and a no-baro/no-geo aircraft would stick at the 0 m sentinel
 * while it moves. LAST poll's fix, however, WAS resolved by last poll's warm
 * batch, so its cached ground is available now. Airport aprons/taxiways are
 * ~flat, so the previous fix's ellipsoidal ground is a good stand-in for the
 * current one — far better than sinking to 0 m at an elevated field.
 *
 * @param {number|null|undefined} currentM - Ground at the CURRENT poll fix (may be a cache miss → null).
 * @param {number|null|undefined} previousM - Ground at the PREVIOUS poll fix (warmed last poll), if any.
 * @returns {number|null} The first finite of [current, previous], else null (sentinel).
 */
export function reuseGroundedSurfaceM(currentM, previousM) {
  if (Number.isFinite(currentM)) return currentM;
  if (Number.isFinite(previousM)) return previousM;
  return null;
}

/**
 * Last-resort ground prior for a grounded contact whose floor cells are all
 * cold and which reports NO altitude at all.
 *
 * The geoid is a crude stand-in: at a sea-level field it is the local ground to
 * within metres, at an inland field it is tens of metres BELOW the rendered
 * mesh. It earns its place only for a contact nothing else can describe — a
 * first sighting, before any cell has warmed (the documented "born-grounded
 * first poll" residual).
 *
 * It must NOT outrank a render height the contact already had. That was the
 * 2026-08-21 defect: four Re:Earth refreshes in a row timed out, a parked
 * contact's cells went cold, and this guess overwrote a height that had been
 * sitting correctly on the mesh — dropping it through the ground until the
 * proxy recovered. With `priorRenderM` present the caller's existing sticky
 * fallback holds that height instead, which is what product behavior requires for:
 * "hold the last known altitude until a fresh one comes in."
 *
 * @param {object} params
 * @param {number|null|undefined} params.geoAltM - Reported geo_altitude.
 * @param {number|null|undefined} params.baroAltM - Reported baro_altitude.
 * @param {number|null|undefined} params.priorRenderM - Render height this
 *   contact already had, if any.
 * @param {number|null|undefined} params.geoidN - Geoid undulation N here.
 * @returns {number|null} The geoid guess, or null when it must not be used.
 */
export function geoidSurfaceLastResortM({ geoAltM, baroAltM, priorRenderM, geoidN }) {
  if (Number.isFinite(geoAltM) || Number.isFinite(baroAltM)) return null;
  if (Number.isFinite(priorRenderM)) return null;
  return Number.isFinite(geoidN) ? geoidN : null;
}
