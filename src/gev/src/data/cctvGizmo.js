/**
 * @module cctvGizmo
 *
 * Direct-manipulation calibration gizmo for the CCTV layer (design:
 * the CCTV calibration contract in `docs/CURRENT-STATE.md`).
 *
 * Two layers:
 *  - Pure drag math (this top section): ray↔axis closest-point, ray↔plane
 *    intersection with a grazing-angle guard, ring angles. All unit-tested
 *    under node:test with zero scene dependencies.
 *  - createCalibrationGizmo (below): the entity + ScreenSpaceEventHandler
 *    controller that renders grab-able handles on the ACTIVE camera and turns
 *    drags into calibration patches through a narrow callback interface. It
 *    never touches the layer's records/stores directly.
 *
 * Every one of the 7 calibration DOF maps to a handle:
 *   heading ring (yaw, local-up plane) · pitch ring (around local right) ·
 *   East/North/Up arrows (offsets + mount height) · range handle at the
 *   far-cap center (monitor-plane distance) · FOV handles at the cap's
 *   left/right edge midpoints (plane size).
 *
 * Scene interaction is strictly event-driven (single pick on LEFT_DOWN,
 * throttled hover picks while ADJUST mode is on) — the layer's zero-steady-state-query
 * invariant is untouched.
 */
import * as Cesium from 'cesium';

// Grazing guard (spec §5): reject plane intersections when the view ray is
// nearly parallel to the constraint plane — the hit point races to infinity
// and a 1 px mouse move would slam the value.
const GRAZING_DOT_MIN = 0.08;
// Near-parallel guard for ray/axis closest-point (denominator 1 - (d·a)²).
const PARALLEL_EPS = 1e-6;

const scratchW = new Cesium.Cartesian3();

/**
 * Parameter t (metres) along an axis line of the point on that axis closest
 * to a mouse ray. Both directions must be normalized.
 *
 * Minimizing |(rayOrigin + s·rayDir) − (axisOrigin + t·axisDir)|² gives
 *   t = (e − b·d) / (1 − b²)   with b = rayDir·axisDir, w = rayOrigin − axisOrigin,
 *                                    d = rayDir·w,      e = axisDir·w.
 *
 * @param {Cesium.Cartesian3} rayOrigin
 * @param {Cesium.Cartesian3} rayDir - Unit.
 * @param {Cesium.Cartesian3} axisOrigin
 * @param {Cesium.Cartesian3} axisDir - Unit.
 * @returns {number|null} Axis parameter in metres, or null when near-parallel.
 */
export function closestParamOnAxis(rayOrigin, rayDir, axisOrigin, axisDir) {
  const b = Cesium.Cartesian3.dot(rayDir, axisDir);
  const denom = 1 - b * b;
  if (Math.abs(denom) < PARALLEL_EPS) return null;
  const w = Cesium.Cartesian3.subtract(rayOrigin, axisOrigin, scratchW);
  const d = Cesium.Cartesian3.dot(rayDir, w);
  const e = Cesium.Cartesian3.dot(axisDir, w);
  return (e - b * d) / denom;
}

/**
 * Intersects a mouse ray with a plane, refusing grazing configurations
 * (|rayDir·normal| < 0.08) and hits behind the ray origin.
 * @param {Cesium.Cartesian3} rayOrigin
 * @param {Cesium.Cartesian3} rayDir - Unit.
 * @param {Cesium.Cartesian3} planeOrigin
 * @param {Cesium.Cartesian3} planeNormal - Unit.
 * @returns {Cesium.Cartesian3|null} Hit point (new instance), or null.
 */
export function rayPlaneIntersect(rayOrigin, rayDir, planeOrigin, planeNormal) {
  const denom = Cesium.Cartesian3.dot(rayDir, planeNormal);
  if (Math.abs(denom) < GRAZING_DOT_MIN) return null;
  const toPlane = Cesium.Cartesian3.subtract(planeOrigin, rayOrigin, scratchW);
  const s = Cesium.Cartesian3.dot(toPlane, planeNormal) / denom;
  if (s < 0) return null;
  const hit = Cesium.Cartesian3.multiplyByScalar(rayDir, s, new Cesium.Cartesian3());
  return Cesium.Cartesian3.add(rayOrigin, hit, hit);
}

