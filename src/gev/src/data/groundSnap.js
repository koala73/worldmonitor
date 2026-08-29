/**
 * groundSnap.js — one-shot cached ground-height snap for MODELED grounded aircraft.
 *
 * Why: a parked/taxiing plane's feed altitude is last-known baro or 0 m — nowhere
 * near the photoreal tile skin in ellipsoid heights (buried ~100+ m at inland
 * airports like AUS, floating ~30 m at sea-level fields like SFO, where the geoid
 * sits below the ellipsoid). A 3D model placed at the meta altitude therefore
 * renders inside the tiles or hovering above them. Billboards dodge this with
 * disableDepthTestDistance; a depth-tested glTF model cannot.
 *
 * Discipline (CCTV-B9b style): scene.sampleHeight forces a synchronous offscreen
 * pick render, so it is NEVER called per frame. Each grounded modeled plane gets
 * ONE successful sample, cached per icao; the cache stops answering directly when
 * the plane moves >MOVE_INVALIDATE_M from the sampled spot (taxiing). Misses (tiles
 * still streaming, OSM fallback with no tileset skin, sample outside loaded
 * geometry) are a retry-later signal with per-icao exponential backoff. A
 * per-window budget stops a freshly modeled airport cluster from firing dozens of
 * pick renders in one fleet tick.
 *
 * What a caller gets while a sample is outstanding depends on whether this
 * contact has ever HAD one, and the difference is the difference between two
 * kinds of wrong:
 *  - COLD (nothing ever resolved here) — null. There is no evidence of where the
 *    ground is, and the only honest answer for a depth-tested model is not to
 *    place it at all; the caller keeps the depth-test-free billboard.
 *  - WARM (a snap resolved, then taxi invalidated it and the resample has not
 *    landed) — the last measurement, held within HELD_SNAP_MAX_DRIFT_M. Hiding
 *    the model here would pop a taxiing aircraft from 3D back to 2D for a whole
 *    retry backoff, and the ground it was measured on a few dozen metres back is
 *    real evidence, not a guess. Same shape as the billboard chain's
 *    `_heldDisplayFloorM` (flights.js): hold the last thing that resolved,
 *    bounded by how far the contact can have travelled from it.
 *
 * A hold is a MEMORY, and it is ranked accordingly: held evidence never outranks
 * fresh evidence that contradicts it. Distance travelled is only a proxy for
 * "does this still describe the ground here", and it is a loose one — a contact
 * can taxi 200 m onto a different surface well inside the bound, and because a
 * miss preserves the hold, nothing in the retry path would ever correct that.
 * So where the mesh-floor cells have actually MEASURED the surface under the
 * contact's current position, and that surface is ABOVE the held value by more
 * than HELD_SNAP_CONTRADICTION_M, the measurement wins: the hold is dropped and
 * the contact is COLD again. The fallback is the floored 2D billboard, which is
 * the honest picture — a model buried in the apron is not a better one.
 *
 * Shared by flights.js and militaryFlights.js (one instance each — the caches
 * are per-layer, keyed by that layer's icao space).
 */

import * as Cesium from 'cesium';
import { cachedMeshFloor, meshFloorPreferred, reportValidatedMeshFloorCell } from './groundFloor.js';

/** Taxi threshold: a cached snap answers directly for moves up to this far from
 *  the sampled spot (m). Past it the value is demoted to a held last-known and a
 *  resample runs. */
const MOVE_INVALIDATE_M = 50;
/** @constant {number} How far a contact may travel from the spot its snap was
 *  measured at before that measurement stops describing the ground under it, and
 *  the hold is dropped rather than stretched.
 *
 *  Sized to two things at once. It has to outlast a resample outage, or it buys
 *  nothing: RETRY_MAX_MS is 30 s of backoff, and ordinary taxi is ~10 m/s, so a
 *  hold that expires inside ~25 s of rolling would hand back the pop it exists to
 *  prevent. And it has to stay inside the grade error an airfield can hide: the
 *  KAUS spread this file's header cites is ~21 m across a ~4 km field, ~0.5%, so
 *  250 m of taxi is ~1.3 m of vertical error — the order of the belly offsets
 *  already being added, and two orders under the ~100+ m burial the snap exists
 *  to prevent.
 *
 *  Deliberately a quarter of the billboard chain's HELD_FLOOR_MAX_DRIFT_KM. That
 *  hold only ever RAISES a position (`displayFloorHeightM` never lowers), so an
 *  under-read there is inert; here the held value IS the placement, so the error
 *  shows in both directions and the bound has to be tighter. */
