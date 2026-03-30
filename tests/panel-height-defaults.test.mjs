import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelSrc = readFileSync(resolve(root, 'src/components/Panel.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const mainCssSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

test('info panels default to two rows while the separate map section stays outside the grid', () => {
  assert.match(
    panelLayoutSrc,
    /buildMapSection\(\)\}\s*<div class="panels-grid" id="panelsGrid"><\/div>/,
    'the main map should stay outside the info-panel grid so panel height changes do not affect it',
  );
  assert.match(
    panelSrc,
    /function getDefaultRowSpan\(\): number\s*\{[\s\S]*return 2;[\s\S]*\}/,
    'normal info panels should treat two rows as the default height',
  );
  assert.match(
    panelSrc,
    /const naturalSpan = getDefaultRowSpan\(\);/,
    'saved panel heights should compare against the new natural two-row default',
  );
  assert.doesNotMatch(
    panelSrc,
    /savedSpan && savedSpan > 1/,
    'saved span-1 overrides must still restore when the default becomes two rows',
  );
  assert.match(
    mainCssSrc,
    /\.panels-grid\s*>\s*\.panel:not\(\.span-1\):not\(\.span-2\):not\(\.span-3\):not\(\.span-4\):not\(\.panel-wide\)\s*\{[\s\S]*grid-row:\s*span 2[\s\S]*min-height:\s*400px[\s\S]*\}/,
    'unresized info panels should render at double height by default without affecting wide/video tiles',
  );
});
