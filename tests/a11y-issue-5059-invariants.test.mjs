import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const settings = read('src', 'components', 'UnifiedSettings.ts');
const css = read('src', 'styles', 'main.css');

describe('panel toggles are real buttons', () => {
  it('panel-toggle-item renders as a button', () => {
    assert.match(settings, /<button\b[^>]*class="panel-toggle-item/);
    assert.doesNotMatch(settings, /<div\b[^>]*class="panel-toggle-item/);
  });

  it('source-toggle-item renders as a button', () => {
    assert.match(settings, /<button\b[^>]*class="source-toggle-item/);
    assert.doesNotMatch(settings, /<div\b[^>]*class="source-toggle-item/);
  });

  it('panel-toggle-item has type="button"', () => {
    assert.match(settings, /<button\b[^>]*type="button"[^>]*class="panel-toggle-item/);
  });

  it('source-toggle-item has type="button"', () => {
    assert.match(settings, /<button\b[^>]*type="button"[^>]*class="source-toggle-item/);
  });

  it('panel-toggle-item has aria-pressed', () => {
    assert.match(settings, /class="panel-toggle-item[\s\S]*?aria-pressed=/);
  });

  it('source-toggle-item has aria-pressed', () => {
    assert.match(settings, /class="source-toggle-item[\s\S]*?aria-pressed=/);
  });

  it('no aria-pressed remains on a non-button element', () => {
    assert.doesNotMatch(settings, /<div\b[^>]*aria-pressed=/);
  });
});

describe('keyboard — roving tablist', () => {
  it('switchTab updates tabindex on tab switch', () => {
    assert.match(settings, /setAttribute\('tabindex',\s*isActive\s*\?\s*'0'\s*:\s*'-1'\)/);
  });
});

describe('CSS — focus-visible indicator for toggle items', () => {
  it('.panel-toggle-item:focus-visible rule exists', () => {
    assert.match(css, /\.panel-toggle-item:focus-visible\s*[,\{]/);
  });

  it('.source-toggle-item:focus-visible rule exists', () => {
    assert.match(css, /\.source-toggle-item:focus-visible\s*[,\{]/);
  });

  it('toggle focus-visible uses a high-contrast color', () => {
    const block = css.match(/\.panel-toggle-item:focus-visible[\s\S]*?\{([\s\S]*?)\}/);
    assert.ok(block, 'panel-toggle-item:focus-visible block must exist');
    assert.match(block[1], /--text/, 'toggle focus ring should use --text for visibility');
  });

  it('toggle focus-visible has a visible outline width', () => {
    const block = css.match(/\.panel-toggle-item:focus-visible[\s\S]*?\{([\s\S]*?)\}/);
    assert.ok(block, 'panel-toggle-item:focus-visible block must exist');
    assert.match(block[1], /outline:\s*2px/, 'toggle focus ring should be at least 2px wide');
  });
});

describe('CSS — focus-visible for preference controls', () => {
  it('.wm-pref-group > summary:focus-visible rule exists', () => {
    assert.match(css, /\.wm-pref-group\s*>\s*summary:focus-visible\s*\{/);
  });

  it('.unified-settings-select:focus-visible rule exists', () => {
    assert.match(css, /\.unified-settings-select:focus-visible\s*[,\{]/);
  });

  it('.ai-flow-switch input:focus-visible + .ai-flow-slider rule exists', () => {
    assert.match(css, /\.ai-flow-switch\s+input:focus-visible\s*\+\s*\.ai-flow-slider\s*\{/);
  });
});

describe('decorative children are aria-hidden', () => {
  it('panel-toggle-checkbox has aria-hidden="true"', () => {
    assert.match(settings, /panel-toggle-checkbox[\s\S]*?aria-hidden="true"/);
  });

  it('source-toggle-checkbox has aria-hidden="true"', () => {
    assert.match(settings, /source-toggle-checkbox[\s\S]*?aria-hidden="true"/);
  });
});
