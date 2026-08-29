/**
 * Activates the nearest CCTV record on layer enable and flies only when no
 * aircraft tracker or cockpit camera owns the view.
 * @param {Object} options Layer-enable focus inputs.
 * @param {*} options.trackedEntity Current Cesium tracked entity, if any.
 * @param {boolean} options.cockpitActive Whether cockpit mode owns the camera.
 * @param {() => (string|null)} options.activate Nearest-camera activation.
 * @param {(cameraId: string) => *} options.fly Optional camera flight.
 * @returns {*} Activated camera ID for a held view, or the flight result.
 */
export function runCctvLayerEnableFocus({
  trackedEntity = null,
  cockpitActive = false,
  activate,
  fly,
} = {}) {
  const cameraId = activate?.();
  if (!cameraId) return false;
  if (trackedEntity || cockpitActive) return cameraId;
  return fly?.(cameraId);
}

/**
 * Merges camera ownership sampled on both sides of the awaited layer-enable
 * chain. Either observation suppresses the optional CCTV focus flight.
 * @param {Object} [before={}] Ownership immediately before the await.
 * @param {Object} [after={}] Ownership immediately after the await.
 * @returns {{ trackedEntity: *, cockpitActive: boolean }} Conservative ownership.
 */
export function mergeCctvEnableOwnership(before = {}, after = {}) {
  return {
    trackedEntity: before.trackedEntity || after.trackedEntity || null,
    cockpitActive: !!(before.cockpitActive || after.cockpitActive),
  };
}

/**
 * Runs the awaited CCTV layer transition while preserving camera ownership
 * observed on either side for the optional enable-focus policy.
 *
 * @param {Object} options Transition dependencies.
 * @param {boolean} options.target Requested enabled state.
 * @param {(target: boolean) => Promise<*>} options.setEnabled Layer transition.
 * @param {() => Object} options.readOwnership Current tracked/cockpit state.
 * @param {() => boolean} options.shouldFocus Post-transition focus predicate.
 * @param {() => (string|null)} options.activate Nearest-camera activation.
 * @param {(cameraId: string) => *} options.fly Optional camera flight.
 * @param {Function} [options.debug] Diagnostic sink.
 * @returns {Promise<*>} Focus-policy result, or null when no focus was requested.
 */
export async function runCctvLayerEnableTransition({
  target,
  setEnabled,
  readOwnership,
  shouldFocus,
  activate,
  fly,
  debug = console.debug,
}) {
  const ownershipBefore = readOwnership?.() || {};
  if (target === true) {
    debug?.('[UI:CCTV] ownership before setEnabled await', {
      trackedId: ownershipBefore.trackedEntity?.id ?? null,
      cockpitActive: !!ownershipBefore.cockpitActive,
    });
  }
  await setEnabled?.(target);
  const ownershipAfter = readOwnership?.() || {};
  if (target === true) {
    debug?.('[UI:CCTV] ownership after setEnabled await', {
      trackedId: ownershipAfter.trackedEntity?.id ?? null,
      cockpitActive: !!ownershipAfter.cockpitActive,
    });
  }
  if (!target || !shouldFocus?.()) return null;
  return runCctvLayerEnableFocus({
    ...mergeCctvEnableOwnership(ownershipBefore, ownershipAfter),
    activate,
    fly,
  });
}
