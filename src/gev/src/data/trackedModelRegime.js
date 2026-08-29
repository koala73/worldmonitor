/**
 * Zoom-driven 2D↔3D policy for the TRACKED contact (both flight layers).
 *
 * The fleet's 3D models stay behind the DISPLAY-rail "3D" toggle (`models3d`)
 * — hundreds of GLBs are a draw-call budget decision the operator owns. Since
 * 2026-08-22 that toggle DEFAULTS ON in `proximity` (product invariant), so the
 * fleet is armed on a fresh boot; proximity is itself the budget, admitting only
 * the nearest MODEL_MAX in view below the fleet ceiling. The contact you have
 * SELECTED is still a separate case: it is exactly one model, it is what the
 * camera is pointed at, and the operator's expectation is that zooming in on a
 * target resolves it into an aircraft. So the tracked contact's handoff is
 * DEFAULT behaviour, driven purely by camera distance and never consulting the
 * toggle at all (product invariant, 2026-08-19).
 *
 * Threshold history — the tracked contact used to inherit the fleet ceiling
 * `MODEL_ALT_CEIL_M = 800_000` m, and a first pass raised it to 1_000_000 m to
 * make the airframe arrive sooner. Field test 2026-08-20 rejected that: the
 * model "pops to 3D far too early" — a 26 m airframe held at its minimum pixel
 * size from ~1 Mm out reads as a floating toy, not an aircraft. The ruling is a
 * MUCH closer swap: 2D is correct at ~600_000 m, and the handoff belongs at
 * ~150_000 m. That is the constant below.
 *
 * NOTE — the tracked contact now enters 3D *later* (nearer) than the FLEET does.
 * Cruise altitudes between 150_000 m and the fleet's 800_000 m ceiling draw the
 * surrounding contacts as models while the SELECTED one is still a billboard
 * (the fleet pass skips the tracked icao, so nothing double-draws — it is purely
 * an ordering difference). As of the 2026-08-22 default flip this is what an
 * operator sees WITHOUT arming anything, where before it needed the toggle on;
 * the inversion itself is unchanged and is still a consequence of the owner's
 * number, not an accident. It is pinned in trackedModelRegime.test.mjs so a
 * later "cleanup" cannot erase it without reading this note. Aligning the two is
 * a fleet-side decision and is explicitly out of scope here (fleet-wide auto-3D
 * is a separate post-launch change).
 *
 * HYSTERESIS — the enter and exit thresholds are deliberately asymmetric. A
 * single threshold makes an orbit AT the boundary flap billboard↔model every
 * time the camera's altitude wobbles across it (the tracked orbit is a real
 * camera motion, not a static pose), which is the same flicker the fleet's
 * ADD/KEEP radii exist to prevent. Once the model owns the visual it keeps it
 * until the camera climbs 15% past the enter ceiling.
 *
 * Pure functions + constants so the policy is unit-testable without a viewer;
 * the layers own the latch (one per selection) and the Cesium plumbing.
 */

/** The FLEET's ceiling (`MODEL_ALT_CEIL_M` in both layers), duplicated here only
 *  so the relationship in the note above is assertable. The fleet's own constant
 *  is unchanged and remains the single source for fleet behaviour. */
export const FLEET_MODEL_ALT_CEIL_M = 800_000;

/** Camera altitude (m) at or below which the TRACKED contact takes its 3D model.
 *  Field test ruling 2026-08-20: 2D still reads correctly at ~600_000 m, and
 *  the swap belongs at ~150_000 m. */
export const TRACKED_MODEL_ENTER_ALT_M = 150_000;

/** Exit is 15% looser than enter — the anti-flap band for a boundary orbit. */
export const TRACKED_MODEL_EXIT_RATIO = 1.15;

/** Camera altitude (m) the camera must climb past before the model hands back to the billboard. */
export const TRACKED_MODEL_EXIT_ALT_M =
  TRACKED_MODEL_ENTER_ALT_M * TRACKED_MODEL_EXIT_RATIO; // 172_500

/**
 * Whether the tracked contact's 3D model owns the visual at this camera altitude.
 *
 * Hysteretic: the caller feeds back the previous answer, and that selects which
 * threshold applies. Inside the band [enter, exit) the answer is simply "whatever
 * it already was", so a camera loitering on the boundary never toggles.
 *
 * A non-finite height (no viewer yet, camera not positioned) reads as "infinitely
 * far out" → inactive, matching the `?? Infinity` the layers used before.
 *
 * @param {number} cameraHeightM - Camera altitude above the ellipsoid, in metres.
 * @param {boolean} [wasActive=false] - The regime's answer on the previous evaluation.
 * @returns {boolean} True when the tracked 3D model should own the visual.
 */
export function trackedModelZoomActive(cameraHeightM, wasActive = false) {
  if (!Number.isFinite(cameraHeightM)) return false;
  return cameraHeightM < (wasActive ? TRACKED_MODEL_EXIT_ALT_M : TRACKED_MODEL_ENTER_ALT_M);
}
