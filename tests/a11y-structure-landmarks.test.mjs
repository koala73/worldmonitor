/**
 * Regression guard for the heading-outline / landmark pairing in PR #7029:
 *   - .panel-title is a level-2 heading via role/aria-level
 *   - settings tabs share settingsTab-* ids with aria-controls="contentArea"
 *   - the settings tabpanel labelledby tracks the selected tab
 *   - search retargets the tabpanel name and does not keep tabindex="0"
 *
 * Source-invariant, same shape as tests/a11y-issue-4373-invariants.test.mjs.
 *
 * Run: node --test tests/a11y-structure-landmarks.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const panelSrc = read('src', 'components', 'Panel.ts');
const settingsMain = read('src', 'settings-main.ts');
const settingsHtml = read('settings.html');

describe('Panel title heading outline', () => {
  it('marks .panel-title as a level-2 heading', () => {
    assert.match(panelSrc, /title\.setAttribute\('role',\s*'heading'\)/);
    assert.match(panelSrc, /title\.setAttribute\('aria-level',\s*'2'\)/);
  });
});

describe('settings tablist / tabpanel pairing', () => {
  it('gives overview, category, and debug tabs matching settingsTab-* ids and aria-controls', () => {
    assert.match(
      settingsMain,
      /id="settingsTab-overview"[^>]*role="tab"[^>]*aria-controls="contentArea"/,
    );
    assert.match(
      settingsMain,
      /id="settingsTab-\$\{cat\.id\}"[^>]*role="tab"[^>]*aria-controls="contentArea"/,
    );
    assert.match(
      settingsMain,
      /id="settingsTab-debug"[^>]*role="tab"[^>]*aria-controls="contentArea"/,
    );
  });

  it('points the tabpanel labelledby at settingsTab-${activeSection} in section mode', () => {
    assert.match(settingsMain, /labelSettingsContentArea\('section'\)/);
    assert.match(
      settingsMain,
      /setAttribute\('aria-labelledby',\s*`settingsTab-\$\{activeSection\}`\)/,
    );
  });

  it('retargets the tabpanel name to Search results on both search result paths', () => {
    const searchCalls = settingsMain.match(/labelSettingsContentArea\('search'\)/g);
    assert.equal(searchCalls?.length, 2, 'empty-match and results paths must both relabel the tabpanel');
    assert.match(settingsMain, /removeAttribute\('aria-labelledby'\)/);
    assert.match(settingsMain, /setAttribute\('aria-label',\s*'Search results'\)/);
  });

  it('does not put #contentArea in sequential Tab order', () => {
    const line = settingsHtml.split('\n').find((l) => l.includes('id="contentArea"'));
    assert.ok(line, '#contentArea must exist');
    assert.match(line, /role="tabpanel"/);
    assert.doesNotMatch(line, /tabindex=/, 'tabindex=0 added an extra keyboard stop without roving tabindex');
  });
});
