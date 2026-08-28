/**
 * Regression guard for the table-header scope sweep (#7023 / PR 7030):
 *   - Country Deep Dive builds thead cells via this.el('th'), so a literal
 *     `<th` grep misses them unless el() sets scope="col".
 *   - The settings traffic-log table is the remaining HTML-literal header
 *     surface outside the dashboard panel sweep.
 *
 * Run: node --test tests/a11y-table-scope-invariants.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

const cdp = read('src', 'components', 'CountryDeepDivePanel.ts');
const settingsMain = read('src', 'settings-main.ts');

describe('CountryDeepDivePanel DOM headers get column scope', () => {
  it('el() assigns scope="col" on th nodes', () => {
    const elFn = cdp.match(
      /private el<K extends keyof HTMLElementTagNameMap>[\s\S]*?return node;\n {2}}/,
    );
    assert.ok(elFn, 'expected CountryDeepDivePanel.el() helper');
    assert.match(elFn[0], /if \(tag === 'th'\)/);
    assert.match(elFn[0], /\.scope = 'col'/);
  });

  it('does not create th nodes outside el()', () => {
    assert.doesNotMatch(cdp, /createElement\(\s*['"]th['"]\s*\)/);
  });
});

describe('settings traffic-log headers are scoped', () => {
  it('diag-table thead headers include scope="col"', () => {
    assert.match(
      settingsMain,
      /<table class="diag-table"><thead><tr>(?:<th scope="col">[^<]*<\/th>){5}<\/tr><\/thead>/,
    );
  });
});
