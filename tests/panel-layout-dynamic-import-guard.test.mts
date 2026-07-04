import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// Regression coverage for WORLDMONITOR-R4 adapted to the lazy panel registry:
// split-risk panels must stay demand-loaded through `lazyPanel(...)`, and their
// dynamic imports must route through the Safari-safe importPanel helper. The
// shared lazy loader must also treat failed chunk loads as recoverable instead of
// letting an absent/offline async panel crash startup.

// Note: we deliberately do NOT strip comments via a naive regex before grepping —
// panel-layout.ts contains regex literals like `/\/\*.../` that would defeat a naive
// block-comment stripper. Instead, the brace walker below is token-aware: it skips over
// strings, template literals, line comments, and block comments so `{` / `}` characters
// inside those tokens don't confuse the depth tracker (greptile P2 robustness ask).

// Walk forward from the first `{` after a `.then(arg => ` header, tracking brace depth
// while skipping JS tokens that can contain `{` or `}` characters (strings, template
// literals, comments). Returns the callback body slice and the index immediately after
// the closing `}` so callers can assert on what follows the callback.
function findCallbackBody(source: string, callbackHeader: RegExp): { body: string; afterIdx: number } | null {
  const headerMatch = callbackHeader.exec(source);
  if (!headerMatch) return null;
  const openIdx = source.indexOf('{', headerMatch.index + headerMatch[0].length - 1);
  if (openIdx < 0) return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length) {
    const ch = source[i];
    // Line comment: skip to end of line
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    // Block comment: skip to closing */
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    // Single or double-quoted string: skip with escape awareness
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length) {
        const sc = source[i];
        if (sc === '\\') { i += 2; continue; }
        if (sc === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // Template literal: skip with escape awareness; nested `${...}` braces must still count
    // toward the OUTER block depth because they're real expression-position braces.
    // The simpler and sufficient choice here is to NOT count `{`/`}` inside the raw template
    // text, but DO count them inside `${...}` interpolations (treat the interpolation as
    // normal code). To keep the walker compact, we track interpolation depth separately.
    if (ch === '`') {
      i++;
      let interp = 0;
      while (i < source.length) {
        const tc = source[i];
        if (tc === '\\') { i += 2; continue; }
        if (interp === 0 && tc === '`') { i++; break; }
        if (interp === 0 && tc === '$' && source[i + 1] === '{') { interp = 1; i += 2; continue; }
        if (interp > 0) {
          if (tc === '{') interp++;
          else if (tc === '}') { interp--; if (interp === 0) { i++; continue; } }
        }
        i++;
      }
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(openIdx + 1, i), afterIdx: i + 1 };
      i++;
      continue;
    }
    i++;
  }
  return null;
}

function assertGuardedDynamicImport(source: string, modulePath: string, exportName: string) {
  const callbackHeader = new RegExp(
    `import\\(['"]${modulePath.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&')}['"]\\)\\.then\\(\\(\\{\\s*${exportName}\\s*\\}\\)\\s*=>\\s*\\{`,
  );
  const callback = findCallbackBody(source, callbackHeader);
  assert.ok(callback, `${exportName} dynamic import not found at expected call site`);
  assert.match(
    callback.body,
    new RegExp(`typeof\\s+${exportName}\\s*!==?\\s*['"]function['"]\\s*\\)\\s*return`),
    `${exportName} .then() must early-return if the destructured class is not a function`,
  );
  // After the callback's closing `}`, the next non-whitespace must be `, <onRejected>)`
  // — the two-arg `.then(onFulfilled, onRejected)` form. Specifically forbid the
  // `.then(...).catch(...)` shape because that swallows synchronous throws from
  // inside the callback body, masking real panel-construction bugs from Sentry.
  const tail = source.slice(callback.afterIdx, callback.afterIdx + 200);
  assert.match(
    tail,
    /^\s*,\s*\([^)]*\)\s*=>/,
    `${exportName} dynamic import must use the two-arg .then(onFulfilled, onRejected) form (not .then(...).catch(...) — that would swallow callback throws)`,
  );
  // Belt-and-braces: explicitly forbid a `.catch(` chained directly after the .then's
  // closing `)`. If someone re-introduces the bad pattern they get a clear failure.
  assert.doesNotMatch(
    tail,
    /^\s*\)\s*\.catch\(/,
    `${exportName} dynamic import MUST NOT use .then(...).catch(...) — use the two-arg .then(onFulfilled, onRejected) form so callback throws still surface in Sentry`,
  );
}

