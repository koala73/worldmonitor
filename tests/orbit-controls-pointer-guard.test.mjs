import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { guardOrbitControlsPointerTracking } from '../src/utils/orbit-controls-pointer-guard.ts';

// Exercises the REAL three OrbitControls (the version globe.gl instantiates —
// globe.gl passes controlType:'orbit'), driven through the listeners three
// itself registers. Nothing about three's internals is re-implemented here, so
// a three upgrade that changes pointer tracking or handler dispatch fails this
// suite instead of silently un-guarding production (Sentry WORLDMONITOR-QD).

// Minimal DOM element: only the surface OrbitControls.connect() touches. The
// repo's unit tests run under tsx --test with no jsdom.
function createFakeElement() {
  const listeners = new Map();
  const doc = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  };
  const element = {
    style: {},
    listeners,
    ownerDocument: doc,
    getRootNode: () => doc,
    addEventListener: doc.addEventListener,
    removeEventListener: doc.removeEventListener,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    clientWidth: 800,
    clientHeight: 600,
  };
  return element;
}

function createControls({ guarded }) {
  const element = createFakeElement();
  const controls = new OrbitControls(new PerspectiveCamera(50, 4 / 3, 0.1, 1000), element);
  if (guarded) assert.equal(guardOrbitControlsPointerTracking(controls), true);

  // Dispatch through three's own registered listeners — the production path.
  // Handlers are re-read from the listener set on every fire, so a listener
  // registered later (pointermove/pointerup are added on first pointerdown) is
  // picked up exactly as the DOM would.
  const fire = (type, event) => {
    const fns = element.listeners.get(type);
    assert.ok(fns?.size, `no listener registered for "${type}"`);
    for (const fn of [...fns]) fn(event);
  };
  return { controls, fire };
}

const evt = (pointerType, pointerId, x, y) => ({
  pointerType,
  pointerId,
  pageX: x,
  pageY: y,
  clientX: x,
  clientY: y,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault: () => {},
});
const touch = (id, x, y) => evt('touch', id, x, y);
const mouse = (id, x, y) => evt('mouse', id, x, y);

const READS_UNDEFINED_X = /Cannot read properties of undefined \(reading 'x'\)|undefined is not an object/;

describe('three OrbitControls mixed mouse+touch crash (WORLDMONITOR-QD)', () => {
  it('crashes unguarded on pointerup when the surviving pointer is a mouse', () => {
    const { fire } = createControls({ guarded: false });
    fire('pointerdown', touch(1, 10, 10));
    fire('pointerdown', mouse(2, 20, 20));
    assert.throws(() => fire('pointerup', touch(1, 15, 15)), READS_UNDEFINED_X);
  });

  it('crashes unguarded when a finger joins an in-progress mouse drag', () => {
    const { fire } = createControls({ guarded: false });
    fire('pointerdown', mouse(1, 10, 10));
    assert.throws(() => fire('pointerdown', touch(2, 20, 20)), READS_UNDEFINED_X);
  });

  // pointercancel (palm rejection, system gesture) routes to the same
  // onPointerUp. three registers it at CONSTRUCTION time bound to the original
  // handler, so it is guarded only because the guard re-registers the DOM
  // listeners — wrapping the fields alone would leave this path crashing.
  it('crashes unguarded on pointercancel with a surviving mouse pointer', () => {
    const { fire } = createControls({ guarded: false });
    fire('pointerdown', touch(1, 10, 10));
    fire('pointerdown', mouse(2, 20, 20));
    assert.throws(() => fire('pointercancel', touch(1, 15, 15)), READS_UNDEFINED_X);
  });
});

