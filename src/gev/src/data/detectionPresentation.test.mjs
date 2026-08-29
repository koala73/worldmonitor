import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COCKPIT_BRACKET_OPACITY,
  detectionBracketOpacity,
} from './detectionPresentation.js';

test('Cockpit reduces only the bracket presentation multiplier', () => {
  assert.equal(COCKPIT_BRACKET_OPACITY, 0.45);
  assert.equal(detectionBracketOpacity(true), 0.45);
  assert.equal(detectionBracketOpacity(false), 1);
  assert.equal(detectionBracketOpacity(undefined), 1);
});

test('detection owns and releases the Cockpit lifecycle listener', async () => {
  const source = await readFile(new URL('./detection.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('gev:cockpit-mode-changed', _cockpitModeListener\)/);
  assert.match(source, /removeEventListener\('gev:cockpit-mode-changed', _cockpitModeListener\)/);
  assert.match(
    source,
    /fade \* entry\.alpha \* bracketPresentationOpacity/,
    'Cockpit opacity must multiply bracket strokes only',
  );
  assert.doesNotMatch(
    source,
    /_drawCallout\(entry, fade \* bracketPresentationOpacity/,
    'Cockpit bracket de-emphasis must not dim callouts',
  );
});

