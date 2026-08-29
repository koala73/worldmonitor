import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
} from './cockpitUtilityLayout.js';

// 1512x790, the height the strip used to collide with the briefing card at.
const desktop = { viewportHeight: 790, stripHeight: 107, collapsedHeight: 50 };

test('the strip hangs 12px under the REC readout when the briefing card leaves room', () => {
  const { top } = resolveCockpitUtilityAnchor({ ...desktop, recBottom: 148.1, signalTop: 420 });
  assert.equal(Number(top.toFixed(1)), 160.1);
});

test('a tall briefing card pulls the strip up instead of being overlapped', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 148.1,
    signalTop: 265.4,
  });
  assert.equal(Number(top.toFixed(1)), 150.4);
  assert.equal(Number((265.4 - (top + desktop.stripHeight)).toFixed(1)), 8);
  assert.equal(Number(maxHeight.toFixed(1)), 107);
});

test('the strip never climbs into the topline, whatever the briefing card does', () => {
  const { top } = resolveCockpitUtilityAnchor({
    ...desktop,
    viewportHeight: 1400,
    recBottom: 200,
    signalTop: 150,
  });
  // minTop = max(96, 1400 * 0.12) = 168.
  assert.equal(top, 168);
});

test('the corridor is measured from the resolved top and floors on a launcher, not 120', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    viewportHeight: 700,
    recBottom: 148.1,
    signalTop: 140,
  });
  assert.equal(top, 96);
  // 140 - 96 - 8 = 36px of real corridor: report the launcher floor, never a
  // 120px fiction that let the strip run straight through the card.
  assert.equal(maxHeight, 50);
});

test('a missing REC readout leaves the strip on the viewport ceiling', () => {
  const { top } = resolveCockpitUtilityAnchor({ ...desktop, recBottom: 0, signalTop: 600 });
  assert.equal(top, 96);
});

test('keeps the collapsed sibling visible when both Cockpit utilities fit', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: 320,
    expandedHeight: 220,
    collapsedHeight: 50,
  }), {
    primaryOnly: false,
    expandedMaxHeight: 263,
  });
});

test('keeps the collapsed sibling at the exact corridor boundary', () => {
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 277,
    expandedHeight: 220,
    collapsedHeight: 50,
  }).primaryOnly, false);
});

test('gives the expanded panel the full corridor when both controls do not fit', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: 276,
    expandedHeight: 220,
    collapsedHeight: 50,
  }), {
    primaryOnly: true,
    expandedMaxHeight: 276,
  });
});

test('clamps malformed or short corridors to the minimum expanded height', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: Number.NaN,
    expandedHeight: 180,
    collapsedHeight: 50,
  }), {
    primaryOnly: true,
    expandedMaxHeight: 120,
  });
});