describe('guardOrbitControlsPointerTracking', () => {
  it('survives pointerup with an untracked surviving mouse pointer', () => {
    const { fire } = createControls({ guarded: true });
    fire('pointerdown', touch(1, 10, 10));
    fire('pointerdown', mouse(2, 20, 20));
    fire('pointerup', touch(1, 15, 15));
  });

  it('survives a finger joining an in-progress mouse drag', () => {
    const { fire } = createControls({ guarded: true });
    fire('pointerdown', mouse(1, 10, 10));
    fire('pointerdown', touch(2, 20, 20));
  });

  it('survives pointercancel with an untracked surviving mouse pointer', () => {
    const { fire } = createControls({ guarded: true });
    fire('pointerdown', touch(1, 10, 10));
    fire('pointerdown', mouse(2, 20, 20));
    fire('pointercancel', touch(1, 15, 15));
  });

  // The guard wraps handler FIELDS, which only holds if three dispatches through
  // them (`this._onTouchMove(event)`) rather than through a closure captured at
  // construction. Prove it via the DOM listener three registered, not by calling
  // the field: reach the two-pointer dolly state (only reachable once the guard
  // has seeded the mouse), then strip the mouse's tracked position so the move
  // handler faces the untracked-pointer condition. Only the guard's wrapper can
  // re-seed it — if a three upgrade moves to closure dispatch, no re-seed happens
  // and _handleTouchMoveDolly throws right here.
  it('reaches _onTouchMove through the DOM pointermove listener (field-dispatch assumption)', () => {
    const { controls, fire } = createControls({ guarded: true });
    fire('pointerdown', mouse(1, 10, 10));
    fire('pointerdown', touch(2, 20, 20));

    delete controls._pointerPositions[1];
    fire('pointermove', touch(2, 30, 30));

    const reseeded = controls._pointerPositions[1];
    assert.ok(reseeded, 'the guard must re-seed via the DOM pointermove path');
    assert.deepEqual(
      { x: reseeded.x, y: reseeded.y },
      { x: 10, y: 10 },
      "re-seeded at the mouse's last-known position",
    );
  });

  it('seeds the untracked pointer at ITS OWN last-known position, not the triggering event', () => {
    const { controls, fire } = createControls({ guarded: true });
    fire('pointerdown', touch(1, 10, 10));
    fire('pointerdown', mouse(2, 20, 20));
    fire('pointermove', mouse(2, 55, 65)); // mouse moves; touch does not
    fire('pointerup', touch(1, 15, 15)); // triggering event is at (15,15)

    const seeded = controls._pointerPositions[2];
    assert.ok(seeded, 'surviving mouse pointer must have a seeded position');
    assert.deepEqual(
      { x: seeded.x, y: seeded.y },
      { x: 55, y: 65 },
      'seeded from the mouse\'s real position, not the lifted finger\'s (15,15)',
    );
  });

  it('does not alter ordinary two-finger touch gestures', () => {
    const sequence = (fire) => {
      fire('pointerdown', touch(1, 10, 10));
      fire('pointerdown', touch(2, 20, 20));
      fire('pointermove', touch(2, 30, 30));
      fire('pointerup', touch(2, 30, 30));
      fire('pointerup', touch(1, 10, 10));
    };
    const plain = createControls({ guarded: false });
    const guarded = createControls({ guarded: true });
    sequence(plain.fire);
    sequence(guarded.fire);

    // Same camera state and same tracked-pointer bookkeeping: on the all-touch
    // path every pointer is already tracked, so the guard has nothing to seed.
    assert.deepEqual(
      guarded.controls.object.position.toArray(),
      plain.controls.object.position.toArray(),
    );
    assert.deepEqual(guarded.controls._pointers, plain.controls._pointers);
    assert.deepEqual(
      Object.keys(guarded.controls._pointerPositions),
      Object.keys(plain.controls._pointerPositions),
    );
  });

  it('drops lifted pointers so a long session cannot accumulate stale IDs', () => {
    const { controls, fire } = createControls({ guarded: true });
    for (let id = 1; id <= 50; id++) {
      fire('pointerdown', touch(id, id, id));
      fire('pointerup', touch(id, id, id));
    }
    assert.deepEqual(controls._pointers, []);
    assert.deepEqual(Object.keys(controls._pointerPositions), []);
  });

  it('fails soft when the private internals are missing (future three upgrade)', () => {
    assert.equal(guardOrbitControlsPointerTracking({}), false);
    // Internals present but no handler fields to wrap.
    assert.equal(guardOrbitControlsPointerTracking({ _pointers: [], _pointerPositions: {} }), false);
    // TrackballControls stores whole events in _pointers, not IDs — bail rather than mis-seed.
    assert.equal(
      guardOrbitControlsPointerTracking({
        _pointers: [{ pointerId: 1 }],
        _pointerPositions: {},
        _onPointerUp: () => {},
      }),
      false,
    );
  });
});
