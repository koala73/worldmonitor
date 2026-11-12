// The layer search command and its handler both require the layer key to exist in the
// workspace's mapLayers. A layer missing from a variant's defaults is therefore hidden from
// search on a fresh workspace until the user toggles it some other way. The variant modules
// read import.meta.env, so the defaults are read from source like the other layer-default tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function block(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}: MapLayers = {`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `${name} not closed`);
  return source.slice(start, end);
}

describe('Water Levels layer defaults', () => {
  for (const variant of ['full', 'energy']) {
    const source = readFileSync(new URL(`../src/config/variants/${variant}.ts`, import.meta.url), 'utf8');
    for (const name of ['DEFAULT_MAP_LAYERS', 'MOBILE_DEFAULT_MAP_LAYERS']) {
      it(`${variant} ${name} defines reservoirLevels, off`, () => {
        assert.match(block(source, name), /^\s*reservoirLevels:\s*false,/m);
      });
    }
  }
});
