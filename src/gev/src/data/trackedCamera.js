import * as Cesium from 'cesium';

const MAX_FRAME_ATTEMPTS = 120;
const MIN_TRACKED_RANGE_M = 150;
const ZOOM_INERTIA_STATES = new WeakMap();

/**
 * Preserve real-world model scale except when a very close tracked camera
 * would make the selected aircraft dominate the viewport.
 *
 * @param {object} options
 * @param {number} options.baseScale Asset's calibrated real-world scale.
 * @param {number} options.nativeRadiusM Asset bounding radius before scale.
 * @param {number} options.rangeM Camera-to-aircraft range.
 * @param {number} options.viewportHeightPx Rendered viewport height.
 * @param {number} options.fovyRad Vertical field of view.
 * @param {number} options.maximumPixelSize Maximum selected-model diameter.
 * @returns {number} Scale to apply to the model.
 */
export function trackedModelScaleForPixelCap({
  baseScale,
  nativeRadiusM,
  rangeM,
  viewportHeightPx,
  fovyRad,
  maximumPixelSize,
}) {
  if (
    !Number.isFinite(baseScale) || baseScale <= 0
    || !Number.isFinite(nativeRadiusM) || nativeRadiusM <= 0
    || !Number.isFinite(rangeM) || rangeM <= 0
    || !Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0
    || !Number.isFinite(fovyRad) || fovyRad <= 0
    || !Number.isFinite(maximumPixelSize) || maximumPixelSize <= 0
  ) return baseScale;
  const focalLengthPx = viewportHeightPx / (2 * Math.tan(fovyRad / 2));
  const projectedDiameterPx = (
    2 * nativeRadiusM * baseScale * focalLengthPx
  ) / rangeM;
  if (projectedDiameterPx <= maximumPixelSize) return baseScale;
  return baseScale * (maximumPixelSize / projectedDiameterPx);
}

/**
 * Resolve the exact position already consumed by the tracked visual whenever
 * the layer exposes one, without advancing its CallbackProperty again.
 *
 * @param {Cesium.Entity} entity Tracked entity.
 * @param {Cesium.JulianDate} time Current viewer time.
 * @param {Cesium.Cartesian3} result Destination.
 * @returns {Cesium.Cartesian3|undefined} Camera-frame position.
 */
export function trackedDisplayPositionForCamera(entity, time, result) {
  const displayedPosition = entity?.gevDisplayPosition?.();
  return displayedPosition
    ? Cesium.Cartesian3.clone(displayedPosition, result)
    : entity?.position?.getValue(time, result);
}

function acquireStableTrackedZoom(controller, entity) {
  if (!controller) return () => {};
  let state = ZOOM_INERTIA_STATES.get(controller);
  if (!state) {
    state = {
      originalInertiaZoom: controller.inertiaZoom,
      originalMinimumZoomDistance: controller.minimumZoomDistance,
      owners: new Set(),
    };
    ZOOM_INERTIA_STATES.set(controller, state);
  }
  state.owners.add(entity);
  controller.inertiaZoom = 0;
  controller.minimumZoomDistance = Math.max(
    state.originalMinimumZoomDistance,
    MIN_TRACKED_RANGE_M,
  );
  return () => {
    const current = ZOOM_INERTIA_STATES.get(controller);
    if (!current) return;
    current.owners.delete(entity);
    if (current.owners.size > 0) return;
    controller.inertiaZoom = current.originalInertiaZoom;
    controller.minimumZoomDistance = current.originalMinimumZoomDistance;
    ZOOM_INERTIA_STATES.delete(controller);
  };
}

/**
 * Keep a tracked-frame camera on the same side of its target and outside the
 * minimum readable range.
 *
 * @param {{position: Cesium.Cartesian3, direction: Cesium.Cartesian3}} camera Camera-like object.
 * @param {Cesium.Cartesian3} previousPosition Previous tracked-frame camera position.
 * @param {number} [minimumRangeM=MIN_TRACKED_RANGE_M] Minimum target range.
 * @returns {boolean} Whether the camera position was corrected.
 */
