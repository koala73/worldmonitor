import * as Cesium from 'cesium';
/**
 * Model-space visual centres measured from the shipped GLBs' scene-space AABBs.
 *
 * glTF stores these assets Y-up. Cesium's model frame is Z-up, so a glTF
 * centre `[x, y, z]` becomes `[x, -z, y]` before the layer's ENU modelMatrix
 * is applied. Values remain in native model units; callers supply the Model's
 * effective rendered `computedScale` because Cesium does not bake it into
 * modelMatrix and may raise it above `scale` to satisfy minimumPixelSize.
 */
const CENTERED_MODEL = Object.freeze([0, 0, 0]);

export const MODEL_VISUAL_CENTER_NATIVE = Object.freeze({
  '/models/airplane.glb': CENTERED_MODEL,
  '/models/jet.glb': CENTERED_MODEL,
});

/**
 * Aft-belly trail attachment points, measured on each approved model's actual
 * MESH SURFACE. Every bundled asset is baked to one convention (see
 * aircraftClass.js): origin at the bbox centre, X = length with the NOSE at
 * local −X, glTF Y = up (Cesium-local Z here).
 *
 * Each value is the point of the hull's CENTRELINE PROFILE (the y = 0 slice of
 * the mesh) closest to that model's aft-belly AABB corner. Three things follow
 * from that construction, and each is asserted rather than described in
 * modelScale.test.mjs:
 *
 *   ON THE HULL. This is the correction that matters. The previous round put
 *       the anchor ON the AABB corner itself, reasoning that an anchor aft of
 *       every vertex makes non-intersection geometric. It does — but an AABB
 *       corner is EMPTY SPACE, and on these airframes it is a long way from
 *       any of them: 4.80 m out for airplane.glb and 6.14 m for jet.glb in
 *       native units, which at the 450 m framing is a visible gap between the
 *       aircraft and the end of its own trail. The trail must terminate on the
 *       aeroplane, so the anchor is a surface point.
 *
 *   AFT. The head segment is drawn from a point behind the aircraft to this
 *       anchor, so an anchor near the middle makes the segment enter at the
 *       tail and stop mid-fuselage — a line drawn through the airframe. These
 *       sit at 83–96 % of each model's aft extreme, on the aft-most hull the
 *       centreline has.
 *
 *   BELOW. Nothing of the aircraft is lower than the anchor at or behind its
 *       own station, so the trail leaves from underneath the way a wake does
 *       rather than out of the roof. On most assets that is a frank belly
 *       point; on jet.glb the aft centreline profile has swept up into the
 *       tail cone by then, so the anchor sits just above the model's vertical
 *       centre (+0.13 native on a 5.63 m half-height) at the exhaust — which
 *       is where a fast jet's wake leaves it anyway.
 *
 * Y stays on the centreline — the profile is sliced at y = 0 rather than taking
 * the nearest surface point in the round — so the attachment cannot drift
 * screen-left or screen-right as the aircraft turns. (The unconstrained nearest
 * point would put jet.glb's anchor 1.29 m off-axis.) Values are native model
 * units; callers scale them by Cesium's effective `computedScale`.
 *
 * Locked against the shipped GLBs by modelScale.test.mjs, which re-reads the
 * POSITION buffers and re-derives every property above — re-measure, never
 * re-guess, when an asset changes.
 */
export const MODEL_TRAIL_ANCHOR_NATIVE = Object.freeze({
  '/models/airplane.glb': Object.freeze([24.0879, -2.2163, 0]),
  '/models/jet.glb': Object.freeze([18.9103, 0.1266, 0]),
  '/models/bell206.glb': Object.freeze([5.2077, -0.0005, 0]),
  '/models/c172.glb': Object.freeze([3.6816, -0.2425, 0]),
  '/models/citation2.glb': Object.freeze([6.8804, -0.6136, 0]),
  '/models/mq9.glb': Object.freeze([5.1951, -1.1516, 0]),
  '/models/b789.glb': Object.freeze([30.1007, -3.4814, 0]),
  '/models/atr72.glb': Object.freeze([12.9785, -1.2935, 0]),
});

/** @constant Cesium's OWN axis correction for a glTF loaded with the
 *  `Model.fromGltfAsync` defaults (upAxis Y, forwardAxis Z), assembled from its
 *  exported constants rather than restated as numbers here. `ModelSceneGraph`
 *  renders with `modelMatrix x components.transform x axisCorrection`, and the
 *  trail anchor has to ride the same chain or it lands on a different axis than
 *  the aircraft it is supposed to be attached to. */
const AXIS_CORRECTION = Cesium.Matrix4.multiplyTransformation(
  Cesium.Axis.Y_UP_TO_Z_UP, Cesium.Axis.Z_UP_TO_X_UP, new Cesium.Matrix4(),
);
const _anchorScratch = new Cesium.Cartesian3();
const _chainScratch = new Cesium.Matrix4();

