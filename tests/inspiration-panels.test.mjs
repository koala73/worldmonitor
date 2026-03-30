import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
const panelLayoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8');
const componentsIndexSrc = readFileSync(resolve(root, 'src/components/index.ts'), 'utf8');
const inspirationPanelSrc = readFileSync(resolve(root, 'src/components/InspirationQuotePanel.ts'), 'utf8');
const inspirationQuotesSrc = readFileSync(resolve(root, 'src/config/inspiration-quotes.ts'), 'utf8');
const mainCssSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

test('inspiration quote panels are wired into the full variant with substantial rotations', () => {
  for (const panelId of ['stoic-reflections', 'biblical-encouragement']) {
    assert.match(
      panelsSrc,
      new RegExp(`['"]${panelId}['"]\\s*:\\s*\\{[^}]*enabled:\\s*true`, 's'),
      `full variant should register ${panelId}`,
    );
    assert.match(
      panelsSrc,
      new RegExp(`panelKeys:\\s*\\[[^\\]]*['"]${panelId}['"]`, 's'),
      `${panelId} should be discoverable from a sidebar category`,
    );
  }

  assert.match(panelLayoutSrc, /new StoicQuotePanel\(\)/);
  assert.match(panelLayoutSrc, /new BiblicalQuotePanel\(\)/);
  assert.match(panelLayoutSrc, /this\.ctx\.panels\[['"]stoic-reflections['"]\]\s*=/);
  assert.match(panelLayoutSrc, /this\.ctx\.panels\[['"]biblical-encouragement['"]\]\s*=/);

  assert.match(componentsIndexSrc, /InspirationQuotePanel/);
  assert.match(inspirationPanelSrc, /class StoicQuotePanel extends InspirationQuotePanel/);
  assert.match(inspirationPanelSrc, /class BiblicalQuotePanel extends InspirationQuotePanel/);
  assert.match(inspirationPanelSrc, /window\.setInterval\(/);
  assert.match(inspirationPanelSrc, /data-action="shuffle"/);

  assert.ok(
    (inspirationQuotesSrc.match(/id:\s*'stoic-/g) ?? []).length >= 12,
    'stoic rotation should ship with a meaningful curated list',
  );
  assert.ok(
    (inspirationQuotesSrc.match(/id:\s*'bible-/g) ?? []).length >= 16,
    'biblical rotation should ship with a meaningful curated list',
  );
  assert.match(inspirationQuotesSrc, /translation:\s*'KJV'/);

  assert.match(mainCssSrc, /\.wisdom-panel-card/);
  assert.match(mainCssSrc, /\.wisdom-panel--stoic/);
  assert.match(mainCssSrc, /\.wisdom-panel--biblical/);
});
