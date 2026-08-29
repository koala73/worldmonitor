import * as Cesium from 'cesium';

export const MAX_TRACKING_CLICK_TRAVEL_PX = 6;
export const MAX_TRACKING_CLICK_DURATION_MS = 400;

/**
 * Decide whether a completed press stayed spatially click-like. Duration is
 * deliberately ignored so a stationary long press may still select a contact;
 * callers apply the full click classifier before destructive deselection.
 * @param {{travelPx?: number}} gesture - Accumulated pointer path.
 * @returns {boolean} True when travel stays within the click limit.
 */
export function isTrackingSelectionGesture(gesture = {}) {
  const travelPx = Number.isFinite(gesture.travelPx)
    ? Math.max(0, gesture.travelPx)
    : Number.POSITIVE_INFINITY;
  return travelPx <= MAX_TRACKING_CLICK_TRAVEL_PX;
}

/**
 * Decide whether a completed press is a clean click suitable for deselection
 * or another action that requires both short duration and low travel.
 * @param {{travelPx?: number, durationMs?: number}} gesture - Accumulated path and press time.
 * @returns {boolean} True when the gesture stays within both click limits.
 */
export function isTrackingClickGesture(gesture = {}) {
  const durationMs = Number.isFinite(gesture.durationMs)
    ? Math.max(0, gesture.durationMs)
    : Number.POSITIVE_INFINITY;
  return isTrackingSelectionGesture(gesture)
    && durationMs <= MAX_TRACKING_CLICK_DURATION_MS;
}

/**
 * Bind LEFT_DOWN/MOUSE_MOVE/LEFT_UP accounting ahead of a scene click.
 * Travel is accumulated segment-by-segment, so an orbit nudge that returns to
 * its starting pixel cannot masquerade as a zero-distance click. Every scene
 * click reaches `onClick` with its gesture metadata; the caller decides whether
 * selection (travel-only) or deselection (travel + duration) is allowed.
 * @param {Cesium.ScreenSpaceEventHandler|Object} handler - Input handler.
 * @param {(click: Object, gesture: {travelPx: number, durationMs: number}) => void} onClick - Scene-click callback.
 * @param {{now?: () => number, eventTypes?: Object, onMouseMove?: (event: Object) => void}} [options] - Test/interop seams.
 * @returns {void}
 */
export function bindTrackingClickGesture(handler, onClick, options = {}) {
  const now = options.now || (() => performance.now());
  const eventTypes = options.eventTypes || Cesium.ScreenSpaceEventType;
  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (!pressActive || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    if (previousPosition) {
      travelPx += Math.hypot(
        position.x - previousPosition.x,
        position.y - previousPosition.y,
      );
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = {
      travelPx,
      durationMs: Math.max(0, now() - pressStartedAt),
    };
    pressActive = false;
    previousPosition = null;
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
    options.onMouseMove?.(event);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    onClick(click, gesture);
  }, eventTypes.LEFT_CLICK);
}