/**
 * World position of a model-local anchor, through the SAME transform chain
 * Cesium renders the model with.
 *
 * This exists because doing it by hand got it wrong. The anchors used to be
 * stored after a single glTF Y-up -> Z-up step (`[x, y, z]` -> `[x, -z, y]`) and
 * multiplied straight by `modelMatrix`. That is only half of Cesium's
 * correction: with the `fromGltfAsync` defaults it also applies Z_UP_TO_X_UP,
 * and the full correction maps raw glTF `[x, y, z]` -> `[z, x, y]`. The
 * aircraft's longitudinal axis is raw glTF X, so the old conversion put the
 * aft offset on the RENDERED model's lateral axis — a 90-degree disagreement.
 * Because `modelMatrix` carries the heading, both frames rotated together and
 * the offset came out sideways in world space, flipping which side it appeared
 * on as the course changed. Measured on the live rig at N/E/S/W plus a
 * helicopter: the old path put 81.47 m of a civil airliner's anchor entirely on
 * cross-track with 0 aft, at every heading; this path puts 81.47 m aft with 0
 * cross.
 *
 * The anchors are therefore stored in RAW glTF coordinates and transformed
 * here, so exactly one transform — Cesium's own — stands between the table and
 * the world, and there is no second convention to drift.
 *
 * @param {object} model Cesium Model (needs modelMatrix, computedScale, sceneGraph).
 * @param {readonly number[]} nativeAnchor Raw glTF `[x, y, z]` native-unit offset.
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} World position of the anchor.
 */
export function modelAnchorWorld(model, nativeAnchor, result) {
  if (!model || !model.modelMatrix || !nativeAnchor || !result) return null;
  const scale = Number.isFinite(model.computedScale) ? model.computedScale : 1;
  _anchorScratch.x = (nativeAnchor[0] || 0) * scale;
  _anchorScratch.y = (nativeAnchor[1] || 0) * scale;
  _anchorScratch.z = (nativeAnchor[2] || 0) * scale;
  // The model's own root transform, when it exposes one, then Cesium's axis
  // correction. Read from the instance rather than assumed, so an asset with a
  // baked root transform is carried too.
  const components = model?.sceneGraph?.components?.transform;
  Cesium.Matrix4.multiplyTransformation(
    model.modelMatrix,
    components || Cesium.Matrix4.IDENTITY,
    _chainScratch,
  );
  Cesium.Matrix4.multiplyTransformation(_chainScratch, AXIS_CORRECTION, _chainScratch);
  return Cesium.Matrix4.multiplyByPoint(_chainScratch, _anchorScratch, result);
}

/**
 * Return the model-local visual centre for an approved bundled GLB.
 * Assets absent from the table were audited as origin-centred.
 * @param {string} url Bundled model URL.
 * @returns {readonly number[]} Cesium-local `[x, y, z]` native-unit offset.
 */
export function visualCenterForModel(url) {
  return MODEL_VISUAL_CENTER_NATIVE[url] || CENTERED_MODEL;
}

/**
 * Return the model-local aft-belly attachment point for a tracked trail.
 * Unknown future assets safely fall back to their visual centre until their
 * geometry is measured and added to the table.
 * @param {string} url Bundled model URL.
 * @returns {readonly number[]} Cesium-local `[x, y, z]` native-unit offset.
 */
export function trailAnchorForModel(url) {
  return MODEL_TRAIL_ANCHOR_NATIVE[url] || visualCenterForModel(url);
}

