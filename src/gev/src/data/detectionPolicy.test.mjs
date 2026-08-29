import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AIRCRAFT_BRACKET_ALPHA_FLOOR,
  AIRCRAFT_BRACKET_FLOOR_ANCHOR,
  aircraftBracketAlphaFloor,
  canonicalizeDensity,
  defaultDensityForProfile,
  detectionBracketAlpha,
  detectionHorizontalSector,
  labelBudgetFor,
  migrateDetectionState,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
  viewScaleForAltitude,
} from './detectionPolicy.js';
import { KEYHOLE_OUTSIDE_OPACITY_DEFAULT } from '../celestialRing.js';

const indexHtml = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('side aircraft brackets stay readable without changing zero-opacity intent', () => {
  assert.equal(detectionBracketAlpha('AIR', 0), 0);
  assert.equal(detectionBracketAlpha('AIR', 0.05), AIRCRAFT_BRACKET_ALPHA_FLOOR);
  assert.equal(detectionBracketAlpha('AIR', 1), 1);
  assert.equal(detectionBracketAlpha('SAT', 0.05), 0.05);
});

test('the bracket floor anchor mirrors the real keyhole default it is calibrated to', () => {
  // detectionPolicy stays Cesium-free, so the anchor is a mirror. If the keyhole
  // default ever moves, this fails rather than silently shifting the shipped
  // look — the whole point of the anchor is that 0.35 lands AT the default.
  assert.equal(AIRCRAFT_BRACKET_FLOOR_ANCHOR, KEYHOLE_OUTSIDE_OPACITY_DEFAULT);
});

test('the default OUTSIDE setting reproduces the approved 0.35 floor exactly', () => {
  // Byte-identical at the default, at every keyhole alpha, with the setting
  // passed explicitly and with it omitted. This is the accepted look; only
  // the off-default range is allowed to change.
  assert.equal(aircraftBracketAlphaFloor(KEYHOLE_OUTSIDE_OPACITY_DEFAULT), AIRCRAFT_BRACKET_ALPHA_FLOOR);
  for (const alpha of [0.01, 0.05, 0.2, 0.34, 0.35, 0.36, 0.7, 1]) {
    assert.equal(
      detectionBracketAlpha('AIR', alpha, KEYHOLE_OUTSIDE_OPACITY_DEFAULT),
      Math.max(AIRCRAFT_BRACKET_ALPHA_FLOOR, alpha),
      `alpha ${alpha}: the default must reproduce the flat-0.35 result exactly`,
    );
    assert.equal(
      detectionBracketAlpha('AIR', alpha),
      detectionBracketAlpha('AIR', alpha, KEYHOLE_OUTSIDE_OPACITY_DEFAULT),
      `alpha ${alpha}: omitting the setting must mean the default, not zero`,
    );
  }
});

test('the OUTSIDE slider genuinely dims aircraft brackets below the default', () => {
  // The defect: a flat floor made every sub-default setting indistinguishable
  // from the default for AIR.
  assert.equal(aircraftBracketAlphaFloor(0), 0, 'off means off');
  assert.equal(detectionBracketAlpha('AIR', 0, 0), 0);
  // A third of the default paints a third of the floor — derived from the
  // constants rather than hardcoded, so moving the default moves this with it.
  const third = AIRCRAFT_BRACKET_FLOOR_ANCHOR / 3;
  assert.ok(
    Math.abs(aircraftBracketAlphaFloor(third) - AIRCRAFT_BRACKET_ALPHA_FLOOR / 3) < 1e-9,
    'a third of the default setting must paint a third of the floor, not all of it',
  );
  assert.ok(
    aircraftBracketAlphaFloor(third) < AIRCRAFT_BRACKET_ALPHA_FLOOR / 2,
    'and it must be visibly dim, not a rounding away from the floor',
  );
  assert.ok(
    aircraftBracketAlphaFloor(0.005) < aircraftBracketAlphaFloor(0.01),
    'every step below the default must visibly move',
  );
  // The old behaviour, stated as the thing that must NOT come back.
  assert.notEqual(aircraftBracketAlphaFloor(0.005), AIRCRAFT_BRACKET_ALPHA_FLOOR);
  assert.notEqual(aircraftBracketAlphaFloor(0.2), AIRCRAFT_BRACKET_ALPHA_FLOOR);
});

test('the range around the default is REACHABLE from the handle', () => {
  // The mapping above is continuous from 0, but the operator can only ask for
  // values the slider will stop on. At the shipped step of 5 the whole
  // sub-default range was one stop wide — 0 or 5, nothing between — so the low
  // stops were not settings anyone could choose. The control has to be able to
  // express what the policy can render, and the default itself now lives at 1 %.
  assert.match(
    indexHtml,
    /id="detection-opacity-slider"[^>]*\smin="0"[^>]*\smax="100"[^>]*\sstep="1"/,
    'index.html: the OUTSIDE slider steps by 1 so every integer percent is reachable',
  );

  // Each newly reachable stop is a distinct, ordered picture — otherwise
  // widening the control would just add handle positions that paint the same
  // thing.
  const reachable = [1, 2, 3, 4, 5].map((pct) => aircraftBracketAlphaFloor(pct / 100));
  for (let i = 1; i < reachable.length; i += 1) {
    assert.ok(
      reachable[i] > reachable[i - 1],
      `${i}% -> ${i + 1}%: each newly reachable stop must paint brighter than the last`,
    );
  }
  // The default lands on the approved floor exactly, wherever the default is.
  assert.equal(
    aircraftBracketAlphaFloor(AIRCRAFT_BRACKET_FLOOR_ANCHOR),
    AIRCRAFT_BRACKET_ALPHA_FLOOR,
    'the first-run setting still paints the approved bracket floor',
  );
  assert.equal(AIRCRAFT_BRACKET_FLOOR_ANCHOR, 0.01, 'and that setting is 1% (owner, 2026-08-24)');
});