const HELD_SNAP_MAX_DRIFT_M = 250;
/** @constant {number} How far a held measurement may disagree with FRESH
 *  measured evidence at the contact's current position before it is dropped
 *  rather than trusted.
 *
 *  The drift bound above asks "how far has the contact travelled?", which is a
 *  proxy for "does this value still describe the ground?" — and a proxy is all
 *  it is. 202 m of taxi onto a different surface is inside the bound and still
 *  wrong, and because a miss preserves the hold, repeated misses preserve the
 *  error for as long as they last. So the bound is not the only guard: where
 *  something has actually MEASURED the surface the contact is standing on now,
 *  that measurement outranks the memory, and a memory that contradicts it is
 *  discarded rather than stretched to cover the gap.
 *
 *  5 m sits between the two scales this has to separate:
 *   - ABOVE the honest disagreement between two measurements of the SAME
 *     surface. A floor cell is ~111 m across, so cell grade is ~0.6 m at the
 *     ~0.5 % KAUS spread this file's header cites and ~3.3 m even at a steep
 *     3 %; the hold's own 250 m allowance is ~1.3 m at that grade. None of
 *     those should cost a taxiing aircraft its model.
 *   - BELOW the scale at which a placement reads as wrong. The belly offsets
 *     this snap adds are ~2–5 m and an airliner fuselage is ~4 m across, so a
 *     model displaced more than ~5 m is visibly off its gear rather than
 *     imprecisely on it — and it is two orders under the ~100+ m burial the
 *     snap exists to prevent.
 *
 *  Applied in ONE direction: the hold is released only when fresh evidence sits
 *  ABOVE it, which is the BURIAL case — the model sunk into the surface, which
 *  is the entire reason this gate exists. The other sign is deliberately left
 *  alone, and the asymmetry is not tidiness:
 *
 *   - A cell reading LOW against a real sample is the EXPECTED error here, not a
 *     contradiction. Cells are a one-shot first-write latch over ~111 m, the
 *     borrowed-neighbour path leans to the LOWEST on purpose (`neighborFloorM`),
 *     and `displayFloorHeightM` only ever RAISES — the whole floor chain is
 *     built to under-read rather than to invent. Releasing on that sign would
 *     discard good measurements wherever the two disagree downward. Measured on
 *     the track-regression rig: a planted cell sat 66.7 m BELOW a real sample at
 *     the SAME spot, and a two-sided rule dropped a hold that was correct.
 *   - The residual is stated rather than hidden, and stated WITH its condition.
 *     A contact taxiing DOWNHILL keeps a held value above its new surface and
 *     its model floats. The correction is a SUCCESSFUL resample, and nothing on
 *     this path guarantees one: on the OSM fallback sampleHeight misses forever,
 *     so the retries never land and the float persists for as long as the
 *     contact stays inside HELD_SNAP_MAX_DRIFT_M. There is no timer beside it
 *     and no vertical cap of its own — only whatever the ground drops within
 *     that radius. The other releases (a ground flip via forget(), travelling
 *     past the bound, a mesh cell measuring ABOVE the hold) are not ones a
 *     downhill taxi is guaranteed to hit either. It is accepted over the
 *     alternative because it errs UPWARD and stays visible, where a buried model
 *     errs into the terrain and cannot be seen at all. */
const HELD_SNAP_CONTRADICTION_M = 5;
/** First retry delay after a miss / tiles-not-ready (ms); doubles per consecutive miss. */
const RETRY_BASE_MS = 2000;
/** Backoff cap (ms) — on the OSM fallback (no tile skin) sampleHeight misses forever. */
const RETRY_MAX_MS = 30000;
/** Max sampleHeight calls per window across the layer (airport-cluster burst guard). */
const SAMPLE_BUDGET_PER_WINDOW = 4;
/** Budget window length (ms). */
const SAMPLE_WINDOW_MS = 250;

/**
 * True when the active photoreal tileset has finished streaming the tiles in
 * view (cctv.js's projectionTilesReady pattern: first Cesium3DTileset found in
 * scene.primitives, duck-typed via its boolean tilesLoaded). Sampling before
 * that both blows the frame budget on forced synchronous loads and produces
 * misses that would burn retry backoff for nothing. With NO tileset present
 * (OSM fallback) this returns true so the sample path is not permanently
 * blocked — the sample just misses and backs off.
 * @param {Cesium.Viewer} viewer
 * @returns {boolean}
 */
function _tilesReady(viewer) {
  const prims = viewer?.scene?.primitives;
  if (!prims) return false;
  for (let i = 0; i < prims.length; i++) {
    let p = null;
    try { p = prims.get(i); } catch { continue; }
    if (p && p.show !== false && typeof p.tilesLoaded === 'boolean') {
      return p.tilesLoaded === true;
    }
  }
  return true;
}

