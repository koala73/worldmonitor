// Unit tests for the pure drawing/format helpers behind the detection overlay.
// These are renderer-agnostic (no Cesium, no DOM) so they pin the Phase-1 label
// + batching behavior and carry straight into the Phase-2 GPU renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFlightLevel,
  formatKnots,
  monoTextWidth,
  composeLabel,
  acquireAlpha,
  appendCornerBracket,
  resolveTier,
  measureLabelCard,
  measureTrackLabel,
  nearFarScale,
  rectIntersectsAny,
} from './detectionDraw.js';

test('formatFlightLevel converts metres to a 3-digit flight level', () => {
  assert.equal(formatFlightLevel(10363), 'FL340'); // 34,000 ft
  assert.equal(formatFlightLevel(1524), 'FL050');  // 5,000 ft, zero-padded
});

test('formatFlightLevel returns empty string for missing/zero/negative altitude', () => {
  assert.equal(formatFlightLevel(0), '');
  assert.equal(formatFlightLevel(-50), '');
  assert.equal(formatFlightLevel(null), '');
  assert.equal(formatFlightLevel(undefined), '');
  assert.equal(formatFlightLevel(NaN), '');
});

test('formatKnots rounds and suffixes; omits non-positive/non-finite', () => {
  assert.equal(formatKnots(14), '14 kn');
  assert.equal(formatKnots(14.6), '15 kn');
  assert.equal(formatKnots(0), '');
  assert.equal(formatKnots(null), '');
  assert.equal(formatKnots(NaN), '');
});

test('monoTextWidth multiplies length by advance, 0 for empty', () => {
  assert.equal(monoTextWidth('ABCD', 6), 24);
  assert.equal(monoTextWidth('', 6), 0);
  assert.equal(monoTextWidth(null, 6), 0);
});

test('composeLabel: id only -> empty secondary (degrades to today)', () => {
  assert.deepEqual(composeLabel({ id: 'VEH-0001' }), { primary: 'VEH-0001', secondary: '' });
});

test('composeLabel: id + metric -> secondary is the metric', () => {
  assert.deepEqual(composeLabel({ id: 'UAL2476', metric: 'FL340' }), {
    primary: 'UAL2476',
    secondary: 'FL340',
  });
});

test('composeLabel: id + class + metric -> class · metric secondary', () => {
  assert.deepEqual(composeLabel({ id: 'VIPER11', klass: 'MIL', metric: 'FL280' }), {
    primary: 'VIPER11',
    secondary: 'MIL · FL280',
  });
});

test('composeLabel truncates an over-long primary and is defensive about empties', () => {
  assert.equal(composeLabel({ id: 'SUPERLONGVESSELNAME12345' }).primary, 'SUPERLONGVESSELNAM'); // 18
  assert.deepEqual(composeLabel({}), { primary: '', secondary: '' });
});

test('acquireAlpha ramps 0->1 across the fade window', () => {
  assert.equal(acquireAlpha(1000, 1000, 200), 0);
  assert.equal(acquireAlpha(1000, 1100, 200), 0.5);
  assert.equal(acquireAlpha(1000, 1300, 200), 1);
});

test('acquireAlpha clamps and defaults safely', () => {
  assert.equal(acquireAlpha(1000, 900, 200), 0);   // before first-seen
  assert.equal(acquireAlpha(1000, 5000, 200), 1);  // long after
  assert.equal(acquireAlpha(NaN, 5000, 200), 1);   // no timestamp -> visible
  assert.equal(acquireAlpha(1000, 1100, 0), 1);    // no fade -> visible
});

test('appendCornerBracket emits 4 L-shaped corners (4 moveTo + 8 lineTo)', () => {
  const calls = [];
  const sink = {
    moveTo: (x, y) => calls.push(['m', x, y]),
    lineTo: (x, y) => calls.push(['l', x, y]),
  };
  appendCornerBracket(sink, 100, 100, 20, 10);

  assert.equal(calls.length, 12);
  assert.equal(calls.filter((c) => c[0] === 'm').length, 4);
  assert.equal(calls.filter((c) => c[0] === 'l').length, 8);
  // top-left corner of box (x0=80, y0=90), seg = max(4, floor(10*0.55)) = 5
  assert.deepEqual(calls.slice(0, 3), [
    ['m', 80, 95],
    ['l', 80, 90],
    ['l', 85, 90],
  ]);
});

