/**
 * three.js OrbitControls (≤ r183) position-tracks ONLY touch pointers
 * (`_trackPointer` runs solely in the touch branches), yet reads the tracked
 * position of arbitrary pointers in two places:
 *   - onPointerUp case 1: the surviving pointer of a multi-pointer gesture
 *   - _getSecondPointerPosition: the other pointer of a two-pointer
 *     rotate/dolly/pan gesture
 * A concurrent mouse|pen + touch gesture (touchscreen laptops) therefore
 * crashes with `Cannot read properties of undefined (reading 'x')`
 * (Sentry WORLDMONITOR-QD).
 *
 * The handlers are stored as bound instance fields that three re-reads at
 * dispatch time (`this._onTouchStart(...)`, and the document listeners are
 * registered per-pointerdown), so wrapping the fields on the live instance
 * intercepts every path — including the DOM pointermove → `_onTouchMove` one.
 * tests/orbit-controls-pointer-guard.test.mjs pins that against real three, so
 * an upgrade that switches to closure dispatch fails loudly instead of
 * silently un-guarding.
 *
 * Every pointer's real position is recorded from the events three already
 * hands us (pointerdown/pointermove fire for mouse and pen too, not just
 * touch), so a seeded entry carries that pointer's ACTUAL last-known
 * coordinates. Seeding from the triggering event instead would re-anchor the
 * gesture at the wrong pointer's position and snap the camera.
 */

interface SeededPosition {
  x: number;
  y: number;
  set(x: number, y: number): SeededPosition;
}

interface PointerTrackingInternals {
  _pointers?: unknown;
  _pointerPositions?: Record<number, SeededPosition | undefined>;
  _onPointerDown?: unknown;
  _onPointerMove?: unknown;
  _onPointerUp?: unknown;
  _onTouchStart?: unknown;
  _onTouchMove?: unknown;
  domElement?: unknown;
  connect?: unknown;
  disconnect?: unknown;
}

type PointerLikeEvent = {
  pointerId?: number;
  pageX?: number;
  pageY?: number;
};

// Handlers three dispatches through instance fields. The seeding ones read a
// tracked position (directly or via _getSecondPointerPosition); the rest are
// wrapped only to observe pointer positions.
const SEEDING_HANDLERS = ['_onPointerUp', '_onTouchStart', '_onTouchMove'] as const;
const OBSERVING_HANDLERS = ['_onPointerDown', '_onPointerMove'] as const;

// Mimics the THREE.Vector2 surface OrbitControls uses on stored positions
// (.x/.y reads plus _trackPointer's position.set()).
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

/**
 * Returns true when the guard was installed; false when the instance doesn't
 * expose the expected internals (e.g. a future three upgrade renames them), in
 * which case it is left untouched — the guard must never break controls that
 * no longer have the bug.
 */
export function guardOrbitControlsPointerTracking(controls: object): boolean {
  const c = controls as PointerTrackingInternals;
  if (!Array.isArray(c._pointers)) return false;
  if (typeof c._pointerPositions !== 'object' || c._pointerPositions === null) return false;
  // OrbitControls stores pointer IDs; TrackballControls stores whole events.
  // Only the ID shape is understood here — bail rather than mis-seed.
  if (c._pointers.some((id) => typeof id !== 'number')) return false;
  if (!SEEDING_HANDLERS.some((name) => typeof c[name] === 'function')) return false;

  // Last-known page coordinates per pointer ID, from every event three routes
  // through a wrapped handler.
  const lastKnown = new Map<number, { x: number; y: number }>();

  const record = (event: PointerLikeEvent | undefined): void => {
    const id = event?.pointerId;
    if (typeof id !== 'number') return;
    const { pageX, pageY } = event as { pageX?: number; pageY?: number };
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return;
    lastKnown.set(id, { x: pageX as number, y: pageY as number });
  };

  const seedUntrackedPointers = (event: PointerLikeEvent | undefined): void => {
    const pointers = c._pointers;
    const positions = c._pointerPositions;
    if (!Array.isArray(pointers) || !positions) return;
    for (const id of pointers) {
      if (typeof id !== 'number' || positions[id] !== undefined) continue;
      // Fall back to the triggering event only if this pointer was never seen
      // (it always has been — every pointer enters through pointerdown).
      const seen = lastKnown.get(id);
      positions[id] = createSeededPosition(
        seen?.x ?? (event?.pageX ?? 0),
        seen?.y ?? (event?.pageY ?? 0),
      );
    }
  };

  const pruneLiftedPointers = (): void => {
    const pointers = c._pointers;
    if (!Array.isArray(pointers)) return;
    for (const id of lastKnown.keys()) {
      if (!pointers.includes(id)) lastKnown.delete(id);
    }
  };

  // connect() registered the `pointerdown` and `pointercancel` DOM listeners
  // with the ORIGINAL bound functions back in the constructor, so wrapping the
  // fields alone never reaches them: pointercancel (palm rejection, system
  // gesture) would still hit the unguarded onPointerUp, and pointerdown would
  // never record positions. Re-register through three's own API.
  //
  // Order matters: disconnect() removes listeners by identity
  // (removeEventListener(type, this._onPointerUp)), so it MUST run while the
  // fields still hold the originals. Disconnecting after wrapping would fail to
  // match — leaving the original listeners attached AND adding the wrapped ones,
  // so the unguarded handler would keep firing first.
  const { connect, disconnect, domElement } = c;
  const canRebind =
    typeof connect === 'function' && typeof disconnect === 'function' && !!domElement;
  if (canRebind) (disconnect as () => void).call(c);

  for (const name of [...OBSERVING_HANDLERS, ...SEEDING_HANDLERS]) {
    const original = c[name];
    if (typeof original !== 'function') continue;
    const seeds = (SEEDING_HANDLERS as readonly string[]).includes(name);
    c[name] = (event: PointerLikeEvent) => {
      record(event);
      if (seeds) seedUntrackedPointers(event);
      try {
        return original(event);
      } finally {
        // A lifted pointer is gone from _pointers by the time onPointerUp
        // returns; drop it so a long session can't accumulate stale IDs.
        if (name === '_onPointerUp') pruneLiftedPointers();
      }
    };
  }

  // Re-registers pointerdown/pointercancel against the wrapped fields.
  // (pointermove/pointerup are registered per-pointerdown and so already read
  // the fields after wrapping.)
  if (canRebind) (connect as (el: unknown) => void).call(c, domElement);
  return true;
}
