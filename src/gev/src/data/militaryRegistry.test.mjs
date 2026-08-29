/**
 * Military-registry active-transition tests (pre-ship audit M2).
 *
 * Locks the setMilitaryLayerActive contract the flights layer's immediate
 * suppression/restore sweep depends on: listeners fire only on TRANSITIONS
 * (never on same-value sets), after the new state is committed, and a broken
 * listener can't break the toggle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setMilitaryLayerActive,
  isMilitaryLayerActive,
  onMilitaryLayerActiveChange,
} from './militaryRegistry.js';

test('active-change listener fires on transitions only, with committed state', () => {
  const seen = [];
  const unsub = onMilitaryLayerActiveChange((active) => {
    seen.push({ active, committed: isMilitaryLayerActive() });
  });
  try {
    setMilitaryLayerActive(false); // same value (initial false) → no fire
    assert.equal(seen.length, 0);

    setMilitaryLayerActive(true); // transition → fire, state already committed
    assert.deepEqual(seen, [{ active: true, committed: true }]);

    setMilitaryLayerActive(true); // same value → no fire
    assert.equal(seen.length, 1);

    setMilitaryLayerActive(false); // transition back → fire
    assert.deepEqual(seen[1], { active: false, committed: false });
    assert.equal(seen.length, 2);
  } finally {
    unsub();
    setMilitaryLayerActive(false);
  }
});

test('unsubscribe stops delivery; throwing listeners never break the toggle', () => {
  let calls = 0;
  const unsubBroken = onMilitaryLayerActiveChange(() => { throw new Error('boom'); });
  const unsubCounter = onMilitaryLayerActiveChange(() => { calls++; });
  try {
    setMilitaryLayerActive(true); // broken listener swallowed, counter still runs
    assert.equal(calls, 1);
    assert.equal(isMilitaryLayerActive(), true);

    unsubCounter();
    setMilitaryLayerActive(false);
    assert.equal(calls, 1); // unsubscribed → no more deliveries
  } finally {
    unsubBroken();
    unsubCounter();
    setMilitaryLayerActive(false);
  }
});

test('onMilitaryLayerActiveChange tolerates non-function listeners', () => {
  const unsub = onMilitaryLayerActiveChange(null);
  assert.equal(typeof unsub, 'function');
  unsub(); // no-op, must not throw
  setMilitaryLayerActive(true);
  assert.equal(isMilitaryLayerActive(), true);
  setMilitaryLayerActive(false);
});
