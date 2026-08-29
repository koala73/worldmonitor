import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accentForSeverity,
  FIRMS_AMBIENT_COHORT_LIMIT,
  FIRMS_OVERLAY_SOURCE_ID,
  satelliteShortName,
} from './firmsLabels.js';

test('FIRMS formatting helpers retain the shipped severity palette', () => {
  assert.equal(accentForSeverity('red'), '224, 82, 82');
  assert.equal(accentForSeverity('orange'), '240, 178, 62');
  assert.equal(accentForSeverity('yellow'), '244, 227, 108');
  assert.equal(accentForSeverity('chartreuse'), accentForSeverity('yellow'));
});

test('FIRMS satellite names retain the three VIIRS abbreviations', () => {
  assert.equal(satelliteShortName('N20'), 'N20');
  assert.equal(satelliteShortName('N21'), 'N21');
  assert.equal(satelliteShortName('N'), 'SNPP');
  assert.equal(satelliteShortName('TERRA-X9'), 'TERRA-');
  assert.equal(satelliteShortName(''), '');
});

test('FIRMS host registration constants pin the shipped source budget', () => {
  assert.equal(FIRMS_OVERLAY_SOURCE_ID, 'firms');
  assert.equal(FIRMS_AMBIENT_COHORT_LIMIT, 18);
});

test('FIRMS helper module cannot resurrect a dedicated canvas renderer', () => {
  const source = readFileSync(new URL('./firmsLabels.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createElement\(['"]canvas['"]\)/);
  assert.doesNotMatch(source, /postRender/);
  assert.doesNotMatch(source, /worldToWindowCoordinates/);
});
