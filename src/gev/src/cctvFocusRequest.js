export const CCTV_FOCUS_REQUEST_EVENT = 'gev:cctv-request-focus';
export const CCTV_WORLD_CLICK_FOCUS_DURATION_SEC = 1.9;
export const CCTV_ACTIVATION_RESULT = Object.freeze({
  ACTIVATED: 'activated',
  UNCHANGED: 'unchanged',
  NOT_FOUND: 'not-found',
});

/**
 * Activate a camera selected by an in-world user click, then request the UI's
 * cockpit-safe explicit focus path. Programmatic activation and auto-hop do not
 * call this function, so they cannot emit the request.
 * @param {string} cameraId - Clicked camera ID.
 * @param {(cameraId: string) => string} activate - Discriminated CCTV activation callback.
 * @param {EventTarget} [eventTarget=window] - Dispatch target.
 * @returns {boolean} Whether a real activation occurred and the request was sent.
 */
export function activateCctvCameraFromWorldClick(
  cameraId,
  activate,
  eventTarget = window,
) {
  if (!cameraId || typeof activate !== 'function') return false;
  if (activate(cameraId) !== CCTV_ACTIVATION_RESULT.ACTIVATED) return false;
  eventTarget.dispatchEvent(new CustomEvent(CCTV_FOCUS_REQUEST_EVENT, {
    detail: { cameraId },
  }));
  return true;
}

/**
 * Register the UI focus-request listener and return an idempotent disposer that
 * removes the exact callback reference supplied to addEventListener.
 * @param {EventTarget|Object} eventTarget - Window-like event target.
 * @param {(event: Event) => void} listener - Stable listener callback.
 * @returns {() => void} Listener disposer.
 */
export function registerCctvFocusRequestListener(eventTarget, listener) {
  if (!eventTarget?.addEventListener || !eventTarget?.removeEventListener
    || typeof listener !== 'function') return () => {};
  eventTarget.addEventListener(CCTV_FOCUS_REQUEST_EVENT, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    eventTarget.removeEventListener(CCTV_FOCUS_REQUEST_EVENT, listener);
  };
}

/**
 * Route one CCTV world-click request through StyleManager's existing explicit
 * focus policy, preserving tracking release and cockpit refusal behavior.
 * @param {CustomEvent|Object} event - Focus-request event.
 * @param {(activate: Function, focus: Function) => *} runExplicitFocus - Policy path.
 * @param {(cameraId: string, durationSec: number) => *} focusCamera - CCTV flight callback.
 * @returns {*} Focus-path result, or false for a malformed request.
 */
export function routeCctvFocusRequest(event, runExplicitFocus, focusCamera) {
  const cameraId = event?.detail?.cameraId;
  if (typeof cameraId !== 'string' || !cameraId || typeof runExplicitFocus !== 'function') {
    return false;
  }
  return runExplicitFocus(
    () => cameraId,
    (selectedId) => focusCamera(selectedId, CCTV_WORLD_CLICK_FOCUS_DURATION_SEC),
  );
}
