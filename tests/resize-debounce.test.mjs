import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(join(root, 'src', 'app', 'panel-layout.ts'), 'utf-8');

describe('resize handler debounce + cleanup', () => {
  it('stores a debounced resize handler as a class property', () => {
    // The debounced handler must be stored as a named class property so it can be
    // properly removed on destroy (inline arrow fn in addEventListener = orphan reference).
    assert.match(src, /private\s+readonly\s+debouncedEnsureZones:/);
  });

  it('initializes the debounced handler in the constructor', () => {
    // Must initialize the debounced handler with debounce() and a delay.
    assert.match(src, /this\.debouncedEnsureZones\s*=\s*debounce\(\(\)\s*=>\s*\{[\s\S]*?this\.ensureCorrectZones\(\)[\s\S]*?,\s*\d+\)/);
  });

  it('adds the stored (debounced) handler, not an inline arrow', () => {
    // Must NOT have an inline arrow fn for the resize listener.
    // The removeEventListener call would fail to remove an inline arrow fn.
    const addResizeLine = src.match(/window\.addEventListener\s*\(\s*['"]resize['"]\s*,\s*([^\)]+)\s*\)/);
    assert.ok(addResizeLine, 'Expected addEventListener for resize');
    // The captured arg must be a property reference, not an arrow function
    assert.match(addResizeLine[1], /this\.debouncedEnsureZones/);
    assert.ok(!addResizeLine[1].includes('=>'), 'addEventListener must not use inline arrow fn');
  });

  it('removes the same handler reference on destroy', () => {
    // removeEventListener must use the same stored property reference.
    const removeLine = src.match(/window\.removeEventListener\s*\(\s*['"]resize['"]\s*,\s*([^\)]+)\s*\)/);
    assert.ok(removeLine, 'Expected removeEventListener for resize');
    assert.match(removeLine[1], /this\.debouncedEnsureZones/);
  });
});