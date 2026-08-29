// directionToHeading — two matching modes. The regression that motivated the
// split (adversarial field review, 2026-07-04): bare cardinal words were
// matched in free-form Austin camera names, so a street like "5TH ST / WEST
// AVE" was mis-read as a west-facing camera with false high confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionToHeading } from './directionText.js';

test('explicit travel forms resolve in BOTH modes (bound words + abbreviations)', () => {
  for (const allowBare of [false, true]) {
    assert.equal(directionToHeading('NORTHBOUND', allowBare), 0);
    assert.equal(directionToHeading('SB', allowBare), 180);
    assert.equal(directionToHeading('EASTBOUND lanes', allowBare), 90);
    assert.equal(directionToHeading('WB', allowBare), 270);
    assert.equal(directionToHeading('NORTHEAST', allowBare), 45);
    assert.equal(directionToHeading('SW', allowBare), 225);
  }
});

test('bare cardinal words resolve ONLY when allowBare (dedicated direction field)', () => {
  assert.equal(directionToHeading('West', true), 270);
  assert.equal(directionToHeading('North', true), 0);
  assert.equal(directionToHeading('South', true), 180);
  assert.equal(directionToHeading('East', true), 90);
  // Caltrans-style field with trailing text still extracts the bare cardinal.
  assert.equal(directionToHeading('West / SR-24', true), 270);
});

test('REGRESSION: bare cardinals in free-form names do NOT resolve (allowBare=false)', () => {
  // These are real Austin camera name shapes (live-sampled). Each contains a
  // cardinal word as part of a STREET NAME, not a facing direction — they must
  // return NaN so the camera falls back to low-confidence id-hash heading.
  assert.ok(Number.isNaN(directionToHeading('5TH ST / WEST AVE')), 'WEST AVE street name');
  assert.ok(Number.isNaN(directionToHeading('LAMAR BLVD / NORTH LOOP BLVD')), 'NORTH LOOP street name');
  assert.ok(Number.isNaN(directionToHeading('SOUTH CONGRESS AVE / RIVERSIDE')), 'SOUTH CONGRESS street name');
  assert.ok(Number.isNaN(directionToHeading('EAST 7TH ST / I-35')), 'EAST 7TH street name');
  // …but a name that genuinely carries a travel form still resolves.
  assert.equal(directionToHeading('IH-35 SOUTHBOUND AT 15TH'), 180);
});

test('compound words are not shadowed and word boundaries hold', () => {
  // "NORTH" must not match inside "NORTHBOUND" (returns via the bound branch)
  // nor inside "NORTHLAND" (no boundary → no match even with allowBare).
  assert.equal(directionToHeading('NORTHBOUND', true), 0);
  assert.ok(Number.isNaN(directionToHeading('NORTHLAND DR', true)), 'NORTHLAND is not NORTH');
  assert.ok(Number.isNaN(directionToHeading('EASTON PARK', true)), 'EASTON is not EAST');
});

test('empty / junk input returns NaN', () => {
  assert.ok(Number.isNaN(directionToHeading('')));
  assert.ok(Number.isNaN(directionToHeading(null)));
  assert.ok(Number.isNaN(directionToHeading('somewhere', true)));
});
