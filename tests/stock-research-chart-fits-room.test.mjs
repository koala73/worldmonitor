import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The stock research overlay renders terminalChart() at a fixed width="640". On a
// 390px phone the room's content box is ~296px, so the SVG overflowed by ~344px and
// the room scrolled sideways (measured in Chromium against main.css). The chart has
// a viewBox, so capping its rendered width lets it scale down with its aspect ratio.
// Layout is not unit-testable here; the CSS cap is the checkable contract.

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const css = readFileSync(join(root, 'src', 'styles', 'main.css'), 'utf-8');
const overlayTs = readFileSync(join(root, 'src', 'features', 'stock-research', 'stock-research-overlay.ts'), 'utf-8');
const chartTs = readFileSync(join(root, 'src', 'utils', 'terminal-chart.ts'), 'utf-8');

function ruleBody(source, selectorRe) {
  const m = source.match(new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

function declarationValue(body, property) {
  const m = body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

describe('stock research chart fits its room on narrow screens', () => {
  it('the overlay still renders terminalChart into .stock-research-chart (guard is not dead)', () => {
    assert.match(overlayTs, /terminalChart\(/);
    assert.match(overlayTs, /class="stock-research-chart"/);
    assert.match(chartTs, /class="terminal-chart"/);
    assert.match(chartTs, /viewBox=/, 'scaling relies on the chart SVG keeping a viewBox');
  });

  it('caps the chart SVG at the container width and keeps its aspect ratio', () => {
    const body = ruleBody(css, '\\.stock-research-chart \\.terminal-chart');
    assert.ok(body, 'Expected a .stock-research-chart .terminal-chart rule in main.css');
    assert.equal(declarationValue(body, 'max-width'), '100%');
    assert.equal(declarationValue(body, 'height'), 'auto');
  });
});
