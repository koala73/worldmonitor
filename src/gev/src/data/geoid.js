// src/data/geoid.js — bundled EGM96 geoid-undulation lookup.
//
// h = H + N: the globe (Cesium ellipsoid) needs ELLIPSOIDAL height (h);
// most real-world elevation sources (barometric altitude, MSL survey data,
// Caltrans/TfL camera priors) give ORTHOMETRIC height (H, "height above mean
// sea level"). N is the local geoid undulation — the gap between the WGS84
// ellipsoid and the geoid (~mean sea level) surface, ranging roughly
// -106..+85 m worldwide. See docs/CURRENT-STATE.md.
//
// The implementation uses `egm96-universal` (npm, MIT, embeds the NGA
// EGM96 15' grid) as a lazy dynamic import so its ~2.7 MB grid data-chunk
// never lands in the eager Vite bundle. Only fall back to vendoring the NGA
// grid ourselves if the package fails tests, isn't browser-safe, or bloats
// the eager bundle. It passed the browser-safety, accuracy, and bundle checks,
// so this file is a thin wrapper around it — no vendored fallback is needed.
//
// egm96-universal's `meanSeaLevel(lat, lon)` already returns exactly N in
// metres (relative to WGS84 ellipsoid) with internal longitude
// normalization (wraps to [-180, 180) before the grid lookup), so no extra
// wrap/interpolation logic is needed here.

let egm96Module = null;
let readyPromise = null;

/**
 * Lazily loads the EGM96 grid (dynamic import — code-split by Vite so the
 * ~2.7 MB grid data stays out of the eager main bundle). Safe to call many
 * times; the underlying import only happens once and subsequent calls
 * resolve immediately from the cached promise.
 * @returns {Promise<void>}
 */
export async function ensureGeoidReady() {
  if (!readyPromise) {
    readyPromise = import('egm96-universal').then((mod) => {
      egm96Module = mod;
    });
  }
  return readyPromise;
}

/**
 * Geoid undulation N at a given point, in metres, relative to the WGS84
 * ellipsoid (positive = geoid above ellipsoid). Throws if
 * `ensureGeoidReady()` has not resolved yet.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number}
 */
export function geoidHeight(latDeg, lonDeg) {
  if (!egm96Module) {
    throw new Error(
      'geoid.js: geoidHeight() called before ensureGeoidReady() resolved — ' +
        'await ensureGeoidReady() first.'
    );
  }
  return egm96Module.meanSeaLevel(latDeg, lonDeg);
}

/**
 * Converts an orthometric (mean-sea-level) height to an ellipsoidal
 * (WGS84 globe-relative) height: h = H + N.
 * @param {number} hMslM - orthometric height in metres (height above MSL)
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number} ellipsoidal height in metres
 */
export function orthometricToEllipsoidal(hMslM, latDeg, lonDeg) {
  return hMslM + geoidHeight(latDeg, lonDeg);
}

/**
 * READOUT-ONLY inverse of {@link orthometricToEllipsoidal}: H = h - N.
 *
 * Cesium reports camera and entity heights against the WGS84 ELLIPSOID, but a
 * viewer reads "ALT" as height above mean sea level — so over San Francisco
 * (N ≈ -32 m) a camera sitting 17 m above the SFO deck reports a startling
 * -15 m until the undulation is taken back out.
 *
 * Takes N as an argument instead of calling {@link geoidHeight} itself, so it
 * stays a pure function a display surface can call every tick against a cached
 * cell, and so it degrades safely: a non-finite N (grid still loading, or the
 * lazy import failed) returns the UNCORRECTED height rather than NaN — a
 * readout that is ~30 m off for a beat beats a readout that blanks.
 *
 * This converts the DATUM of a height that is ALREADY ellipsoidal. It must
 * never be applied to a barometric/aviation altitude: those are MSL-referenced
 * already, and subtracting N there would introduce the very error it removes
 * here, sign-flipped.
 *
 * @param {number} hEllipsoidalM - height above the WGS84 ellipsoid, in metres
 * @param {number|null|undefined} geoidUndulationM - N at that point, in metres
 * @returns {number} height above MSL in metres, or the input when N is unknown
 */
export function ellipsoidalToMslDisplayM(hEllipsoidalM, geoidUndulationM) {
  if (!Number.isFinite(hEllipsoidalM)) return hEllipsoidalM;
  if (!Number.isFinite(geoidUndulationM)) return hEllipsoidalM;
  return hEllipsoidalM - geoidUndulationM;
}
