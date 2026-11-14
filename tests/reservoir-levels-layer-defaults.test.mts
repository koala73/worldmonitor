import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function block(source: string, name: string): string {
  const start = source.indexOf(`const ${name}: MapLayers = {`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, `${name} not closed`);
  return source.slice(start, end);
}

describe('Water Levels layer defaults', () => {
  const source = readFileSync(new URL('../src/config/panels.ts', import.meta.url), 'utf8');
  for (const name of ['FULL_MAP_LAYERS', 'FULL_MOBILE_MAP_LAYERS', 'ENERGY_MAP_LAYERS', 'ENERGY_MOBILE_MAP_LAYERS']) {
    it(`${name} defines reservoirLevels, off`, () => {
      assert.match(block(source, name), /^\s*reservoirLevels:\s*false,/m);
    });
  }
});