/**
 * Where a trail head segment should START being drawn: the whole segment, a
 * shortened piece of it, or nothing at all.
 *
 * The head segment bridges the last displayed trail point to the aft-belly
 * anchor. On a moving contact that point is a poll interval behind, so the
 * segment arrives from open air and terminates ON the hull, which is what it
 * should do. On a PARKED one it sits where the aircraft is: the segment
 * degenerates into a line from inside the model out to its own anchor — a stick
 * through half the fuselage on an aeroplane going nowhere. Grounded tracking
 * starts a trail unconditionally, so every parked selection drew one.
 *
 * Three earlier cuts were wrong, and each is recorded because the shape of the
 * mistake matters:
 *
 *  - Testing segment LENGTH against the radius hid real trail. With
 *    `airplane.glb`'s 34.41 m radius and 24.09 m tail anchor, a prior fix 58 m
 *    aft gives a 33.98 m segment — under the radius, so suppressed — even
 *    though ~23.6 m of it is in open air behind the aircraft. It also made the
 *    whole segment pop in at once on crossing ~58.4 m.
 *  - CLIPPING the segment at the envelope boundary and keeping only what lay
 *    OUTSIDE fixed the pop but broke the thing the trail is for: a bounding
 *    sphere encloses a lot of empty space around a slender airframe, so
 *    trimming at sphere entry stops the trail visibly SHORT of the aircraft it
 *    is attached to. The head end is never cut. That end is the whole point.
 *  - CONTAINMENT — the whole segment when the start is outside the envelope,
 *    nothing when it is inside — kept both of those ends honest but decided it
 *    with a BOOLEAN, and a boolean at a 34.41 m boundary is a 10.33 m flash.
 *    Moving the start from 34.40 m to 34.42 m turned the entire segment on at
 *    once, and a contact whose next fix landed back inside turned it off again.
 *    Nothing in the world changes by 10 m across 2 cm of travel.
 *
 * So the far end MOVES and the near end does not. The drawn start slides along
 * the segment, from the anchor itself out to the segment's true start, over the
 * shell between the two lengths the model already defines:
 *
 *   - the ANCHOR'S OWN STATION, `|anchor − centre|`. Inside that, the last body
 *     point is no further from the aircraft's centre than its own attachment
 *     point is, so every millimetre of the segment would be drawn forward of
 *     the anchor, into the fuselage. Nothing is drawn. A parked contact sits at
 *     exactly zero here, which is the case this whole guard exists for.
 *   - the ENVELOPE, `radiusM`. At and beyond it the segment is drawn in full,
 *     bit-identical to the containment rule it replaces — so every contact that
 *     has moved more than its own size (any airborne contact: 30 s of flight is
 *     kilometres) is completely unaffected by any of this.
 *
 * Between them the visible length grows continuously from zero, so a contact
 * creeping across the boundary reveals its trail a few centimetres at a time
 * and an in/out/in flap costs a few centimetres each way instead of ten metres.
 *
 * Scale-free rather than tuned: both ends of that shell come from the model —
 * `radiusM` carries Cesium's `computedScale`, so it tracks whatever
 * `minimumPixelSize` inflated the model to, and the station comes from the
 * anchor being drawn to.
 *
 * @param {{x:number,y:number,z:number}} start Segment start (last trail point).
 * @param {{x:number,y:number,z:number}|null} anchor Segment end, world space —
 *   the aft-belly attachment point actually being drawn to.
 * @param {{x:number,y:number,z:number}|null} center Model origin, world space.
 * @param {number} radiusM Rendered bounding radius (nativeRadiusM x computedScale).
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} The point to draw FROM, or null
 *   when the segment should not be drawn. May be `start` itself.
 */
export function trailHeadStart(start, anchor, center, radiusM, result) {
  if (!start) return null;
  // No envelope to judge against (no model drawing this contact, a radius we
  // cannot trust, or nowhere to put the answer) — draw it all rather than lose
  // a real trail.
  if (!anchor || !center || !result) return start;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return start;
  const startD = Math.hypot(start.x - center.x, start.y - center.y, start.z - center.z);
  if (startD >= radiusM) return start;
  const anchorD = Math.hypot(anchor.x - center.x, anchor.y - center.y, anchor.z - center.z);
  // A degenerate shell (an anchor at or outside the envelope — no shipped asset
  // has one, since every anchor is a measured hull point) leaves nothing to
  // ramp across; fall back to the containment verdict rather than divide by it.
  if (!(radiusM > anchorD)) return null;
  const revealed = (startD - anchorD) / (radiusM - anchorD);
  if (revealed <= 0) return null;
  result.x = anchor.x + (start.x - anchor.x) * revealed;
  result.y = anchor.y + (start.y - anchor.y) * revealed;
  result.z = anchor.z + (start.z - anchor.z) * revealed;
  return result;
}

/**
 * Transform a model-local visual centre into world coordinates without
 * allocating. `modelMatrix` continues to own the model origin (including
 * ground snapping); bracket/readout and trail consumers supply their own
 * model-local anchor.
 * @param {ArrayLike<number>} modelMatrix Cesium Matrix4-compatible value.
 * @param {readonly number[]} nativeCenter Cesium-local native-unit offset.
 * @param {number} scale Cesium Model.computedScale applied outside modelMatrix.
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} World visual centre.
 */
export function modelVisualAnchor(modelMatrix, nativeCenter, scale, result) {
  if (!modelMatrix || !result) return null;
  const safeScale = Number.isFinite(scale) ? scale : 1;
  const x = (nativeCenter?.[0] || 0) * safeScale;
  const y = (nativeCenter?.[1] || 0) * safeScale;
  const z = (nativeCenter?.[2] || 0) * safeScale;
  result.x = modelMatrix[0] * x + modelMatrix[4] * y + modelMatrix[8] * z + modelMatrix[12];
  result.y = modelMatrix[1] * x + modelMatrix[5] * y + modelMatrix[9] * z + modelMatrix[13];
  result.z = modelMatrix[2] * x + modelMatrix[6] * y + modelMatrix[10] * z + modelMatrix[14];
  return result;
}