function assertLazyPanelRegistration(
  source: string,
  panelKey: string,
  modulePath: string,
  exportName: string,
) {
  const registration = new RegExp(
    `this\\.lazyPanel\\(['"]${panelKey}['"],\\s*\\(\\)\\s*=>\\s*(?:\\n\\s*)?this\\.importPanel\\(\\s*['"]${panelKey}['"],\\s*\\(\\)\\s*=>\\s*import\\(['"]${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\),\\s*['"]${exportName}['"]`,
  );
  assert.match(source, registration, `${exportName} must be registered through lazyPanel(${panelKey}) and importPanel()`);
  assert.doesNotMatch(
    source,
    new RegExp(`^import\\s+\\{[^}]*${exportName}[^}]*\\}\\s+from\\s+['"]${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'm'),
    `${exportName} must not be eagerly imported into panel-layout.ts`,
  );
}

function assertLazyLoaderHandlesFailedImports(source: string) {
  const loadRegisteredPanel = source.match(/private async loadRegisteredPanel\([\s\S]*?\n\s*private makeDraggable/);
  assert.ok(loadRegisteredPanel, 'loadRegisteredPanel helper not found');
  assert.match(
    loadRegisteredPanel[0],
    /registration\.loading = registration\.load\(\)[\s\S]*?\.catch\(\(err\) => \{/,
    'lazy panel chunk failures must be caught by the shared loader',
  );
  assert.match(
    loadRegisteredPanel[0],
    /registration\.loading = null;/,
    'failed lazy panel loads must reset the in-flight promise so the panel can retry',
  );
  assert.match(
    loadRegisteredPanel[0],
    /return null;/,
    'failed lazy panel loads must resolve to null instead of crashing startup',
  );
}

function assertSharedImportPanelGuard(source: string) {
  const callback = findCallbackBody(source, /return\s+importer\(\)\.then\(\(module\)\s*=>\s*\{/);
  assert.ok(callback, 'importPanel helper must call importer().then(onFulfilled, onRejected)');
  assert.match(
    callback.body,
    /const PanelClass = module\[exportName\];/,
    'importPanel helper must read the requested named export dynamically.',
  );
  assert.match(
    callback.body,
    /typeof\s+PanelClass\s*!==?\s*['"]function['"]/,
    'importPanel helper must verify the named export is a constructor function before using it.',
  );
  const tail = source.slice(callback.afterIdx, callback.afterIdx + 200);
  assert.match(
    tail,
    /^\s*,\s*\([^)]*\)\s*=>/,
    'importPanel helper must use two-arg .then(onFulfilled, onRejected), not .then(...).catch(...).',
  );
  assert.doesNotMatch(
    tail,
    /^\s*\)\s*\.catch\(/,
    'importPanel helper must not use .then(...).catch(...) for import failures.',
  );
}

function assertChatAnalystLoadsWithoutAgentBusApplier(source: string) {
  const registrationStart = source.indexOf("this.lazyPanel('chat-analyst'");
  assert.notEqual(registrationStart, -1, 'chat-analyst lazy panel registration not found');
  const registrationEnd = source.indexOf("this.lazyPanel('forecast'", registrationStart);
  assert.ok(registrationEnd > registrationStart, 'chat-analyst lazy panel registration boundary not found');
  const registration = source.slice(registrationStart, registrationEnd);

  assert.match(
    registration,
    /import\('@\/components\/ChatAnalystPanel'\)\.then\(m => \{/,
    'chat-analyst panel component should load independently',
  );
  assert.doesNotMatch(
    registration,
    /Promise\.all\(\s*\[[\s\S]*?@\/components\/ChatAnalystPanel[\s\S]*?@\/app\/agent-bus-applier/,
    'chat-analyst must not couple panel mounting to agent-bus-applier through Promise.all',
  );
  assert.match(
    registration,
    /const panel = new m\.ChatAnalystPanel\(\);[\s\S]*?void import\('@\/app\/agent-bus-applier'\)/,
    'chat-analyst should create the panel before loading the optional dashboard action handler',
  );
  assert.match(
    registration,
    /\.catch\(\(err\) => \{[\s\S]*?failed to lazy-load "chat-analyst" dashboard action handler/,
    'agent-bus-applier lazy-load failure should be logged without rejecting the panel loader',
  );
  assert.match(
    registration,
    /return panel;/,
    'chat-analyst loader should return the panel even while the optional action handler is loading',
  );
}

const SPLIT_RISK_PANEL_IMPORTS: Array<[string, string, string]> = [
  ['pipeline-status', '@/components/PipelineStatusPanel', 'PipelineStatusPanel'],
  ['storage-facility-map', '@/components/StorageFacilityMapPanel', 'StorageFacilityMapPanel'],
  ['fuel-shortages', '@/components/FuelShortagePanel', 'FuelShortagePanel'],
  ['energy-disruptions', '@/components/EnergyDisruptionsPanel', 'EnergyDisruptionsPanel'],
  ['energy-risk-overview', '@/components/EnergyRiskOverviewPanel', 'EnergyRiskOverviewPanel'],
  ['deduction', '@/components/DeductionPanel', 'DeductionPanel'],
  ['regional-intelligence', '@/components/RegionalIntelligenceBoard', 'RegionalIntelligenceBoard'],
  ['gulf-economies', '@/components/GulfEconomiesPanel', 'GulfEconomiesPanel'],
  ['grocery-basket', '@/components/GroceryBasketPanel', 'GroceryBasketPanel'],
  ['bigmac', '@/components/BigMacPanel', 'BigMacPanel'],
  ['fuel-prices', '@/components/FuelPricesPanel', 'FuelPricesPanel'],
  ['fao-food-price-index', '@/components/FaoFoodPriceIndexPanel', 'FaoFoodPriceIndexPanel'],
  ['climate-news', '@/components/ClimateNewsPanel', 'ClimateNewsPanel'],
  ['events', '@/components/TechEventsPanel', 'TechEventsPanel'],
  ['macro-signals', '@/components/MacroSignalsPanel', 'MacroSignalsPanel'],
];

describe('panel-layout lazy dynamic-import guard (WORLDMONITOR-R4)', () => {
  const filePath = new URL('../src/app/panel-layout.ts', import.meta.url);

  it('shared importPanel helper uses Safari-safe dynamic import guards', async () => {
    const source = await readFile(filePath, 'utf8');
    assertSharedImportPanelGuard(source);
    assertLazyLoaderHandlesFailedImports(source);
  });

  it('split-risk panels are demand-loaded through the guarded helper', async () => {
    const source = await readFile(filePath, 'utf8');
    for (const [panelKey, modulePath, exportName] of SPLIT_RISK_PANEL_IMPORTS) {
      assertLazyPanelRegistration(source, panelKey, modulePath, exportName);
    }
    assertLazyLoaderHandlesFailedImports(source);
  });

  it('chat analyst mounts even if the dashboard action handler chunk fails', async () => {
    const source = await readFile(filePath, 'utf8');
    assertChatAnalystLoadsWithoutAgentBusApplier(source);
  });

  it('token-aware brace walker skips strings/templates/comments', () => {
    // Synthetic fixture: braces inside strings, templates, line comments, block comments,
    // and ${...} interpolations MUST NOT confuse the depth tracker.
    const fixture = `import('@/components/Foo').then(({ Foo }) => {
      const s = "}{}{";
      const t = \`outer \${ {a: 1} } inner\`;
      // }}}
      /* { { { } } } */
      if (typeof Foo !== 'function') return;
      const r = new Foo();
    }, () => undefined);`;
    assertGuardedDynamicImport(fixture, '@/components/Foo', 'Foo');
  });

  it('synthetic mutation: missing typeof guard fails the assert', async () => {
    // If a future PR drops the typeof guard, the test must fail loudly (not silently pass).
    const fixture = `import('@/components/Foo').then(({ Foo }) => {
      const r = new Foo();
    }, () => undefined);`;
    assert.throws(
      () => assertGuardedDynamicImport(fixture, '@/components/Foo', 'Foo'),
      /must early-return if the destructured class is not a function/,
    );
  });

  it('synthetic mutation: .then(...).catch(...) form fails the assert', async () => {
    // The pre-greptile pattern. Must be rejected: it swallows callback throws.
    const fixture = `import('@/components/Foo').then(({ Foo }) => {
      if (typeof Foo !== 'function') return;
      const r = new Foo();
    }).catch(() => undefined);`;
    assert.throws(
      () => assertGuardedDynamicImport(fixture, '@/components/Foo', 'Foo'),
      /two-arg \.then\(onFulfilled, onRejected\) form/,
    );
  });
});
