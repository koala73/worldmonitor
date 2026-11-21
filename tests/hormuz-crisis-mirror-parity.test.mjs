// Railway's nixpacks-root-scripts seeders package scripts/ only (#3811), so
// seeders import the scripts/shared mirror of shared/hormuz-crisis.js. The two
// must stay byte-identical or the seeders and the edge model date the
// pre-crisis window differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('scripts/shared/hormuz-crisis.js is a byte-identical mirror of shared/hormuz-crisis.js', () => {
  const canonical = readFileSync(new URL('../shared/hormuz-crisis.js', import.meta.url), 'utf8');
  const mirror = readFileSync(new URL('../scripts/shared/hormuz-crisis.js', import.meta.url), 'utf8');
  assert.equal(mirror, canonical);
});