/**
 * Angle (radians, atan2 convention) of a point around a ring center in the
 * plane spanned by two orthonormal basis vectors.
 * @param {Cesium.Cartesian3} hitPoint - Point on/near the ring plane.
 * @param {Cesium.Cartesian3} center - Ring center.
 * @param {Cesium.Cartesian3} basisA - In-plane unit vector (angle 0).
 * @param {Cesium.Cartesian3} basisB - In-plane unit vector (angle +90°).
 * @returns {number} Angle in (−π, π].
 */
export function ringAngle(hitPoint, center, basisA, basisB) {
  const v = Cesium.Cartesian3.subtract(hitPoint, center, scratchW);
  return Math.atan2(Cesium.Cartesian3.dot(v, basisB), Cesium.Cartesian3.dot(v, basisA));
}

/**
 * Shortest signed angular delta from → to, wrap-safe.
 * @param {number} fromRad
 * @param {number} toRad
 * @returns {number} Delta in (−π, π].
 */
export function signedAngleDelta(fromRad, toRad) {
  const twoPi = 2 * Math.PI;
  let delta = (toRad - fromRad) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta <= -Math.PI) delta += twoPi;
  return delta;
}

// ---------------------------------------------------------------------------
// Gizmo controller
// ---------------------------------------------------------------------------

/** Entity id prefix for every gizmo part — the layer's pick-owner regex and
 * click-to-select guard key off this. Gizmo entities NEVER carry a
 * `cctvCameraId` property, so the layer's selection path ignores them. */
export const GIZMO_ID_PREFIX = 'cctv-gizmo-';

const RING_SEGMENTS = 96;
const RING_RADIUS_FACTOR = 0.12;
const RING_RADIUS_MIN_M = 6;
const RING_RADIUS_MAX_M = 40;
const ARROW_LENGTH_FACTOR = 1.6;
const DRAG_THROTTLE_MS = 16;
const HOVER_THROTTLE_MS = 120;

const COLOR_RING_HEADING = Cesium.Color.fromCssColorString('#35d8ff');
const COLOR_RING_PITCH = Cesium.Color.fromCssColorString('#ff5fd0');
const COLOR_MOVE_EAST = Cesium.Color.fromCssColorString('#ff5252');
const COLOR_MOVE_NORTH = Cesium.Color.fromCssColorString('#52ff7a');
const COLOR_MOVE_UP = Cesium.Color.fromCssColorString('#5b8cff');
const COLOR_HANDLE = Cesium.Color.fromCssColorString('#ffd97a');

const toRadians = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Local ENU unit axes at an ECEF position.
 * @param {Cesium.Cartesian3} position
 * @returns {{east: Cesium.Cartesian3, north: Cesium.Cartesian3, up: Cesium.Cartesian3}}
 */
function enuAxes(position) {
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const rot = Cesium.Matrix4.getMatrix3(frame, new Cesium.Matrix3());
  return {
    east: Cesium.Matrix3.getColumn(rot, 0, new Cesium.Cartesian3()),
    north: Cesium.Matrix3.getColumn(rot, 1, new Cesium.Cartesian3()),
    up: Cesium.Matrix3.getColumn(rot, 2, new Cesium.Cartesian3()),
  };
}

/** a*sa + b*sb (fresh Cartesian3). */
function combine2(a, sa, b, sb) {
  const out = Cesium.Cartesian3.multiplyByScalar(a, sa, new Cesium.Cartesian3());
  const t = Cesium.Cartesian3.multiplyByScalar(b, sb, new Cesium.Cartesian3());
  return Cesium.Cartesian3.add(out, t, out);
}

