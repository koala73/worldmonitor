// src/data/fireAnchors.js — DEM ground anchors for rendered FIRMS detections
// (field finding 2026-07-21: at close/oblique zoom over high country,
// fire dots anchored at ellipsoid height 0 read as buried inside the terrain
// ~1-2 km below the visible surface).
//
// The fix rides the height-datum ship's machinery end to end: anchors read
// the SAME shared ground floor every other ground-adjacent consumer uses
// (groundFloor.cachedGroundFloor — rendered-mesh cell ?? real Re:Earth DEM
// cell), and cold cells warm through the same batched, chunked, cached
// resolver. No 3D-Tiles sampling happens here (zero steady-state raycasts);
// fires are static, and floor cells latch warm for the session, so each
// rendered detection costs at most one DEM lookup EVER — and detections
// sharing a ~111 m coarse cell share that lookup.
import { cachedGroundFloor, resolveGroundFloorCells } from './groundFloor.js';

/** @constant {number} Metres above the resolved floor for a fire anchor.
 *  The DEM is bare earth while the fire glow represents a 375 m VIIRS pixel;
 *  a few metres of lift biases "slightly above the visible surface" (owner
 *  principle) without a visible hover on the screen-sized sprite. */
export const FIRE_ANCHOR_LIFT_M = 5;

/**
 * Synchronous anchor height for one detection: shared ground floor + lift
 * when the floor is warm, else 0 (the pre-fix ellipsoid anchor — dots render
 * exactly as before until their floor lands). Warm-cache read only; never
 * triggers network or sampling.
 * @param {number} lat
 * @param {number} lon
 * @returns {number} Ellipsoidal anchor height in metres.
 */
export function fireAnchorHeight(lat, lon) {
  const floor = cachedGroundFloor(lat, lon);
  return floor != null ? floor + FIRE_ANCHOR_LIFT_M : 0;
}

/** @type {?Promise<boolean>} Tail of the batch chain — batches run strictly
 *  sequentially so overlapping renders can't stack concurrent requests on
 *  the single dev-server proxy (same courtesy as terrainHeights' sequential
 *  chunking). Each queued batch re-filters against the warm cache when it
 *  actually runs, so cells resolved by an earlier batch are never refetched. */
let _chain = null;

/**
 * Batched warm of the ground-floor cells behind a rendered detection set.
 * Fire-and-forget safe (never rejects). Resolves `true` only when at least
 * one requested point actually gained a warm floor — a failed resolve (proxy
 * down caches only geoid fallbacks, which do NOT count as a floor) resolves
 * `false`, so a render → warm → re-render chain terminates instead of
 * looping; the next natural rebuild retries and the cache self-heals.
 * @param {Array<{lat: number, lon: number}>} points - Rendered detections.
 * @returns {Promise<boolean>} Whether any requested point warmed.
 */
export function warmFireAnchorFloors(points) {
  const cold = collectCold(points);
  if (!cold.length) return Promise.resolve(false);
  const prev = _chain;
  const run = prev ? prev.then(() => resolveBatch(cold)) : resolveBatch(cold);
  _chain = run.then(() => true, () => false);
  return run;
}

/** @returns {Array<{lat: number, lon: number}>} Points with no warm floor. */
function collectCold(points) {
  if (!Array.isArray(points)) return [];
  const cold = [];
  for (const p of points) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    if (cachedGroundFloor(p.lat, p.lon) != null) continue;
    cold.push({ lat: p.lat, lon: p.lon });
  }
  return cold;
}

/** Resolves one batch (re-filtered at run time) and reports whether it warmed anything. */
async function resolveBatch(points) {
  const cold = points.filter((p) => cachedGroundFloor(p.lat, p.lon) == null);
  if (!cold.length) return false;
  try {
    await resolveGroundFloorCells(cold);
  } catch { /* resolver is best-effort and never throws; belt and braces */ }
  return cold.some((p) => cachedGroundFloor(p.lat, p.lon) != null);
}

/** Test hook: drops the batch chain (module caches live in groundFloor/terrainHeights). */
export function _resetFireAnchorsForTest() {
  _chain = null;
}
