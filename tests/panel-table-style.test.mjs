/**
 * Every dashboard panel table shares one header and cell style: `.wm-table`
 * in src/styles/panels.css.
 *
 * A November 2026 audit found 15 distinct header and cell styles across 23
 * visible panel tables: headers from 9px to 12px, bold or not, uppercase or
 * not, and cell padding from 0 to 8px. Each panel had copied and edited the
 * table rules.
 *
 * Two checks:
 * - Every `<table>` a panel renders carries `wm-table`, except the count still
 *   listed in PENDING for its file. PENDING may only shrink.
 * - A migrated table's own `.<name> th` / `.<name> td` rules (also written
 *   `thead th` / `tbody td`) do not redeclare the shared typography, colour,
 *   padding or row border. Panel rules keep widths, column alignment, sticky
 *   headers and state colours.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

/** Not dashboard panel tables: they belong to their own overlays and documents. */
const OUT_OF_SCOPE = new Set([
  'src/components/CountryDeepDivePanel-five-factor-scorecard.ts', // country brief overlay (cdp-*)
  'src/components/OperationalExposureForm.ts', // printable exposure form
  'src/components/RouteExplorer/KeyboardHelp.ts', // Route Explorer modal
  'src/components/RouteExplorer/tabs/CountryImpactTab.ts',
  'src/components/RouteExplorer/tabs/CurrentRouteTab.ts',
]);

/** Panel tables not yet on `.wm-table`, per file. Remove entries as they move. */
const PENDING = {
  'src/components/EconomicCalendarPanel.ts': 1,
  'src/components/MarketPanel.ts': 1,
  'src/components/StockAnalysisPanel.ts': 1,
  'src/components/SupplyChainPanel.ts': 4,
  'src/components/TradePolicyPanel.ts': 3,
  'src/components/WsbTickerScannerPanel.ts': 1,
  'src/components/YieldCurvePanel.ts': 1,
};

/** Properties `.wm-table` owns for every header and body cell. */
const SHARED = ['font-size', 'font-weight', 'text-transform', 'letter-spacing', 'color', 'padding', 'border-bottom'];
/** Shorthands that also set a shared property (border-bottom, font-size, font-weight). */
const SHORTHANDS = ['border', 'border-block', 'border-block-end', 'font'];

function componentFiles(dir = 'src/components/') {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return componentFiles(`${dir}${entry.name}/`);
    return entry.name.endsWith('.ts') ? [`${dir}${entry.name}`] : [];
  });
}

/** Class lists of the tables a file renders: template `<table ...>` and h('table', { className }). */
function tablesIn(source) {
  // A `<table>` in a comment is not markup.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tables = [];
  for (const m of code.matchAll(/<table\b([^>]*)>/g)) {
    tables.push(m[1].match(/\bclass="([^"]*)"/)?.[1] ?? '');
  }
  for (const m of code.matchAll(/h\(\s*'table'\s*,\s*\{([^}]*)\}/g)) {
    tables.push(m[1].match(/className:\s*'([^']*)'/)?.[1] ?? '');
  }
  return tables;
}

const panelFiles = componentFiles().filter((path) => !OUT_OF_SCOPE.has(path));
const tables = panelFiles.flatMap((path) => tablesIn(read(path)).map((cls) => ({ path, classes: cls.split(/\s+/).filter(Boolean) })));

/** Rules whose selector list includes exactly `.<name> th` or `.<name> td`, optionally via thead/tbody. */
function exactCellRules(css, name) {
  const rules = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    const cells = [`.${name} th`, `.${name} td`, `.${name} thead th`, `.${name} tbody td`];
    if (selectors.some((s) => cells.includes(s))) rules.push({ selector: m[1].trim(), body: m[2] });
  }
  return rules;
}

describe('panel table style', () => {
  it('scans the panel tables', () => {
    assert.ok(tables.length >= 35, `only ${tables.length} panel tables found; the scan is broken`);
    for (const path of [...OUT_OF_SCOPE, ...Object.keys(PENDING)]) {
      assert.ok(panelFiles.includes(path) || OUT_OF_SCOPE.has(path), `${path} is gone; update the list`);
    }
  });

  it('every panel table uses .wm-table unless it is still pending', () => {
    const unmigrated = {};
    for (const { path, classes } of tables) {
      if (!classes.includes('wm-table')) unmigrated[path] = (unmigrated[path] ?? 0) + 1;
    }
    assert.deepEqual(unmigrated, PENDING);
  });

  it('migrated tables do not redeclare the shared header and cell style', () => {
    const css = ['src/styles/panels.css', 'src/styles/main.css'].map(read).join('\n')
      + panelFiles.map(read).join('\n');
    const names = new Set(tables.filter((t) => t.classes.includes('wm-table')).flatMap((t) => t.classes.filter((c) => c !== 'wm-table')));
    const redeclared = [];
    for (const name of names) {
      for (const { selector, body } of exactCellRules(css, name)) {
        const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]).filter((p) => SHARED.includes(p) || SHORTHANDS.includes(p) || SHARED.some((s) => p.startsWith(`${s}-`) && s !== 'color'));
        if (props.length) redeclared.push(`${selector} { ${props.join(', ')} }`);
      }
    }
    assert.deepEqual(redeclared, []);
  });

  // Cells carry state classes such as .change-positive or .etf-ticker. The
  // shared rules use :where() so that any class on a cell outranks them.
  it('.wm-table defines the shared header and cell style below class specificity', () => {
    const css = read('src/styles/panels.css');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
    for (const selector of [':where(.wm-table) th', ':where(.wm-table) td', ':where(.wm-table) > tbody > tr > th']) {
      assert.ok(selectors.includes(selector), `${selector} is missing from panels.css`);
    }
    assert.doesNotMatch(css, /(^|[\s,}])\.wm-table (th|td)\b/, 'a .wm-table th/td rule outranks the state classes on cells');
  });

  // Body cells align to the inline start (right in Arabic). A physical
  // `left` on the header would leave every header on the other side of its column.
  it('.wm-table headers align to the inline start', () => {
    const header = read('src/styles/panels.css').match(/:where\(\.wm-table\) th \{([^}]*)\}/)?.[1] ?? '';
    assert.match(header, /text-align:\s*start;/);
  });

  it('a class on a migrated header cell does not restyle the shared header', () => {
    const css = ['src/styles/panels.css', 'src/styles/main.css'].map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const migrated = panelFiles.filter((path) => tables.some((t) => t.path === path && t.classes.includes('wm-table')));
    const headerClasses = new Set(migrated.flatMap((path) => [...read(path).matchAll(/<th\b[^>]*\bclass="([^"$]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean))));
    const typography = ['font-size', 'font-weight', 'text-transform', 'letter-spacing', 'color'];
    const restyled = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map((sel) => sel.trim());
      const props = [...m[2].matchAll(/([\w-]+)\s*:/g)].map((d) => d[1]).filter((prop) => typography.includes(prop));
      for (const name of headerClasses) {
        if (props.length && selectors.includes(`.${name}`)) restyled.push(`.${name} { ${props.join(', ')} }`);
      }
    }
    assert.deepEqual(restyled, []);
  });
});
