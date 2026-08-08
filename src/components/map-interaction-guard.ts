export interface ScreenPoint {
  x: number;
  y: number;
}

export interface CountryClickGestureTracker {
  pointerStart: ScreenPoint | null;
  dragged: boolean;
  suppressNextClick: boolean;
  lastDragAtMs: number;
}

export const COUNTRY_CLICK_DRAG_THRESHOLD_PX = 6;
export const COUNTRY_CLICK_DRAG_SUPPRESSION_MS = 250;

function currentNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createCountryClickGestureTracker(): CountryClickGestureTracker {
  return {
    pointerStart: null,
    dragged: false,
    suppressNextClick: false,
    lastDragAtMs: 0,
  };
}

export function startCountryClickGesture(
  tracker: CountryClickGestureTracker,
  point: ScreenPoint,
): void {
  tracker.pointerStart = point;
  tracker.dragged = false;
  // Preserve suppressNextClick across rapid gesture restarts so a quick
  // click immediately after a drag still consumes the prior drag window.
}

export function markCountryClickDrag(
  tracker: CountryClickGestureTracker,
  nowMs = currentNowMs(),
): void {
  tracker.dragged = true;
  refreshCountryClickDragSuppression(tracker, nowMs);
}

export function refreshCountryClickDragSuppression(
  tracker: CountryClickGestureTracker,
  nowMs = currentNowMs(),
): void {
  tracker.suppressNextClick = true;
  tracker.lastDragAtMs = nowMs;
}

export function updateCountryClickGestureDrag(
  tracker: CountryClickGestureTracker,
  point: ScreenPoint,
  nowMs = currentNowMs(),
): boolean {
  if (!tracker.pointerStart) return false;
  const dx = point.x - tracker.pointerStart.x;
  const dy = point.y - tracker.pointerStart.y;
  if ((dx * dx + dy * dy) <= COUNTRY_CLICK_DRAG_THRESHOLD_PX * COUNTRY_CLICK_DRAG_THRESHOLD_PX) {
    return false;
  }
  markCountryClickDrag(tracker, nowMs);
  return true;
}

export function finishCountryClickGesture(
  tracker: CountryClickGestureTracker,
  nowMs = currentNowMs(),
): void {
  if (tracker.dragged) markCountryClickDrag(tracker, nowMs);
  tracker.pointerStart = null;
  tracker.dragged = false;
}

export function shouldSuppressCountryClick(
  tracker: CountryClickGestureTracker,
  nowMs = currentNowMs(),
): boolean {
  if (!tracker.suppressNextClick) return false;
  // This check is intentionally single-use: call once per click event so a
  // drag can suppress at most the synthetic click that follows it.
  tracker.suppressNextClick = false;
  return nowMs - tracker.lastDragAtMs <= COUNTRY_CLICK_DRAG_SUPPRESSION_MS;
}
