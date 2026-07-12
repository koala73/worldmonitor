import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guardOrbitControlsPointerTracking } from '../src/utils/orbit-controls-pointer-guard.ts';

// Replicates the pointer-tracking internals of three.js r183 OrbitControls
// (examples/jsm/controls/OrbitControls.js). Handlers are stored as instance
// fields and internal calls dispatch through the CURRENT field value — same
// semantics as three's `this._onTouchStart(...)` calls — so field-level
// wrapping in the guard is exercised exactly as in production.
//
// Crash sites replicated verbatim from upstream:
//  1. onPointerUp case 1: `position.x` of the surviving pointer (WORLDMONITOR-QD)
//  2. _handleTouchStartDolly / _handleTouchMoveDolly: `_getSecondPointerPosition().x`
// Only touch pointers are position-tracked (`_trackPointer` runs solely in the
// touch branches), so any mouse/pen pointer in a multi-pointer gesture leaves
// `_pointerPositions[id]` undefined.
function createFakeOrbitControls(log) {
  const controls = {
    _pointers: [],
    _pointerPositions: {},
  };

  controls._addPointer = (event) => {
    controls._pointers.push(event.pointerId);
  };

  controls._removePointer = (event) => {
    delete controls._pointerPositions[event.pointerId];
    const i = controls._pointers.indexOf(event.pointerId);
    if (i !== -1) controls._pointers.splice(i, 1);
  };

  controls._trackPointer = (event) => {
    let position = controls._pointerPositions[event.pointerId];
    if (position === undefined) {
      position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
      controls._pointerPositions[event.pointerId] = position;
    }
    position.set(event.pageX, event.pageY);
  };

  controls._getSecondPointerPosition = (event) => {
    const pointerId = event.pointerId === controls._pointers[0]
      ? controls._pointers[1]
      : controls._pointers[0];
    return controls._pointerPositions[pointerId];
  };

  controls._onMouseDown = (event) => {
    log.push(['mouseDown', event.pageX, event.pageY]);
  };

  controls._onTouchStart = (event) => {
    controls._trackPointer(event);
    if (controls._pointers.length === 2) {
      // touches.TWO → DOLLY_PAN → _handleTouchStartDolly (crash site 2)
      const position = controls._getSecondPointerPosition(event);
      const dx = event.pageX - position.x;
      const dy = event.pageY - position.y;
      log.push(['touchStartDolly', dx, dy]);
    } else {
      log.push(['touchStartRotate', event.pageX, event.pageY]);
    }
  };

  controls._onTouchMove = (event) => {
    controls._trackPointer(event);
    if (controls._pointers.length === 2) {
      // _handleTouchMoveDolly (crash site 2, move variant)
      const position = controls._getSecondPointerPosition(event);
      log.push(['touchMoveDolly', (event.pageX + position.x) * 0.5]);
    } else {
      log.push(['touchMoveRotate', event.pageX, event.pageY]);
    }
  };

  controls._onPointerDown = (event) => {
    controls._addPointer(event);
    if (event.pointerType === 'touch') {
      controls._onTouchStart(event);
    } else {
      controls._onMouseDown(event);
    }
  };

  controls._onPointerUp = (event) => {
    controls._removePointer(event);
    switch (controls._pointers.length) {
      case 0:
        log.push(['end']);
        break;
      case 1: {
        const pointerId = controls._pointers[0];
        const position = controls._pointerPositions[pointerId];
        // crash site 1: `position` is undefined for an untracked survivor
        controls._onTouchStart({ pointerId, pageX: position.x, pageY: position.y });
        break;
      }
    }
  };

  return controls;
}

const touch = (id, x, y) => ({ pointerId: id, pointerType: 'touch', pageX: x, pageY: y });
const mouse = (id, x, y) => ({ pointerId: id, pointerType: 'mouse', pageX: x, pageY: y });