export function clampTrackedCameraPosition(
  camera,
  previousPosition,
  minimumRangeM = MIN_TRACKED_RANGE_M,
) {
  const crossedOrigin = Cesium.Cartesian3.dot(camera.position, previousPosition) <= 0;
  const forwardDistance = -Cesium.Cartesian3.dot(camera.position, camera.direction);
  const rangeSquared = Cesium.Cartesian3.magnitudeSquared(camera.position);
  if (crossedOrigin) {
    Cesium.Cartesian3.normalize(previousPosition, camera.position);
    Cesium.Cartesian3.multiplyByScalar(camera.position, minimumRangeM, camera.position);
    return true;
  }
  if (
    forwardDistance < minimumRangeM
    || rangeSquared < minimumRangeM * minimumRangeM
  ) {
    Cesium.Cartesian3.multiplyByScalar(
      camera.direction,
      -minimumRangeM,
      camera.position,
    );
    return true;
  }
  return false;
}

/**
 * Apply an entity's requested follow offset once, then let Cesium's ENU
 * EntityView exclusively own continuous following.
 *
 * Cesium can retain the previous world-space camera position when tracking
 * switches across a large distance. The view then only rotates toward the new
 * aircraft, and the next zoom can drive the camera through the ellipsoid.
 * Applying the exact frame for the handoff makes selection deterministic. We
 * deliberately do not rebuild it every frame: Cesium's EntityView already
 * follows the same ENU entity, and two writers create sub-pixel camera jitter
 * that becomes visible at minimum range.
 *
 * @param {Cesium.Viewer} viewer Active viewer.
 * @param {Cesium.Entity} entity Newly tracked entity.
 * @param {Cesium.Cartesian3} viewFrom Desired camera offset in the tracked frame.
 * @returns {(() => void)|undefined} Disposer for this one tracked-frame owner.
 */
export function applyTrackedCameraFrame(viewer, entity, viewFrom) {
  if (!viewer || !entity || !viewFrom) return;
  let attempts = 0;
  const trackedTransform = new Cesium.Matrix4();
  const trackedPosition = new Cesium.Cartesian3();
  const resolvedViewFrom = new Cesium.Cartesian3();
  const cameraOffset = new Cesium.Cartesian3();
  const previousCameraPosition = new Cesium.Cartesian3();
  let framed = false;
  const restoreZoomInertia = acquireStableTrackedZoom(
    viewer.scene.screenSpaceCameraController,
    entity,
  );
  let stopped = false;
  let remove = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    remove?.();
    restoreZoomInertia();
  };

  // preUpdate is deliberate. preRender fires after Cesium has prepared
  // billboard/model draw state, so changing the tracked transform there makes
  // the camera and target visual disagree for one frame (visible as a
  // front/back oscillation). The controller then enforces the minimum range
  // during the same update pass.
  remove = viewer.scene.preUpdate.addEventListener(() => {
    if (viewer.isDestroyed() || viewer.trackedEntity !== entity) {
      stop();
      return;
    }
    attempts += framed ? 0 : 1;
    // Prefer the display cache exposed by the flight layer. Calling the
    // CallbackProperty from preUpdate can advance dead reckoning again while
    // Cesium's billboard/label still holds the prior visualizer sample. At a
    // 150 m follow range that sub-frame difference becomes visible as the
    // label swinging around the icon during an orbit, especially immediately
    // after a 2D→3D→2D handoff.
    if (!framed) {
      const position = trackedDisplayPositionForCamera(
        entity,
        viewer.clock.currentTime,
        trackedPosition,
      );
      if (!position) {
        if (attempts >= MAX_FRAME_ATTEMPTS) stop();
        return;
      }
      const transform = Cesium.Transforms.eastNorthUpToFixedFrame(
        position,
        Cesium.Ellipsoid.WGS84,
        trackedTransform,
      );
      const offset = typeof viewFrom.getValue === 'function'
        ? viewFrom.getValue(viewer.clock.currentTime, resolvedViewFrom)
        : Cesium.Cartesian3.clone(viewFrom, resolvedViewFrom);
      if (!offset || Cesium.Cartesian3.magnitudeSquared(offset) < Cesium.Math.EPSILON12) {
        stop();
        return;
      }
      viewer.camera.lookAtTransform(transform, offset);
      Cesium.Cartesian3.clone(viewer.camera.position, previousCameraPosition);
      framed = true;
      return;
    }

    // Normal frames are intentionally read-only: EntityView is the sole
    // continuous camera writer. Only a programmatic zoom that bypasses the
    // controller's minimumZoomDistance needs correction.
    if (clampTrackedCameraPosition(viewer.camera, previousCameraPosition)) {
      Cesium.Cartesian3.clone(viewer.camera.position, cameraOffset);
      viewer.camera.lookAtTransform(viewer.camera.transform, cameraOffset);
    }
    Cesium.Cartesian3.clone(viewer.camera.position, previousCameraPosition);
  });
  return stop;
}
