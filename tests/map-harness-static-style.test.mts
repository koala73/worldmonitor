import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

test('visual map harness uses a tile-free style only behind its explicit test marker', () => {
  const harnessHtml = read('tests/map-harness.html');
  const renderer = read('src/components/DeckGLMap.ts');

  assert.match(harnessHtml, /__WM_E2E_MAP_HARNESS__\s*=\s*true/);
  assert.match(renderer, /const MAP_HARNESS_STYLE: StyleSpecification = \{[\s\S]*?sources: \{\},[\s\S]*?layers: \[\]/);
  assert.match(renderer, /if \(isMapHarnessRuntime\) \{\s*return \{ mapTheme: 'dark', style: MAP_HARNESS_STYLE \};/);
  assert.match(renderer, /No production route sets this flag/);
});