/**
 * Create a per-layer ground-snap cache.
 * @returns {{
 *   heightFor: (viewer: Cesium.Viewer, icao: string, pos: Cesium.Cartesian3,
 *               getExclusions?: () => Array<unknown>) => number|null,
 *   forget: (icao: string) => void,
 *   clear: () => void,
 * }}
 */
export function createGroundSnap() {
  /** @type {Map<string, {h: number|null, samplePos: Cesium.Cartesian3|null,
   *  held: boolean, nextRetryMs: number, misses: number}>} Per-icao snap state:
   *  the sampled height and the surface point it was measured at, whether that
   *  pair is still the fresh answer or has been demoted to a bounded last-known
   *  (`held`), and the retry backoff a miss earned. */
  const entries = new Map();
  let windowStartMs = 0;
  let windowCount = 0;
  const scratchCarto = new Cesium.Cartographic();
  const scratchSurfacePos = new Cesium.Cartesian3();
  /** Separate from `scratchCarto`: the held-evidence check runs on paths that
   *  return BEFORE the sample writes `scratchCarto`, and on the sampling path it
   *  must not disturb the cartographic that `reportValidatedMeshFloorCell` reads
   *  back after the sample lands. */
  const scratchHeldCarto = new Cesium.Cartographic();

  /**
   * The last measurement for a contact whose fresh snap has been demoted — it
   * taxied past MOVE_INVALIDATE_M and the resample has not landed yet.
   *
   * Answers only while the contact is still within HELD_SNAP_MAX_DRIFT_M of the
   * spot the value was measured at; past that the memory is DROPPED rather than
   * stretched, and the contact is back to no evidence (null, model hidden). The
   * bound is purely spatial on purpose: the ground under a contact that has not
   * moved does not change with time, so what invalidates the value is the
   * contact MOVING, which is exactly what this measures.
   *
   * @param {{h: number|null, samplePos: Cesium.Cartesian3|null, held: boolean}|undefined} entry
   * @param {Cesium.Cartesian3} surfacePos - Contact's position on the ellipsoid.
   * @returns {number|null}
   */
  function heldSnapM(entry, surfacePos) {
    if (!entry || !entry.held || entry.h == null || !entry.samplePos) return null;
    if (Cesium.Cartesian3.distanceSquared(surfacePos, entry.samplePos)
      > HELD_SNAP_MAX_DRIFT_M * HELD_SNAP_MAX_DRIFT_M) {
      return dropHold(entry);
    }
    // Held memory never outranks fresh contradicting evidence. Inside the drift
    // bound the contact can still have taxied onto a different surface — an
    // apron edge, a ramp, the far side of a rise — and since a miss PRESERVES
    // the hold, nothing else would ever correct it: the model would stay buried
    // (or floating) for as long as the resample kept missing.
    const fresh = freshMeasuredFloorAt(surfacePos);
    if (fresh != null && fresh - entry.h > HELD_SNAP_CONTRADICTION_M) {
      return dropHold(entry);
    }
    return entry.h;
  }

  /** Forget a demoted measurement: it no longer describes anywhere this contact
   *  is, so the contact is COLD again (model hidden, floored billboard). */
  function dropHold(entry) {
    entry.h = null;
    entry.samplePos = null;
    entry.held = false;
    return null;
  }

  /**
   * Independently measured surface height at the contact's CURRENT position, or
   * null where nothing has measured there yet.
   *
   * MESH cells only, deliberately — not `cachedGroundFloor`. A snap is a
   * `sampleHeight` of the RENDERED skin, and the mesh cells are that same
   * measurement through the same validation gate (written by this module's own
   * successful samples and by `meshFloorSampler.js`). `cachedGroundFloor` falls
   * back to the Re:Earth DEM, which is a DIFFERENT surface: the spread between
   * skin and DEM is precisely what `MESH_FLOOR_BELOW/ABOVE_PRIOR_M` budgets for
   * (15 m / 80 m), so testing a snap against a DEM cell would throw away good
   * holds over a disagreement that says nothing about where the model sits.
   *
   * The contact's OWN cell only. A neighbour is ~111 m away and may be a
   * terminal roof — that is why `neighborFloorM` leans to the lowest and refuses
   * to answer from a single sample — and borrowing one to DISCARD a real
   * measurement would let a roof cell hide a correctly placed model.
   *
   * @param {Cesium.Cartesian3} surfacePos - Contact's position on the ellipsoid.
   * @returns {number|null}
   */
  function freshMeasuredFloorAt(surfacePos) {
    const carto = Cesium.Cartographic.fromCartesian(
      surfacePos, Cesium.Ellipsoid.WGS84, scratchHeldCarto,
    );
    if (!carto) return null;
    return cachedMeshFloor(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
    );
  }

  /**
   * Cached tile-skin height (m, ellipsoid) at the aircraft's lat/lon, or null
   * when this contact has NO ground evidence at all (caller keeps the model
   * hidden and calls again on a later tick — cheap map hit until a retry is due).
   * A contact that HAS resolved once keeps that answer through a resample outage;
   * see `heldSnapM`.
   *
   * @param {Cesium.Viewer} viewer - Live viewer (sampling + tiles-ready check).
   * @param {string} icao - Cache key (per-layer icao space).
   * @param {Cesium.Cartesian3} pos - Current display position. Cache movement
   *   is measured after projecting this input to the WGS84 ellipsoid, so a
   *   poll-time altitude/datum change cannot invalidate a stationary snap.
   * @param {(() => Array<unknown>)|undefined} getExclusions - Lazily builds the
   *   scene.sampleHeight objectsToExclude list (own billboards/models/entities —
   *   the vertical pick ray at a plane's OWN lat/lon lands on its icon/model
   *   otherwise). Only invoked when a sample actually fires.
   * @returns {number|null}
   */
  function heightFor(viewer, icao, pos, getExclusions) {
    const surfacePos = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(pos, scratchSurfacePos);
    if (!surfacePos) return null;
    const cached = entries.get(icao);
    if (cached && cached.h != null && cached.samplePos && !cached.held) {
      if (Cesium.Cartesian3.distanceSquared(surfacePos, cached.samplePos) <= MOVE_INVALIDATE_M * MOVE_INVALIDATE_M) {
        return cached.h;
      }
      // Taxied away from the sampled spot. The measurement is DEMOTED to a
      // bounded last-known rather than deleted, and the resample runs below: a
      // miss now holds the aircraft on the ground it just left instead of
      // hiding a model that was already up.
      cached.held = true;
      cached.nextRetryMs = 0;
      cached.misses = 0;
    }
    const now = Date.now();
    const entry = entries.get(icao);
    if (entry && now < entry.nextRetryMs) return heldSnapM(entry, surfacePos); // backoff in force
    // Per-window budget: deny WITHOUT a retry stamp so the overflow simply
    // tries again next tick instead of waiting out a backoff it didn't earn.
    if (now - windowStartMs > SAMPLE_WINDOW_MS) { windowStartMs = now; windowCount = 0; }
    if (windowCount >= SAMPLE_BUDGET_PER_WINDOW) return heldSnapM(entry, surfacePos);
    const misses = entry ? entry.misses : 0;
    const miss = () => {
      // A held measurement survives the miss — only the retry schedule moves.
      const held = !!(entry && entry.held && entry.h != null && entry.samplePos);
      const next = {
        h: held ? entry.h : null,
        samplePos: held ? entry.samplePos : null,
        held,
        nextRetryMs: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** misses),
        misses: misses + 1,
      };
      entries.set(icao, next);
      return heldSnapM(next, surfacePos);
    };
    if (!_tilesReady(viewer)) return miss();
    windowCount += 1;
    let sampled;
    try {
      const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, scratchCarto);
      // sampleHeight throws when unsupported (no depth textures) — that's a miss.
      sampled = viewer.scene.sampleHeight(carto, getExclusions ? getExclusions() : undefined);
    } catch {
      sampled = undefined;
    }
    // Same sanity floor as cctv.js's sampleGroundHeight: a hit far below the
    // ellipsoid is pick garbage, not ground.
    if (!Number.isFinite(sampled) || sampled < -150) return miss();
    if (meshFloorPreferred()) {
      reportValidatedMeshFloorCell(
        Cesium.Math.toDegrees(scratchCarto.latitude),
        Cesium.Math.toDegrees(scratchCarto.longitude),
        sampled,
      );
    }
    // A fresh sample RELEASES any hold: this is a measurement of where the
    // contact is now, and it outranks a memory of where it was.
    entries.set(icao, {
      h: sampled,
      samplePos: Cesium.Cartesian3.clone(surfacePos),
      held: false,
      nextRetryMs: 0,
      misses: 0,
    });
    return sampled;
  }

  /** Drop one aircraft's snap (eviction / ground-flag flip / suppression). */
  function forget(icao) { entries.delete(icao); }

  /** Drop everything (layer destroy). */
  function clear() { entries.clear(); }

  return { heightFor, forget, clear };
}