/**
 * View-frame unit vectors for a pose within a local ENU frame: horizontal
 * forward, viewer-right, and the full pitched view axis.
 * @param {number} headingDeg - Compass heading (0 = north, +east).
 * @param {number} pitchDeg - Elevation (+up).
 * @param {{east, north, up}} axes - ENU axes at the mount.
 */
function viewAxesFor(headingDeg, pitchDeg, axes) {
  const h = toRadians(headingDeg);
  const p = toRadians(pitchDeg);
  const forwardHoriz = combine2(axes.east, Math.sin(h), axes.north, Math.cos(h));
  const right = combine2(axes.east, Math.cos(h), axes.north, -Math.sin(h));
  const view = combine2(forwardHoriz, Math.cos(p), axes.up, Math.sin(p));
  return { forwardHoriz, right, view };
}

/** Circle polyline positions around `center` in the (basisA, basisB) plane. */
function ringPositions(center, radius, basisA, basisB) {
  const positions = [];
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const angle = (i / RING_SEGMENTS) * 2 * Math.PI;
    const offset = combine2(basisA, Math.cos(angle) * radius, basisB, Math.sin(angle) * radius);
    positions.push(Cesium.Cartesian3.add(center, offset, offset));
  }
  return positions;
}

/**
 * Creates the calibration gizmo controller (design §3c). Renders grab-able
 * handles for the ACTIVE camera's 7 calibration DOF and turns pointer drags
 * into calibration patches through a narrow callback interface — the gizmo
 * never touches layer records/stores directly.
 *
 * @param {Object} deps
 * @param {Cesium.Viewer} deps.viewer
 * @param {function(): Object|null} deps.getActiveRecord - Returns the record
 *   the gizmo should attach to, or null to hide (layer decides: enabled +
 *   calibration mode + active camera).
 * @param {function(Object, Object): void} deps.applyPatch - Transient
 *   per-mousemove calibration patch (partial 7-field object, absolute offset
 *   values) + the PINNED drag record it applies to.
 * @param {function(Object): void} deps.endPatch - Commit-grade tail on drag
 *   end, for the PINNED drag record.
 * @returns {{setEnabled: function(boolean): void, refresh: function(): void,
 *   destroy: function(): void, isDragging: function(): boolean,
 *   isEnabled: function(): boolean}}
 */
