import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runCctvLayerEnableFocus,
  runCctvLayerEnableTransition,
} from './cctvFocusPolicy.js';

test('CCTV layer enable activates nearest without stealing a tracked or cockpit view', () => {
  for (const ownership of [
    { trackedEntity: { id: 'tracked-plane' }, cockpitActive: false },
    { trackedEntity: null, cockpitActive: true },
  ]) {
    const calls = [];
    const result = runCctvLayerEnableFocus({
      ...ownership,
      activate: () => {
        calls.push(['nearest', { focus: false }]);
        return 'cam-near';
      },
      fly: (cameraId) => {
        calls.push(['fly', cameraId]);
        return 'focused';
      },
    });

    assert.equal(result, 'cam-near');
    assert.deepEqual(calls, [['nearest', { focus: false }]]);
  }

  const calls = [];
  const result = runCctvLayerEnableFocus({
    activate: () => {
      calls.push(['nearest', { focus: false }]);
      return 'cam-near';
    },
    fly: (cameraId) => {
      calls.push(['fly', cameraId]);
      return 'focused';
    },
  });

  assert.equal(result, 'focused');
  assert.deepEqual(calls, [
    ['nearest', { focus: false }],
    ['fly', 'cam-near'],
  ]);
});

test('CCTV enable retains a pre-await tracking snapshot when tracking clears during enable', async () => {
  let trackedEntity = { id: 'tracked-plane' };
  let flyCalls = 0;
  const diagnostics = [];
  const result = await runCctvLayerEnableTransition({
    target: true,
    readOwnership: () => ({ trackedEntity, cockpitActive: false }),
    setEnabled: async () => {
      await Promise.resolve();
      trackedEntity = null;
    },
    shouldFocus: () => true,
    activate: () => 'cam-near',
    fly: () => {
      flyCalls += 1;
      return 'focused';
    },
    debug: (...args) => diagnostics.push(args),
  });

  assert.equal(result, 'cam-near');
  assert.equal(flyCalls, 0, 'a pre-await owner must suppress the post-await focus flight');
  assert.deepEqual(diagnostics.map(([, identity]) => identity.trackedId), ['tracked-plane', null]);
  assert.match(diagnostics[0][0], /before setEnabled await/);
  assert.match(diagnostics[1][0], /after setEnabled await/);

  const uiSource = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  assert.match(uiSource, /await runCctvLayerEnableTransition\(\{/);
});

test('CCTV disable transition does not emit enable-ownership diagnostics', async () => {
  const diagnostics = [];
  const transitions = [];

  const result = await runCctvLayerEnableTransition({
    target: false,
    readOwnership: () => ({ trackedEntity: { id: 'tracked-plane' }, cockpitActive: false }),
    setEnabled: async (target) => transitions.push(target),
    shouldFocus: () => true,
    activate: () => 'cam-near',
    fly: () => 'focused',
    debug: (...args) => diagnostics.push(args),
  });

  assert.equal(result, null);
  assert.deepEqual(transitions, [false]);
  assert.deepEqual(diagnostics, []);
});
