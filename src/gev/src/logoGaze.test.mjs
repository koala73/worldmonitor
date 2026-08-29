import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateLogoGaze } from './logoGaze.js';

const rect = { left: 100, top: 50, width: 80, height: 40 };

test('logo gaze is neutral when the cursor is centered', () => {
  assert.deepEqual(calculateLogoGaze(140, 70, rect), { x: 0, y: 0 });
});

test('logo gaze follows direction and caps at the requested offset', () => {
  const gaze = calculateLogoGaze(1140, 70, rect, 28);
  assert.ok(Math.abs(gaze.x - 28) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze uses the more visible default travel', () => {
  const gaze = calculateLogoGaze(1140, 70, rect);
  assert.ok(Math.abs(gaze.x - 34) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze ramps proportionally inside the full-gaze distance', () => {
  const gaze = calculateLogoGaze(300, 70, rect, 28);
  assert.ok(Math.abs(gaze.x - 14) < 1e-9);
  assert.equal(gaze.y, 0);
});

test('logo gaze preserves diagonal direction while staying bounded', () => {
  const gaze = calculateLogoGaze(640, 570, rect, 28);
  assert.ok(Math.abs(Math.hypot(gaze.x, gaze.y) - 28) < 1e-9);
  assert.ok(gaze.x > 0);
  assert.ok(gaze.y > 0);
});

test('logo gaze fails closed for invalid geometry', () => {
  assert.deepEqual(calculateLogoGaze(10, 10, { ...rect, width: 0 }), { x: 0, y: 0 });
  assert.deepEqual(calculateLogoGaze(Number.NaN, 10, rect), { x: 0, y: 0 });
});
