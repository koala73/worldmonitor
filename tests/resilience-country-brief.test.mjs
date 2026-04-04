import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(new URL('../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles/country-deep-dive.css', import.meta.url), 'utf8');

test('country deep-dive panel wires the resilience widget into the summary area', () => {
  assert.match(panelSource, /import\s+\{\s*ResilienceWidget\s*\}\s+from '\.\/ResilienceWidget';/);
  assert.match(panelSource, /private resilienceWidget: ResilienceWidget \| null = null;/);
  assert.match(panelSource, /this\.resilienceWidget = new ResilienceWidget\(code\);/);
  assert.match(panelSource, /const summaryGrid = this\.el\('div', 'cdp-summary-grid'\);/);
  assert.match(panelSource, /summaryGrid\.append\(scoreCard, this\.resilienceWidget\.getElement\(\)\);/);
});

test('country deep-dive panel destroys the resilience widget before replacing panel state', () => {
  const destroyCallCount = (panelSource.match(/this\.destroyResilienceWidget\(\);/g) ?? []).length;
  assert.ok(destroyCallCount >= 5, `expected destroyResilienceWidget to be called in lifecycle transitions, got ${destroyCallCount}`);
  assert.match(panelSource, /private destroyResilienceWidget\(\): void \{\s*this\.resilienceWidget\?\.destroy\(\);\s*this\.resilienceWidget = null;\s*\}/s);
});

test('country deep-dive styles provide a responsive summary grid for CII and resilience', () => {
  assert.match(styleSource, /\.cdp-summary-grid\s*\{\s*display:\s*grid;/);
  assert.match(styleSource, /\.cdp-summary-grid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
  assert.match(styleSource, /\.country-deep-dive\.maximized \.cdp-summary-grid\s*\{[\s\S]*grid-template-columns:\s*1fr 1fr;/);
});
