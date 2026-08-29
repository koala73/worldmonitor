/**
 * @module trailRenderer
 * @description Shared track-history renderer (PRD WS-F F4; rebuilt round 6,
 * 2026-07-06).
 *
 * One trail = one ENTITY polyline. Round 6 replaced the faded per-vertex
 * Primitive for two product invariants from the field:
 *  - "the line must ALWAYS be visible": the Primitive's depthFailAppearance
 *    did not reliably render segments below the photoreal mesh — entity
 *    polylines with `depthFailMaterial` DO (in-repo proof: CCTV's frustum
 *    wireframes read through geometry with exactly this), so occluded
 *    segments now draw dimmed instead of vanishing.
 *  - "show actual tracks, don't style them too much": the tail-fade is gone;
 *    the whole history renders at one readable alpha (dimmer where it passes
 *    behind/below geometry).
 *
 * Trails update at poll cadence (~15-60 s) plus once on history backfill, so
 * assigning a fresh positions array per update is cheap. `allowPicking` has
 * no entity equivalent; the polyline entity is excluded from clicks by never
 * carrying a pick id the layers' click handlers resolve.
 */
import * as Cesium from 'cesium';
import { registerPickOwner } from './pickRegistry.js';

// Round 6: trail ENTITIES are pickable (the old Primitive had
// allowPicking:false). A trail hugs its aircraft, so an unclaimed pick would
// read as "empty space" in every layer's click handler and deselect the very
// plane being tracked. Claiming the 'gev-trail:' id namespace makes
// isOwnedByOtherLayer() true for every layer — clicking a trail is a no-op
// everywhere. Registered once at module load; the predicate is pure.
registerPickOwner('trails', (pickedId) => String(pickedId).startsWith('gev-trail:'));

/** @type {number} Uniquifier for trail entity ids (Cesium requires unique entity ids). */
let _trailSeq = 0;

/** @constant {number} Alpha where the trail passes the depth test. */
const TRAIL_ALPHA = 0.85;
/** @constant {number} Alpha where the trail is behind/below scene geometry —
 *  still visible, but readable as occluded. */
const TRAIL_OCCLUDED_ALPHA = 0.4;
/** @constant {number} Squared distance (m^2) below which consecutive points are merged. */
const MIN_SEGMENT_DISTANCE_SQ = 0.01;

/**
 * Create an always-visible polyline trail bound to a viewer.
 * @param {Cesium.Viewer} viewer - Viewer whose entity collection owns the trail.
 * @param {object} options - Trail options.
 * @param {string} options.color - CSS color string for the trail hue.
 * @param {number} [options.width=2.5] - Polyline width in pixels.
 * @returns {{setPositions: function(Cesium.Cartesian3[]): void, setVisible: function(boolean): void, clear: function(): void, destroy: function(): void}}
 *   Trail handle: setPositions replaces the geometry, setVisible temporarily
 *   hides it without discarding history, clear empties it, and destroy removes
 *   the entity permanently.
 */
export function createTrail(viewer, { color, width = 2.5 }) {
  const baseColor = Cesium.Color.fromCssColorString(color);
  /** @type {Cesium.Cartesian3[]} Current deduped positions (owned copy). */
  let current = [];
  let destroyed = false;
  let visible = true;
  /** @type {Cesium.Entity|null} */
  let entity = null;

  function ensureEntity() {
    if (entity || destroyed || !viewer || viewer.isDestroyed()) return;
    entity = viewer.entities.add({
      id: `gev-trail:${++_trailSeq}`,
      show: visible,
      polyline: {
        // CallbackProperty so a positions swap never rebuilds the entity —
        // Cesium re-reads on change; `false` marks it non-constant.
        positions: new Cesium.CallbackProperty(() => current, false),
        width,
        material: baseColor.withAlpha(TRAIL_ALPHA),
        // The locked rule (round 6): a segment below the photoreal
        // mesh renders dimmed — it must never disappear into the ground.
        depthFailMaterial: baseColor.withAlpha(TRAIL_OCCLUDED_ALPHA),
        // Round 8: NONE draws straight 3D chords between waypoints — over a
        // sparse trans-oceanic trace a single segment spans hundreds of km
        // and tunnels through the planet. GEODESIC subdivides each segment
        // along the curved surface (heights interpolated), so long legs hug
        // the globe instead of chording through it.
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  }

  return {
    /**
     * Replace the trail geometry with a chronological position list
     * (oldest first). Fewer than 2 distinct positions clears the trail.
     * @param {Cesium.Cartesian3[]} cartesians - Positions, oldest -> newest.
     */
    setPositions(cartesians) {
      if (destroyed || !viewer || viewer.isDestroyed()) return;
      // Drop consecutive near-duplicates: zero-length segments add nothing.
      const positions = [];
      for (const position of Array.isArray(cartesians) ? cartesians : []) {
        if (!position) continue;
        const last = positions[positions.length - 1];
        if (last && Cesium.Cartesian3.distanceSquared(last, position) < MIN_SEGMENT_DISTANCE_SQ) continue;
        positions.push(position);
      }
      current = positions.length >= 2 ? positions : [];
      ensureEntity();
    },

    /** Temporarily hide/show the trail without discarding accumulated history. */
    setVisible(nextVisible) {
      visible = nextVisible !== false;
      if (entity) entity.show = visible;
    },

    /** Empty the trail without removing the entity (cheap re-arm). */
    clear() {
      current = [];
    },

    /** Remove the trail entity permanently (layer disable/teardown). */
    destroy() {
      destroyed = true;
      current = [];
      if (entity && viewer && !viewer.isDestroyed()) {
        try { viewer.entities.remove(entity); } catch { /* torn down */ }
      }
      entity = null;
    },
  };
}
