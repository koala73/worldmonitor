import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostContextFromInitialize, layoutFlags, mergeHostContext } from '../src/plugin-host-context.ts';

test('an initialize result without hostContext is inline with every layout flag off', () => {
  const state = hostContextFromInitialize({ hostCapabilities: {} });
  assert.equal(state.displayMode, 'inline');
  assert.deepEqual(state.availableDisplayModes, []);
  assert.deepEqual(layoutFlags(state), { canExpand: false, fillContainer: false });
  assert.deepEqual(layoutFlags(hostContextFromInitialize(undefined)), { canExpand: false, fillContainer: false });
});

test('a host that offers fullscreen while inline can expand', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
  assert.equal(layoutFlags(state).canExpand, true);
  const inlineOnly = hostContextFromInitialize({ hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] } });
  assert.equal(layoutFlags(inlineOnly).canExpand, false);
});

test('fullscreen at 380 by 700 fills the container', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: 380, height: 700 } } });
  assert.deepEqual(layoutFlags(state), { canExpand: false, fillContainer: true });
  assert.deepEqual(state.containerDimensions, { width: 380, height: 700 });
});

test('fullscreen with a zero height does not fill the container', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'fullscreen', containerDimensions: { width: 700, height: 0 } } });
  assert.equal(layoutFlags(state).fillContainer, false);
});

test('inline with a maximum height does not fill the container', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'inline', containerDimensions: { width: 700, maxHeight: 900 } } });
  assert.equal(layoutFlags(state).fillContainer, false);
});

test('fullscreen without a numeric height does not fill the container', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'fullscreen', containerDimensions: { width: 700, maxHeight: 900 } } });
  assert.equal(layoutFlags(state).fillContainer, false);
});

test('a partial update carrying only theme keeps the previous dimensions and mode', () => {
  const state = hostContextFromInitialize({ hostContext: { theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: 1200, height: 800 } } });
  const next = mergeHostContext(state, { theme: 'light' });
  assert.equal(next.theme, 'light');
  assert.equal(next.displayMode, 'fullscreen');
  assert.deepEqual(next.containerDimensions, { width: 1200, height: 800 });
  assert.deepEqual(next.availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal(state.theme, 'dark', 'merging does not mutate the previous state');
});

test('only updates that supply displayMode advance the display-mode revision', () => {
  const state = hostContextFromInitialize({ hostContext: { displayMode: 'inline' } });
  assert.equal(mergeHostContext(state, { theme: 'light', containerDimensions: { width: 500, height: 600 } }).displayModeRevision, state.displayModeRevision);
  assert.equal(mergeHostContext(state, { displayMode: 'inline' }).displayModeRevision, state.displayModeRevision + 1);
});

test('updates are accepted both flat and wrapped in hostContext', () => {
  const state = hostContextFromInitialize({ hostContext: { availableDisplayModes: ['inline', 'fullscreen'] } });
  assert.equal(mergeHostContext(state, { displayMode: 'fullscreen' }).displayMode, 'fullscreen');
  assert.equal(mergeHostContext(state, { hostContext: { displayMode: 'fullscreen' } }).displayMode, 'fullscreen');
});

test('fields of the wrong type are ignored instead of throwing', () => {
  const state = hostContextFromInitialize({ hostContext: { theme: 'sepia', displayMode: 'pip', availableDisplayModes: 'fullscreen', containerDimensions: 'wide', safeAreaInsets: { top: '4' } } });
  assert.equal(state.theme, undefined);
  assert.equal(state.displayMode, 'inline');
  assert.deepEqual(state.availableDisplayModes, []);
  assert.equal(state.containerDimensions, undefined);
  assert.equal(state.safeAreaInsets, undefined);
  const kept = hostContextFromInitialize({ hostContext: { containerDimensions: { width: 500, height: Number.NaN }, safeAreaInsets: { top: 4, left: -1, bottom: 'x' }, availableDisplayModes: ['fullscreen', 7] } });
  assert.deepEqual(kept.containerDimensions, { width: 500 });
  assert.deepEqual(kept.safeAreaInsets, { top: 4 });
  assert.deepEqual(kept.availableDisplayModes, ['fullscreen']);
  assert.deepEqual(mergeHostContext(kept, null), kept);
});