export function createCalibrationGizmo({ viewer, getActiveRecord, applyPatch, endPatch }) {
  let enabled = false;
  let drag = null; // { part, startCal, basePose, refs... }
  let hoveredId = null;
  let lastDragAt = 0;
  let lastHoverAt = 0;
  const entities = new Map(); // part -> Entity

  const scene = viewer.scene;
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

  /** Adds (or re-adds) a gizmo entity, clearing any stale duplicate id. */
  function addEntity(part, options) {
    const id = `${GIZMO_ID_PREFIX}${part}`;
    const stale = viewer.entities.getById(id);
    if (stale) viewer.entities.remove(stale);
    const entity = viewer.entities.add({ id, show: false, ...options });
    entities.set(part, entity);
    return entity;
  }

  function polylinePart(part, color, width, arrow = false) {
    addEntity(part, {
      ...(arrow ? {
        position: Cesium.Cartesian3.ZERO,
        point: {
          pixelSize: 14,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      } : {}),
      polyline: {
        positions: [],
        width,
        material: arrow ? new Cesium.PolylineArrowMaterialProperty(color) : color.withAlpha(0.9),
        // Standard gizmo convention: parts behind geometry stay clearly
        // visible, just dimmed (a street-level mount buries half the heading
        // ring in sloped photogrammetry tiles — smoke-tested 2026-07-05).
        depthFailMaterial: color.withAlpha(0.45),
      },
    });
  }

  function pointPart(part, color, pixelSize) {
    addEntity(part, {
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize,
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  polylinePart('ring-heading', COLOR_RING_HEADING, 3);
  polylinePart('ring-pitch', COLOR_RING_PITCH, 3);
  polylinePart('move-east', COLOR_MOVE_EAST, 12, true);
  polylinePart('move-north', COLOR_MOVE_NORTH, 12, true);
  polylinePart('move-up', COLOR_MOVE_UP, 12, true);
  pointPart('handle-range', COLOR_HANDLE, 13);
  pointPart('handle-fov-l', COLOR_HANDLE, 10);
  pointPart('handle-fov-r', COLOR_HANDLE, 10);

  function hideAll() {
    for (const entity of entities.values()) entity.show = false;
  }

  /** Recomputes every handle's geometry from the active record's CURRENT pose
   * (the PINNED record while a drag is live, so handles never jump to another
   * camera mid-interaction). */
  function refresh() {
    const record = enabled ? (drag ? drag.record : getActiveRecord()) : null;
    const positions = record?.frustumPositions;
    const camera = record?.camera;
    if (!record || !positions || !camera) {
      hideAll();
      return;
    }
    const mount = positions.mount;
    const axes = enuAxes(mount);
    const { forwardHoriz, right, view } = viewAxesFor(camera.headingDeg, camera.pitchDeg, axes);
    const rangeM = Math.max(1, Number(camera.rangeM) || 1);
    const radius = Math.min(RING_RADIUS_MAX_M, Math.max(RING_RADIUS_MIN_M, rangeM * RING_RADIUS_FACTOR));
    const arrowLen = radius * ARROW_LENGTH_FACTOR;

    entities.get('ring-heading').polyline.positions = ringPositions(mount, radius, axes.north, axes.east);
    entities.get('ring-pitch').polyline.positions = ringPositions(mount, radius, forwardHoriz, axes.up);
    const arrowTo = (dir) => [mount, Cesium.Cartesian3.add(
      mount, Cesium.Cartesian3.multiplyByScalar(dir, arrowLen, new Cesium.Cartesian3()), new Cesium.Cartesian3()
    )];
    const eastArrow = arrowTo(axes.east);
    const northArrow = arrowTo(axes.north);
    const upArrow = arrowTo(axes.up);
    entities.get('move-east').polyline.positions = eastArrow;
    entities.get('move-east').position = eastArrow[1];
    entities.get('move-north').polyline.positions = northArrow;
    entities.get('move-north').position = northArrow[1];
    entities.get('move-up').polyline.positions = upArrow;
    entities.get('move-up').position = upArrow[1];
    entities.get('handle-range').position = positions.capCenter;
    entities.get('handle-fov-l').position = Cesium.Cartesian3.midpoint(positions.tl, positions.bl, new Cesium.Cartesian3());
    entities.get('handle-fov-r').position = Cesium.Cartesian3.midpoint(positions.tr, positions.br, new Cesium.Cartesian3());
    for (const entity of entities.values()) entity.show = true;
  }

  /** Extracts a gizmo part name from a pick result, or null. */
  function gizmoPartFrom(picked) {
    const id = picked?.id?.id ?? picked?.id;
    if (typeof id !== 'string' || !id.startsWith(GIZMO_ID_PREFIX)) return null;
    return id.slice(GIZMO_ID_PREFIX.length);
  }

  function pickGizmoPart(windowPosition) {
    // Gizmo primitives render depth-test-free and should be the topmost pick.
    // Take the cheap single-result path first: a full drillPick can stall for
    // tens of seconds under software GL even when its first result is already
    // the gizmo. Retain drillPick for uncommon overlap/fallback cases.
    try {
      const picked = scene.pick(windowPosition, 14, 14);
      const part = gizmoPartFrom(picked);
      if (part && entities.get(part)?.show) return part;
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] pick threw:', err?.message || err);
      }
    }

    let results = [];
    try {
      results = scene.drillPick(windowPosition, 6, 14, 14) || [];
    } catch (err) {
      if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
        console.debug('[CCTV:gizmo] drillPick threw:', err?.message || err);
      }
      return null;
    }
    if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
      console.debug('[CCTV:gizmo] drillPick @', windowPosition?.x, windowPosition?.y, '→',
        JSON.stringify(results.map((r) => String(r?.id?.id ?? r?.id ?? r?.primitive?.constructor?.name))));
    }
    for (const picked of results) {
      const part = gizmoPartFrom(picked);
      if (part && entities.get(part)?.show) return part;
    }
    return null;
  }

  function pickRay(windowPosition) {
    try {
      return viewer.camera.getPickRay(windowPosition) || null;
    } catch {
      return null;
    }
  }

  function setCursor(value) {
    if (scene.canvas?.style) scene.canvas.style.cursor = value;
  }

  function setHovered(part) {
    const nextId = part ? `${GIZMO_ID_PREFIX}${part}` : null;
    if (nextId === hoveredId) return;
    hoveredId = nextId;
    // Hover feedback must NEVER touch polyline geometry: a width change makes
    // Cesium rebuild the batched polyline primitive, and until the next render
    // the part vanishes from the pick buffer — so the very hover that finds a
    // ring makes the following LEFT_DOWN miss it (root-caused via the QA
    // harness's synthetic drag, 2026-07-05). Rings/arrows get cursor feedback
    // only; point handles are PointPrimitives (live-updatable, no rebuild), so
    // they keep the size bump.
    for (const [name, entity] of entities.entries()) {
      if (!entity.point) continue;
      const hot = hoveredId === `${GIZMO_ID_PREFIX}${name}`;
      entity.point.pixelSize = (name === 'handle-range' ? 13 : 10) + (hot ? 4 : 0);
    }
    setCursor(hoveredId ? 'grab' : '');
  }

  /** Captures the fixed drag reference frame + start values for a part. */
  function beginDrag(part, windowPosition) {
    const record = getActiveRecord();
    const positions = record?.frustumPositions;
    const camera = record?.camera;
    const geometry = record?.frustumGeometry;
    if (!record || !positions || !camera?.basePose || !geometry) return false;
    const ray = pickRay(windowPosition);
    if (!ray) return false;

    const mount = Cesium.Cartesian3.clone(positions.mount);
    const capCenter = Cesium.Cartesian3.clone(positions.capCenter);
    const axes = enuAxes(mount);
    const { forwardHoriz, right, view } = viewAxesFor(camera.headingDeg, camera.pitchDeg, axes);
    const startCal = { ...camera.calibration };
    const basePose = { ...camera.basePose };
    const state = {
      // The drag is PINNED to this record: patches must never follow a
      // mid-drag active-camera switch (voice select / auto-hop) onto a
      // different camera — its basePose makes the captured offsets wrong.
      record,
      part, startCal, basePose, mount, capCenter, axes, forwardHoriz, right, view,
      effectiveRangeM: geometry.rangeM,
      startAngle: null,
      startParam: null,
    };

    if (part === 'ring-heading') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, axes.up);
      if (!hit) return false;
      state.startAngle = ringAngle(hit, mount, axes.north, axes.east); // compass convention
    } else if (part === 'ring-pitch') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, right);
      if (!hit) return false;
      state.startAngle = ringAngle(hit, mount, forwardHoriz, axes.up); // 0 = level, + = up
    } else if (part === 'move-east' || part === 'move-north' || part === 'move-up') {
      const dir = part === 'move-east' ? axes.east : part === 'move-north' ? axes.north : axes.up;
      state.axisDir = dir;
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, dir);
      if (t === null) return false;
      state.startParam = t;
    } else if (part === 'handle-range') {
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, view);
      if (t === null) return false;
      state.startParam = t;
    } else if (part === 'handle-fov-l' || part === 'handle-fov-r') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, capCenter, view);
      if (!hit) return false;
    } else {
      return false;
    }

    drag = state;
    setCursor('grabbing');
    if (scene.screenSpaceCameraController) {
      scene.screenSpaceCameraController.enableInputs = false;
    }
    return true;
  }

  /** Converts the current mouse ray into a calibration patch for the drag part. */
  function dragPatch(windowPosition) {
    const ray = pickRay(windowPosition);
    if (!ray || !drag) return null;
    const { part, startCal, basePose, mount, capCenter, axes, forwardHoriz, right, view } = drag;

    if (part === 'ring-heading') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, axes.up);
      if (!hit) return null;
      const angle = ringAngle(hit, mount, axes.north, axes.east);
      return { headingDeg: startCal.headingDeg + toDeg(signedAngleDelta(drag.startAngle, angle)) };
    }
    if (part === 'ring-pitch') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, mount, right);
      if (!hit) return null;
      const angle = ringAngle(hit, mount, forwardHoriz, axes.up);
      return { pitchDeg: startCal.pitchDeg + toDeg(signedAngleDelta(drag.startAngle, angle)) };
    }
    if (part === 'move-east' || part === 'move-north' || part === 'move-up') {
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, drag.axisDir);
      if (t === null) return null;
      const delta = t - drag.startParam;
      if (part === 'move-east') return { offsetEastM: startCal.offsetEastM + delta };
      if (part === 'move-north') return { offsetNorthM: startCal.offsetNorthM + delta };
      return { heightM: startCal.heightM + delta };
    }
    if (part === 'handle-range') {
      const t = closestParamOnAxis(ray.origin, ray.direction, mount, view);
      if (t === null || !(basePose.rangeM > 0)) return null;
      return { rangeScale: Math.max(0.01, t) / basePose.rangeM };
    }
    if (part === 'handle-fov-l' || part === 'handle-fov-r') {
      const hit = rayPlaneIntersect(ray.origin, ray.direction, capCenter, view);
      if (!hit) return null;
      const lateral = Math.abs(Cesium.Cartesian3.dot(
        Cesium.Cartesian3.subtract(hit, capCenter, new Cesium.Cartesian3()), right
      ));
      const halfW = Math.max(0.5, lateral);
      const fovDeg = toDeg(2 * Math.atan(halfW / Math.max(1, drag.effectiveRangeM)));
      return { fovDeg: fovDeg - basePose.fovDeg };
    }
    return null;
  }

  function endDrag() {
    if (!drag) return;
    const record = drag.record;
    drag = null;
    if (scene.screenSpaceCameraController) {
      scene.screenSpaceCameraController.enableInputs = true;
    }
    setCursor(hoveredId ? 'grab' : '');
    endPatch(record);
  }

  /** QA/debug tracing, on when the page sets `window.__gevGizmoDebug = true`. */
  function debugLog(...args) {
    if (typeof window !== 'undefined' && window.__gevGizmoDebug) {
      console.debug('[CCTV:gizmo]', ...args);
    }
  }

  handler.setInputAction((event) => {
    if (!enabled) return;
    const part = pickGizmoPart(event.position);
    debugLog('LEFT_DOWN', event.position, 'part:', part);
    if (!part) return;
    const started = beginDrag(part, event.position);
    debugLog('beginDrag', part, '→', started);
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((event) => {
    if (!enabled) return;
    const now = Date.now();
    if (drag) {
      if (now - lastDragAt < DRAG_THROTTLE_MS) return;
      lastDragAt = now;
      // A mid-drag active-camera switch (voice select / auto-hop) ends the
      // drag: what was dragged so far stays committed to the PINNED record.
      if (getActiveRecord() !== drag.record) {
        debugLog('drag ended: active camera changed mid-drag');
        endDrag();
        return;
      }
      const patch = dragPatch(event.endPosition);
      debugLog('dragPatch', drag.part, event.endPosition, '→', patch ? JSON.stringify(patch) : null);
      if (patch) applyPatch(patch, drag.record);
      return;
    }
    if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
    lastHoverAt = now;
    setHovered(pickGizmoPart(event.endPosition));
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    if (!enabled) return;
    endDrag();
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  return {
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) {
        if (drag) endDrag();
        setHovered(null);
        hideAll();
      } else {
        refresh();
      }
    },
    refresh,
    destroy() {
      if (drag) endDrag();
      handler.destroy();
      for (const entity of entities.values()) {
        viewer.entities.remove(entity);
      }
      entities.clear();
      setCursor('');
    },
    isDragging: () => !!drag,
    isEnabled: () => enabled,
  };
}