test('the bracket floor is strictly increasing and stops overriding at full opacity', () => {
  const steps = Array.from({ length: 101 }, (_, i) => i / 100);
  let previous = -1;
  for (const outside of steps) {
    const floor = aircraftBracketAlphaFloor(outside);
    assert.ok(floor >= 0 && floor <= 1, `floor ${floor} out of range at ${outside}`);
    assert.ok(floor > previous, `floor must strictly increase; ${outside} gave ${floor} after ${previous}`);
    previous = floor;
  }
  // At full opacity the floor equals the label alpha, so the boost is gone —
  // there is no dead zone at the top of the slider either.
  assert.equal(aircraftBracketAlphaFloor(1), 1);
  assert.equal(detectionBracketAlpha('AIR', 1, 1), 1);
});

test('an unreadable OUTSIDE setting falls back to the approved default, never to blank', () => {
  for (const bad of [Number.NaN, undefined, 'x', Infinity]) {
    assert.equal(
      aircraftBracketAlphaFloor(bad),
      AIRCRAFT_BRACKET_ALPHA_FLOOR,
      `${String(bad)} must fail toward the shipped look`,
    );
  }
  assert.equal(aircraftBracketAlphaFloor(-5), 0);
  assert.equal(aircraftBracketAlphaFloor(5), 1);
});

test('the bracket floor never touches non-aircraft geometry at any setting', () => {
  for (const outside of [0, 0.05, 0.5, 1]) {
    assert.equal(detectionBracketAlpha('SAT', 0.05, outside), 0.05);
    assert.equal(detectionBracketAlpha('SEA', 0.2, outside), 0.2);
  }
});

test('aircraft coverage diagnostics use stable left/front/right thirds', () => {
  assert.equal(detectionHorizontalSector(100, 900), 'left');
  assert.equal(detectionHorizontalSector(450, 900), 'front');
  assert.equal(detectionHorizontalSector(800, 900), 'right');
});

test('density canonicalization respects profile thresholds and five stops', () => {
  assert.deepEqual(
    [-10, 0, 12.49, 12.5, 25, 26, 49, 74, 75, 87.49, 87.5, 100, 120]
      .map(canonicalizeDensity),
    [0, 0, 0, 25, 25, 50, 50, 50, 75, 75, 100, 100, 100],
  );
});

test('profiles are derived from canonical density', () => {
  assert.equal(profileForDensity(0), 'SPARSE');
  assert.equal(profileForDensity(25), 'SPARSE');
  assert.equal(profileForDensity(50), 'BALANCED');
  assert.equal(profileForDensity(75), 'DENSE');
  assert.equal(profileForDensity(100), 'DENSE');
  assert.equal(defaultDensityForProfile('survey'), 25);
  assert.equal(defaultDensityForProfile('normal'), 50);
  assert.equal(defaultDensityForProfile('panoptic'), 75);
  assert.equal(normalizeProfile('god'), 'DENSE');
});

test('allocation strategy defaults safely to Elastic', () => {
  assert.equal(normalizeAllocationStrategy('weighted'), 'WEIGHTED');
  assert.equal(normalizeAllocationStrategy('elastic'), 'ELASTIC');
  assert.equal(normalizeAllocationStrategy('unknown'), 'ELASTIC');
});

test('collective budgets follow view scale and canonical stop', () => {
  assert.equal(viewScaleForAltitude(1000), 'street');
  assert.equal(viewScaleForAltitude(2000), 'city');
  assert.equal(viewScaleForAltitude(10000), 'metro');
  assert.equal(viewScaleForAltitude(100000), 'regional');
  assert.equal(viewScaleForAltitude(1000000), 'global');
  assert.equal(labelBudgetFor(1000, 100), 90);
  assert.equal(labelBudgetFor(1e9, 100), 56);
  assert.equal(labelBudgetFor(1e9, 75), 42);
  assert.equal(labelBudgetFor(1e9, 28), 28);
});

test('legacy state migration removes contradictory mode/density pairs', () => {
  assert.deepEqual(migrateDetectionState('PANOPTIC', 0), {
    enabled: true, profile: 'DENSE', densityPct: 75,
  });
  assert.deepEqual(migrateDetectionState('SPARSE', 100), {
    enabled: true, profile: 'SPARSE', densityPct: 25,
  });
  assert.deepEqual(migrateDetectionState('BALANCED', 100), {
    enabled: true, profile: 'BALANCED', densityPct: 50,
  });
  assert.equal(migrateDetectionState('OFF', 25).enabled, false);
  assert.deepEqual(migrateDetectionState('OFF', 25, 50), {
    enabled: false, profile: 'SPARSE', densityPct: 25,
  });
});
