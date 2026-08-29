/** Bottom-to-top order for near-plane-clamped contact sprite collections. */
export const SPRITE_LAYER_ORDER = Object.freeze([
  'cctv',
  'firms',
  'bikeshare',
  'ais',
  'military',
  'flights',
]);

/** @type {Map<string, Object>} */
const _collections = new Map();

/**
 * Register the current primitive collection for a sprite layer.
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} collection - Cesium billboard/point primitive collection.
 * @returns {void}
 */
export function registerSpriteCollection(layerId, collection) {
  if (!layerId || !collection) return;
  _collections.set(layerId, collection);
}

/**
 * Remove a registered collection (primarily useful to lifecycle tests).
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} [collection] - Optional identity guard against stale teardown.
 * @returns {void}
 */
export function unregisterSpriteCollection(layerId, collection) {
  if (collection && _collections.get(layerId) !== collection) return;
  _collections.delete(layerId);
}

/**
 * Reassert deterministic sprite stacking after any layer enable/init.
 * Cesium's stable translucent sort otherwise preserves first-enable primitive
 * order. Raising bottom-to-top makes flights the final/top collection.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @returns {void}
 */
export function restoreSpriteOrder(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return;
  const scene = viewer.scene;
  const primitives = scene?.primitives;
  if (!primitives || scene.isDestroyed?.() || primitives.isDestroyed?.()) return;

  for (const layerId of SPRITE_LAYER_ORDER) {
    const collection = _collections.get(layerId);
    if (!collection || collection.isDestroyed?.()) continue;
    if (primitives.contains?.(collection) === false) continue;
    primitives.raiseToTop(collection);
  }
}

/**
 * Explicit layer-enable wiring seam. Production callers use the shared
 * restorer by default; tests inject a spy to pin each enable path without
 * constructing a WebGL viewer.
 * @param {string} layerId - Sprite layer whose enable path is restoring order.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @param {(viewer: Object) => void} [restore=restoreSpriteOrder] - Test seam.
 * @returns {void}
 */
export function restoreSpriteOrderOnEnable(
  layerId,
  viewer,
  restore = restoreSpriteOrder,
) {
  if (!SPRITE_LAYER_ORDER.includes(layerId) || typeof restore !== 'function') return;
  restore(viewer);
}
