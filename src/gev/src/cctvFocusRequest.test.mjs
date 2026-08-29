import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CCTV_WORLD_CLICK_FOCUS_DURATION_SEC,
  CCTV_FOCUS_REQUEST_EVENT,
  registerCctvFocusRequestListener,
  routeCctvFocusRequest,
} from './cctvFocusRequest.js';

test('UI CCTV request route uses the explicit focus policy with the clicked id', () => {
  const calls = [];
  const result = routeCctvFocusRequest(
    { detail: { cameraId: 'oak-cam-9' } },
    (activate, focus) => {
      calls.push('explicit-policy');
      return focus(activate());
    },
    (cameraId, durationSec) => {
      calls.push({ cameraId, durationSec });
      return 'focused';
    },
  );

  assert.equal(result, 'focused');
  assert.deepEqual(calls, [
    'explicit-policy',
    { cameraId: 'oak-cam-9', durationSec: CCTV_WORLD_CLICK_FOCUS_DURATION_SEC },
  ]);
  assert.equal(CCTV_WORLD_CLICK_FOCUS_DURATION_SEC, 1.9);
});

test('UI CCTV request route rejects malformed events without entering focus policy', () => {
  let calls = 0;
  assert.equal(routeCctvFocusRequest({}, () => { calls += 1; }, () => {}), false);
  assert.equal(routeCctvFocusRequest({ detail: { cameraId: '' } }, () => { calls += 1; }, () => {}), false);
  assert.equal(calls, 0);
});

test('UI CCTV focus listener registration disposes the exact added callback once', () => {
  const added = [];
  const removed = [];
  const target = {
    addEventListener(type, callback) { added.push({ type, callback }); },
    removeEventListener(type, callback) { removed.push({ type, callback }); },
  };
  const listener = () => {};

  const dispose = registerCctvFocusRequestListener(target, listener);
  dispose();
  dispose();

  assert.equal(added.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(added[0].type, CCTV_FOCUS_REQUEST_EVENT);
  assert.equal(removed[0].type, CCTV_FOCUS_REQUEST_EVENT);
  assert.strictEqual(added[0].callback, listener);
  assert.strictEqual(removed[0].callback, added[0].callback);

  const uiSource = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  assert.match(
    uiSource,
    /_removeCctvRequestFocusListener = registerCctvFocusRequestListener\([\s\S]+this\._cctvRequestFocusHandler/,
  );
  assert.match(uiSource, /this\._removeCctvRequestFocusListener\?\.\(\)/);
});
