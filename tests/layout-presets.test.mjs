import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Read the layouts source to validate presets reference valid panel keys
const layoutsSrc = readFileSync(resolve(root, 'src/config/layouts.ts'), 'utf-8');
const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');

function extractPanelKeys(src, objectName) {
  const re = new RegExp(`const ${objectName}[^{]*\\{([\\s\\S]*?)\\n\\};`, 'm');
  const match = re.exec(src);
  if (!match) return [];
  const keys = [];
  // Match both quoted keys ('key': / "key":) and unquoted keys (key:)
  const keyRe = /(?:['"]([^'"]+)['"]|(\w[\w-]*))\s*:/g;
  let m;
  while ((m = keyRe.exec(match[1])) !== null) {
    const key = m[1] || m[2];
    // Skip object value keys like name, enabled, priority
    if (['name', 'enabled', 'priority'].includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

function extractLayoutPanelKeys(src, arrayName) {
  const re = new RegExp(`const ${arrayName}[^\\[]*\\[([\\s\\S]*?)\\n\\];`, 'm');
  const match = re.exec(src);
  if (!match) return [];
  const layouts = [];
  const presetRe = /panelKeys:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = presetRe.exec(match[1])) !== null) {
    const keys = m[1].match(/['"]([^'"]+)['"]/g)?.map(k => k.replace(/['"]/g, '')) || [];
    layouts.push(keys);
  }
  return layouts;
}

const fullPanelKeys = extractPanelKeys(panelsSrc, 'FULL_PANELS');
const techPanelKeys = extractPanelKeys(panelsSrc, 'TECH_PANELS');
const financePanelKeys = extractPanelKeys(panelsSrc, 'FINANCE_PANELS');
const happyPanelKeys = extractPanelKeys(panelsSrc, 'HAPPY_PANELS');

const fullLayouts = extractLayoutPanelKeys(layoutsSrc, 'FULL_LAYOUTS');
const techLayouts = extractLayoutPanelKeys(layoutsSrc, 'TECH_LAYOUTS');
const financeLayouts = extractLayoutPanelKeys(layoutsSrc, 'FINANCE_LAYOUTS');
const happyLayouts = extractLayoutPanelKeys(layoutsSrc, 'HAPPY_LAYOUTS');

describe('Layout presets reference valid panel keys', () => {
  it('FULL_LAYOUTS panels exist in FULL_PANELS', () => {
    for (const layout of fullLayouts) {
      for (const key of layout) {
        assert.ok(fullPanelKeys.includes(key), `Panel "${key}" in FULL_LAYOUTS not found in FULL_PANELS`);
      }
    }
  });

  it('TECH_LAYOUTS panels exist in TECH_PANELS', () => {
    for (const layout of techLayouts) {
      for (const key of layout) {
        assert.ok(techPanelKeys.includes(key), `Panel "${key}" in TECH_LAYOUTS not found in TECH_PANELS`);
      }
    }
  });

  it('FINANCE_LAYOUTS panels exist in FINANCE_PANELS', () => {
    for (const layout of financeLayouts) {
      for (const key of layout) {
        assert.ok(financePanelKeys.includes(key), `Panel "${key}" in FINANCE_LAYOUTS not found in FINANCE_PANELS`);
      }
    }
  });

  it('HAPPY_LAYOUTS panels exist in HAPPY_PANELS', () => {
    for (const layout of happyLayouts) {
      for (const key of layout) {
        assert.ok(happyPanelKeys.includes(key), `Panel "${key}" in HAPPY_LAYOUTS not found in HAPPY_PANELS`);
      }
    }
  });

  it('every layout includes the map panel', () => {
    for (const layouts of [fullLayouts, techLayouts, financeLayouts, happyLayouts]) {
      for (const layout of layouts) {
        assert.ok(layout.includes('map'), `Layout missing "map" panel: ${JSON.stringify(layout)}`);
      }
    }
  });

  it('no duplicate keys within a layout', () => {
    for (const layouts of [fullLayouts, techLayouts, financeLayouts, happyLayouts]) {
      for (const layout of layouts) {
        const unique = new Set(layout);
        assert.equal(unique.size, layout.length, `Duplicate keys in layout: ${JSON.stringify(layout)}`);
      }
    }
  });
});