describe('unguarded three r183 replica reproduces the crash class', () => {
  it('throws on pointerup when the surviving pointer is a mouse (WORLDMONITOR-QD)', () => {
    const controls = createFakeOrbitControls([]);
    controls._onPointerDown(touch(1, 10, 10));
    controls._onPointerDown(mouse(2, 20, 20));
    assert.throws(
      () => controls._onPointerUp(touch(1, 10, 10)),
      /Cannot read properties of undefined \(reading 'x'\)/,
    );
  });

  it('throws on second-finger touch start when the first pointer is a mouse', () => {
    const controls = createFakeOrbitControls([]);
    controls._onPointerDown(mouse(1, 10, 10));
    assert.throws(
      () => controls._onPointerDown(touch(2, 20, 20)),
      /Cannot read properties of undefined \(reading 'x'\)/,
    );
  });
});

describe('guardOrbitControlsPointerTracking', () => {
  it('survives pointerup with an untracked surviving mouse pointer', () => {
    const log = [];
    const controls = createFakeOrbitControls(log);
    assert.equal(guardOrbitControlsPointerTracking(controls), true);

    controls._onPointerDown(touch(1, 10, 10));
    controls._onPointerDown(mouse(2, 20, 20));
    controls._onPointerUp(touch(1, 15, 15));

    // The placeholder touch-start for the surviving pointer ran instead of throwing,
    // anchored at the seeded position (the triggering event's coords).
    assert.deepEqual(log.at(-1), ['touchStartRotate', 15, 15]);
  });

  it('survives a second-finger touch start alongside an untracked mouse pointer', () => {
    const log = [];
    const controls = createFakeOrbitControls(log);
    guardOrbitControlsPointerTracking(controls);

    controls._onPointerDown(mouse(1, 10, 10));
    controls._onPointerDown(touch(2, 20, 20));

    // Dolly start computed against the seeded position — no throw.
    assert.equal(log.at(-1)[0], 'touchStartDolly');
  });

  it('survives two-pointer touch move alongside an untracked mouse pointer', () => {
    const log = [];
    const controls = createFakeOrbitControls(log);
    guardOrbitControlsPointerTracking(controls);

    controls._onPointerDown(mouse(1, 10, 10));
    controls._onPointerDown(touch(2, 20, 20));
    controls._onTouchMove(touch(2, 30, 30));

    assert.equal(log.at(-1)[0], 'touchMoveDolly');
  });

  it('leaves ordinary two-finger touch gestures untouched', () => {
    const log = [];
    const controls = createFakeOrbitControls(log);
    guardOrbitControlsPointerTracking(controls);

    controls._onPointerDown(touch(1, 10, 10));
    controls._onPointerDown(touch(2, 20, 20));
    controls._onTouchMove(touch(2, 30, 30));
    controls._onPointerUp(touch(2, 30, 30));
    controls._onPointerUp(touch(1, 10, 10));

    assert.deepEqual(log, [
      ['touchStartRotate', 10, 10],
      ['touchStartDolly', 20 - 10, 20 - 10],
      ['touchMoveDolly', (30 + 10) * 0.5],
      // pointer 2 lifted → placeholder touch-start re-anchors on pointer 1's tracked position
      ['touchStartRotate', 10, 10],
      ['end'],
    ]);
  });

  it('keeps seeded positions compatible with later _trackPointer set() calls', () => {
    const log = [];
    const controls = createFakeOrbitControls(log);
    guardOrbitControlsPointerTracking(controls);

    controls._onPointerDown(mouse(1, 10, 10));
    controls._onPointerDown(touch(2, 20, 20)); // seeds position for pointer 1
    // placeholder touch-start on the seeded pointer must not crash on position.set
    controls._onPointerUp(touch(2, 20, 20));
    assert.equal(log.at(-1)[0], 'touchStartRotate');
  });

  it('fails soft when the private internals are missing (future three upgrade)', () => {
    assert.equal(guardOrbitControlsPointerTracking({}), false);
    const noHandlers = { _pointers: [], _pointerPositions: {} };
    assert.equal(guardOrbitControlsPointerTracking(noHandlers), false);
  });
});
