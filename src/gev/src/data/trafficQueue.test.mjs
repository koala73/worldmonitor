// src/data/trafficQueue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueDistances, queuePlatoons, locateAlongRoad } from './trafficQueue.js';

// ── queuePlatoons ───────────────────────────────────────────

test('queuePlatoons: groups positions into platoon arrays totalling count', () => {
  // rng always 0.5 → platoon size 6, anchor 500, gap 9 → 6-car then 4-car queue
  const platoons = queuePlatoons(1000, 10, () => 0.5);
  assert.deepEqual(platoons, [
    [500, 491, 482, 473, 464, 455],
    [500, 491, 482, 473],
  ]);
});

test('queuePlatoons: degenerate input yields no platoons', () => {
  assert.deepEqual(queuePlatoons(0, 10), []);
  assert.deepEqual(queuePlatoons(1000, 0), []);
});

// ── queueDistances ──────────────────────────────────────────

test('queueDistances: returns exactly count positions within [0, totalLen)', () => {
  const out = queueDistances(1000, 25);
  assert.equal(out.length, 25);
  for (const s of out) {
    assert.ok(s >= 0 && s < 1000, `position ${s} outside [0, 1000)`);
  }
});

test('queueDistances: platoon dots queue bumper-to-bumper behind the anchor', () => {
  // rng always 0.5 → platoonSize 4+floor(0.5*5)=6, anchor 500, gap 6+0.5*6=9
  const out = queueDistances(1000, 6, () => 0.5);
  assert.deepEqual(out, [500, 491, 482, 473, 464, 455]);
});

test('queueDistances: queue wraps around the road start', () => {
  // rng always 0 → platoonSize 4, anchor 0, gap 6 → trail wraps to road end
  const out = queueDistances(1000, 4, () => 0);
  assert.deepEqual(out, [0, 994, 988, 982]);
});

test('queueDistances: a platoon never exceeds the remaining count', () => {
  const out = queueDistances(1000, 3, () => 0.5); // platoonSize would be 6
  assert.equal(out.length, 3);
});

test('queueDistances: degenerate input yields no positions', () => {
  assert.deepEqual(queueDistances(0, 10), []);
  assert.deepEqual(queueDistances(-5, 10), []);
  assert.deepEqual(queueDistances(NaN, 10), []);
  assert.deepEqual(queueDistances(1000, 0), []);
});

// ── locateAlongRoad ─────────────────────────────────────────

test('locateAlongRoad: maps a distance to the containing segment + t', () => {
  const segs = [100, 50, 200];
  assert.deepEqual(locateAlongRoad(segs, 0), { segIdx: 0, t: 0 });
  assert.deepEqual(locateAlongRoad(segs, 50), { segIdx: 0, t: 0.5 });
  assert.deepEqual(locateAlongRoad(segs, 100), { segIdx: 0, t: 1 });
  assert.deepEqual(locateAlongRoad(segs, 125), { segIdx: 1, t: 0.5 });
  assert.deepEqual(locateAlongRoad(segs, 350), { segIdx: 2, t: 1 });
});

test('locateAlongRoad: clamps beyond-road distances to the road end', () => {
  assert.deepEqual(locateAlongRoad([100, 50], 999), { segIdx: 1, t: 1 });
});

test('locateAlongRoad: zero-length segments are skipped safely', () => {
  assert.deepEqual(locateAlongRoad([0, 100], 50), { segIdx: 1, t: 0.5 });
});
