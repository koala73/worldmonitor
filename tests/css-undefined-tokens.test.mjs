/**
 * Every `var(--token)` without a fallback must name a token that exists.
 *
 * When a custom property is not defined, the browser treats the declaration as
 * invalid at computed-value time: `color` falls back to the inherited text color,
 * `background` to transparent, and a `border` shorthand to no border. Nothing
 * logs. The dashboard shipped 23 such tokens (#9961 follow-up): red error text
 * rendered as plain text, the market chart modal had no background, and the
 * active time-range button on the 2D map lost its fill, leaving dark text on a
 * dark map.
 *
 * A dashboard token is "defined" when a dashboard stylesheet declares it, or when
 * the code sets it inline on the element (INLINE_TOKENS, each checked against its
 * source file). Standalone pages (plugin market, plugins, embed) load only the
 * sheets their own entry point imports, so tokens they declare do not count for
 * the dashboard; each standalone sheet is checked against its own page's sheets,
 * following @import (base-layer.css pulls in main.css). happy-theme.css only
 * applies to the happy variant and the embed page: its tokens do not count for
 * the main dashboard, and its own uses are checked against the dashboard tokens
 * plus its own.
 *
 * Limitation: a token declared under any selector counts as defined everywhere,
 * so a token scoped to one container is not caught when read outside it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const srcDir = new URL('../src/', import.meta.url);

/** Tokens that a component sets in an inline style on the element that reads them. */
const INLINE_TOKENS = {
  '--category-color': 'components/NewsPanel.ts',
  '--category-background': 'components/NewsPanel.ts',
};

/** Standalone pages: sheet -> the other sheets its entry point loads (see src/*-main.ts). */
const STANDALONE = {
  'styles/plugin-market.css': [],
  'styles/plugin.css': ['styles/base-layer.css'],
  'styles/plugin-country.css': ['styles/base-layer.css'],
  'styles/embed.css': ['styles/base-layer.css', 'styles/happy-theme.css'],
};
const VARIANT_ONLY = new Set(['styles/happy-theme.css']);

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : cssFiles(new URL(`${entry.name}/`, dir));
    return entry.name.endsWith('.css') ? [new URL(entry.name, dir)] : [];
  });
}

const sheets = Object.fromEntries(cssFiles(srcDir).map((url) => [
  url.pathname.slice(srcDir.pathname.length),
  readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')),
]));

/** Tokens a sheet declares, following its relative @import url('./x.css') chain. */
function declares(path, seen = new Set()) {
  if (seen.has(path) || !(path in sheets)) return [];
  seen.add(path);
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const imported = [...sheets[path].matchAll(/@import\s+url\(\s*['"]\.\/([\w.-]+\.css)['"]\s*\)/g)]
    .flatMap((m) => declares(dir + m[1], seen));
  return [...imported, ...[...sheets[path].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])];
}
const dashboardSheets = Object.keys(sheets).filter((p) => !(p in STANDALONE) && !VARIANT_ONLY.has(p));
const dashboardTokens = new Set(dashboardSheets.flatMap((p) => declares(p)));

/** Tokens visible to a sheet: its page's sheets plus inline-set tokens. */
function definedFor(path) {
  // A variant theme layers over the dashboard, so it sees the dashboard tokens plus its own.
  if (VARIANT_ONLY.has(path)) return new Set([...dashboardTokens, ...declares(path)]);
  if (!(path in STANDALONE)) return dashboardTokens;
  return new Set([path, ...STANDALONE[path]].flatMap((p) => declares(p)));
}

/** Every var(--name) with no fallback, with its file and line. */
function bareUses() {
  const uses = [];
  for (const path of [...dashboardSheets, ...Object.keys(STANDALONE), ...VARIANT_ONLY]) {
    const css = sheets[path];
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      uses.push({ path, name: m[1], where: `src/${path}:${css.slice(0, m.index).split('\n').length}` });
    }
  }
  return uses;
}

describe('CSS custom properties', () => {
  it('scans the stylesheets', () => {
    assert.ok(dashboardSheets.length >= 10, `only ${dashboardSheets.length} dashboard stylesheets found`);
    for (const [path, deps] of Object.entries(STANDALONE)) {
      for (const p of [path, ...deps]) assert.ok(p in sheets, `src/${p} is gone; update STANDALONE`);
    }
    assert.ok(bareUses().length > 500, 'too few var() uses found; the scan is broken');
  });

  it('inline tokens are still set by the code that owns them', () => {
    for (const [name, file] of Object.entries(INLINE_TOKENS)) {
      const source = readFileSync(new URL(file, srcDir), 'utf8');
      assert.ok(source.includes(`${name}:`), `${file} no longer sets ${name}; remove it from INLINE_TOKENS`);
    }
  });

  it('every var() without a fallback names a defined token', () => {
    const missing = bareUses()
      .filter(({ path, name }) => !definedFor(path).has(name) && !(name in INLINE_TOKENS))
      .map(({ name, where }) => `${where} ${name}`);
    assert.deepEqual(missing, []);
  });
});
