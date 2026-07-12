/**
 * three.js OrbitControls (≤ r183) position-tracks ONLY touch pointers
 * (`_trackPointer` runs solely in the touch branches), yet reads the tracked
 * position of arbitrary pointers in two places:
 *   - onPointerUp case 1: the surviving pointer of a multi-pointer gesture
 *   - _getSecondPointerPosition: the other pointer of a two-pointer dolly/pan
 * A concurrent mouse|pen + touch gesture (touchscreen laptops) therefore
 * crashes with `Cannot read properties of undefined (reading 'x')`
 * (Sentry WORLDMONITOR-QD).
 *
 * The handlers are stored as bound instance fields that three re-reads at
 * dispatch time (document listeners are registered per-pointerdown, internal
 * calls go through `this._onTouchStart(...)`), so wrapping the fields on the
 * live instance intercepts every path. Each wrapper seeds a position entry
 * for any untracked pointer before delegating.
 */

interface SeededPosition {
  x: number;
  y: number;
  set(x: number, y: number): SeededPosition;
}

interface PointerTrackingInternals {
  _pointers?: unknown;
  _pointerPositions?: Record<number, SeededPosition | undefined>;
  _onPointerUp?: unknown;
  _onTouchStart?: unknown;
  _onTouchMove?: unknown;
}

type PointerLikeEvent = { pageX?: number; pageY?: number };

// Mimics the THREE.Vector2 surface OrbitControls uses on stored positions
// (.x/.y reads + _trackPointer's position.set()).
function createSeededPosition(x: number, y: number): SeededPosition {
  return {
    x,
    y,
    set(nx: number, ny: number) {
      this.x = nx;
      this.y = ny;
      return this;
    },
  };
}

const GUARDED_HANDLERS = ['_onPointerUp', '_onTouchStart', '_onTouchMove'] as const;

/**
 * Returns true when at least one handler was wrapped; false when the
 * instance doesn't expose the expected internals (e.g. a future three
 * upgrade renames them), in which case the instance is left untouched —
 * the guard must never break controls that no longer have the bug.
 */
export function guardOrbitControlsPointerTracking(controls: object): boolean {
  const c = controls as PointerTrackingInternals;
  if (!Array.isArray(c._pointers)) return false;
  if (typeof c._pointerPositions !== 'object' || c._pointerPositions === null) return false;

  let wrapped = false;
  for (const name of GUARDED_HANDLERS) {
    const original = c[name];
    if (typeof original !== 'function') continue;
    c[name] = (event: PointerLikeEvent) => {
      const pointers = c._pointers;
      const positions = c._pointerPositions;
      if (Array.isArray(pointers) && positions) {
        for (const id of pointers) {
          if (typeof id === 'number' && positions[id] === undefined) {
            positions[id] = createSeededPosition(event?.pageX ?? 0, event?.pageY ?? 0);
          }
        }
      }
      return original(event);
    };
    wrapped = true;
  }
  return wrapped;
}