test('resolveTier maps type to a threat tier, with explicit override winning', () => {
  assert.equal(resolveTier({ type: 'AIR' }), 'civil');
  assert.equal(resolveTier({ type: 'AIR', tier: 'military' }), 'military'); // layer-supplied override
  assert.equal(resolveTier({ type: 'SEA' }), 'sea');
  assert.equal(resolveTier({ type: 'SAT' }), 'space');
  assert.equal(resolveTier({ type: 'VEH' }), 'vehicle');
  assert.equal(resolveTier({}), 'civil');
  assert.equal(resolveTier(null), 'civil');
  // Live-traffic congestion tiers ride the same override: keyless VEH
  // contacts carry no tier and keep the stock 'vehicle' color.
  assert.equal(resolveTier({ type: 'VEH', tier: 'veh_jam' }), 'veh_jam');
  assert.equal(resolveTier({ type: 'VEH', tier: 'veh_nodata' }), 'veh_nodata');
});

test('measureLabelCard sizes a two-line card so the second line never clips', () => {
  const card = measureLabelCard('UAL2476', 'B738 · FL340', 6);
  // bottom of the last baseline + descender must fit inside the card height
  assert.ok(card.subBase + 3 <= card.h, `subBase+desc ${card.subBase + 3} must fit in h ${card.h}`);
  assert.ok(card.idBase < card.subBase, 'id line sits above sub line');
  assert.ok(card.w >= 12 * 6, 'width covers the wider (sub) text');
  assert.equal(card.hasSec, true);
});

test('measureLabelCard collapses to a single line when there is no secondary', () => {
  const card = measureLabelCard('VEH-0001', '', 6);
  assert.equal(card.hasSec, false);
  assert.equal(card.subBase, 0);
  assert.ok(card.idBase + 3 <= card.h, 'single line + descender fits');
  const two = measureLabelCard('VEH-0001', 'VEH · 38mph', 6);
  assert.ok(two.h > card.h, 'two-line card is taller than one-line');
});

test('measureTrackLabel lays out callsign + altitude on one line', () => {
  const c = measureTrackLabel('WOLF21', '270', 6);
  assert.equal(c.hasMicro, true);
  assert.ok(c.microX > c.primaryX, 'altitude sits to the right of the callsign');
  assert.ok(c.baseline + 3 <= c.h, 'single line + descender fits inside height');
  assert.ok(c.w >= 6 * 6, 'width covers the callsign');
});

test('measureTrackLabel handles a missing altitude (callsign only)', () => {
  const c = measureTrackLabel('SAT-12345', '', 6);
  assert.equal(c.hasMicro, false);
  assert.ok(c.w >= 9 * 6, 'width covers the longer callsign');
});

test('callout cards avoid live HUD rectangles without rejecting edge-adjacent space', () => {
  const hud = [{ x: 100, y: 100, w: 80, h: 60 }];
  assert.equal(rectIntersectsAny({ x: 120, y: 80, w: 40, h: 40 }, hud), true);
  assert.equal(rectIntersectsAny({ x: 60, y: 100, w: 40, h: 20 }, hud), false);
  assert.equal(rectIntersectsAny({ x: 60, y: 100, w: 40, h: 20 }, hud, 1), true);
});

test('nearFarScale interpolates by distance and clamps to the near/far values', () => {
  // mirrors Cesium NearFarScalar(1000, 3.0, 8000000, 0.5) used by the flight billboards
  assert.equal(nearFarScale(1000, 1000, 3.0, 8000000, 0.5), 3.0);
  assert.equal(nearFarScale(8000000, 1000, 3.0, 8000000, 0.5), 0.5);
  assert.equal(nearFarScale(500, 1000, 3.0, 8000000, 0.5), 3.0);   // below near -> clamp
  assert.equal(nearFarScale(9e6, 1000, 3.0, 8000000, 0.5), 0.5);   // beyond far -> clamp
  const mid = nearFarScale((1000 + 8000000) / 2, 1000, 3.0, 8000000, 0.5);
  assert.ok(Math.abs(mid - 1.75) < 1e-6, `midpoint ~1.75, got ${mid}`);
});
