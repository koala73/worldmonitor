import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(join(root, 'src', 'app', 'event-handlers.ts'), 'utf-8');

describe('map fullscreen resize sync', () => {
  it('defines a shared layout-sync helper that calls resize()', () => {
    assert.match(src, /private syncMapAfterLayoutChange\(delayMs = 320\): void \{/);
    assert.match(src, /this\.ctx\.map\?\.resize\(\)/);
    assert.match(src, /requestAnimationFrame\(sync\)/);
    assert.match(src, /window\.setTimeout\(sync, delayMs\)/);
  });

  it('re-syncs the map after browser fullscreen changes', () => {
    const fullscreenHandlerBlock = src.match(/this\.boundFullscreenHandler = \(\) => \{([\s\S]*?)\n\s*\};/);
    assert.ok(fullscreenHandlerBlock, 'Expected fullscreenchange handler block');
    assert.match(fullscreenHandlerBlock[1], /this\.syncMapAfterLayoutChange\(\)/);
  });

  it('re-syncs the map after map-panel fullscreen toggles', () => {
    const mapFullscreenBlock = src.match(/setupMapFullscreen[\s\S]*?const toggle = \(\) => \{([\s\S]*?)\n\s*\};/);
    assert.ok(mapFullscreenBlock, 'Expected map fullscreen toggle block inside setupMapFullscreen');
    assert.match(mapFullscreenBlock[1], /this\.syncMapAfterLayoutChange\(\)/);
  });
});
