/**
 * Every class these panels emit must have a rule scoped under a panel root.
 *
 * The R&D Signal (defense-patents), Toronto Safety and AI Regulation panels
 * shipped markup whose classes appeared in no stylesheet, so each panel
 * rendered as raw stacked text with no padding. The Hormuz commodity
 * dependency list put a country and its context in two bare spans, which ran
 * together as "DjiboutiSoybeans"; the rest of that panel is styled inline, so
 * only its dependency block is checked. A class that only matches an
 * unrelated rule elsewhere (`.stat`, `.count`, an RTL override) does not count:
 * the rule must name the panel root. DefensePatentsPanel paints its loading
 * state outside the list wrapper (a raw write the content-write ratchet keeps on
 * purpose), so that state is a second root. Shared tab primitives are checked
 * against any dashboard sheet.
 *
 * Classes built by interpolation (`impact-${x}`) are invisible to the source
 * scan, so the modifiers that carry colour are listed explicitly from their
 * TypeScript unions.
 *
 * Accent borders must be logical (`border-inline-start`). rtl-overrides.css
 * loads before panels.css, so a physical `border-left` here wins over the
 * `[dir="rtl"]` rule at equal specificity and pins the accent to the wrong side.
 * An inline `style="border-left: …"` beats every sheet, so templates pass the
 * colour as a custom property instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const srcDir = new URL('../src/', import.meta.url);

const PANELS = {
  'components/DefensePatentsPanel.ts': { roots: ['defense-patents-panel', 'defense-patents-loading'], samples: ['defense-patent-row'] },
  'components/TorontoSafetyPanel.ts': { roots: ['toronto-safety-panel'], samples: ['intel-item'] },
  'components/RegulationPanel.ts': {
    roots: ['regulation-panel'],
    samples: ['timeline-item'],
    modifiers: [
      'type-comprehensive', 'type-sectoral', 'type-voluntary', 'type-proposed',
      'stance-strict', 'stance-moderate', 'stance-permissive', 'stance-undefined',
      'impact-high', 'impact-medium', 'impact-low',
      'urgent', 'warning', 'normal', 'passed',
    ],
  },
  'components/HormuzPanel.ts': {
    roots: ['hz-dependencies'],
    samples: ['hz-dependency-label', 'hz-dependency-context'],
    only: /^hz-dependenc/,
  },
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

const rules = cssFiles(srcDir)
  .filter((url) => !EXCLUDED.has(url.pathname.slice(srcDir.pathname.length)))
  .flatMap((url) => {
    const css = readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selectors: m[1].split(';').pop().split(',').map((s) => s.trim()),
      body: m[2],
    }));
  });
const selectors = rules.flatMap((rule) => rule.selectors);

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
  for (const [relPath, { roots, samples, only, modifiers = [] }] of Object.entries(PANELS)) {
    it(relPath, () => {
      const classes = [...emittedClasses(relPath).filter((cls) => !only || only.test(cls)), ...modifiers];
      for (const expected of [...roots, ...samples]) {
        assert.ok(classes.includes(expected), `class extraction missed ${expected}: ${classes.join(' ')}`);
      }

      const unstyled = classes.filter((cls) => (SHARED.has(cls)
        ? !selectors.some((s) => hasClass(s, cls))
        : !selectors.some((s) => hasClass(s, cls) && roots.some((root) => hasClass(s, root)))));
      assert.deepEqual(unstyled, [], `${relPath} emits classes with no rule under .${roots.join(' or .')}`);
    });
  }

  it('uses logical inline borders under every panel root', () => {
    const roots = Object.values(PANELS).flatMap((panel) => panel.roots);
    const scoped = rules.filter((rule) => rule.selectors.some((s) => roots.some((root) => hasClass(s, root))));
    assert.ok(scoped.length > 50, `expected the panel rules, found ${scoped.length}`);
    const physical = scoped
      .filter((rule) => /(^|[;\s])border-(left|right)[\w-]*\s*:/.test(rule.body))
      .map((rule) => rule.selectors.join(', '));
    assert.deepEqual(physical, [], 'use border-inline-start/end so [dir="rtl"] flips the accent');
  });

  it('keeps physical sides out of inline style attributes', () => {
    const physical = Object.keys(PANELS).flatMap((relPath) => {
      const source = readFileSync(new URL(relPath, srcDir), 'utf8');
      return [...source.matchAll(/style="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((style) => /(^|[;\s])(border|padding|margin)-(left|right)[\w-]*\s*:/.test(style))
        .map((style) => `${relPath}: ${style}`);
    });
    assert.deepEqual(physical, [], 'an inline style beats the stylesheet and never flips in RTL; pass the value as a custom property');
  });
});
