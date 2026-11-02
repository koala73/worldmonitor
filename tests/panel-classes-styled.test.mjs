/**
 * Every class these panels emit must have a rule scoped under the panel's root.
 *
 * The R&D Signal (defense-patents), Toronto Safety and AI Regulation panels
 * shipped markup whose classes appeared in no stylesheet, so each panel
 * rendered as raw stacked text with no padding. A class that only matches an
 * unrelated rule elsewhere (`.stat`, `.count`, an RTL override) does not count:
 * the rule must name the panel root. Shared tab primitives are checked against
 * any dashboard sheet.
 *
 * Classes built by interpolation (`impact-${x}`) are skipped; the static ones
 * are what a refactor drops.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const srcDir = new URL('../src/', import.meta.url);

const PANELS = {
  'components/DefensePatentsPanel.ts': { root: 'defense-patents-panel', sample: 'defense-patent-row' },
  'components/TorontoSafetyPanel.ts': { root: 'toronto-safety-panel', sample: 'intel-item' },
  'components/RegulationPanel.ts': { root: 'regulation-panel', sample: 'timeline-item' },
};

const SHARED = new Set(['panel-tabs', 'panel-tab']);

/** Sheets that never apply to the default LTR dashboard. */
const EXCLUDED = new Set([
  'styles/plugin-market.css',
  'styles/plugin.css',
  'styles/plugin-country.css',
  'styles/embed.css',
  'styles/happy-theme.css',
  'styles/rtl-overrides.css',
]);

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : cssFiles(new URL(`${entry.name}/`, dir));
    return entry.name.endsWith('.css') ? [new URL(entry.name, dir)] : [];
  });
}

const selectors = cssFiles(srcDir)
  .filter((url) => !EXCLUDED.has(url.pathname.slice(srcDir.pathname.length)))
  .flatMap((url) => {
    const css = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  });

const hasClass = (selector, cls) => new RegExp(`\\.${cls}(?![\\w-])`).test(selector);

function emittedClasses(relPath) {
  const source = readFileSync(new URL(relPath, srcDir), 'utf8');
  const values = [
    ...[...source.matchAll(/className:\s*(['"`])((?:(?!\1)[\s\S])*)\1/g)].map((m) => m[2]),
    ...[...source.matchAll(/class="([^"]*)"/g)].map((m) => m[1]),
  ];
  const tokens = values.flatMap((value) => value.replace(/\$\{[^}]*\}/g, '\0').split(/\s+/));
  return [...new Set(tokens.filter((token) => token && !token.includes('\0')))].sort();
}

describe('audit panels style every class they emit', () => {
  for (const [relPath, { root, sample }] of Object.entries(PANELS)) {
    it(relPath, () => {
      const classes = emittedClasses(relPath);
      assert.ok(classes.includes(root) && classes.includes(sample), `class extraction missed ${root} or ${sample}: ${classes.join(' ')}`);

      const unstyled = classes.filter((cls) => (SHARED.has(cls)
        ? !selectors.some((s) => hasClass(s, cls))
        : !selectors.some((s) => hasClass(s, cls) && hasClass(s, root))));
      assert.deepEqual(unstyled, [], `${relPath} emits classes with no rule under .${root}`);
    });
  }
});
