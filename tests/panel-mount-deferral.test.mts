import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import { createBrowserEnvironment } from './helpers/mini-dom.mts';
import {
  countInteractiveControls,
  createDeferredPanelShell,
  getDeferredPanelShellFootprint,
  getInitialPanelMountBudget,
  reconcileDeferredPanelShellColSpan,
  shouldDeferInitialPanelMount,
} from '../src/app/panel-mount-deferral';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installDom() {
  const env = createBrowserEnvironment();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: env.document,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    writable: true,
    value: env.HTMLElement,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: env.window,
  });
  return env.document;
}

function restoreDom(): void {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
  else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
}

interface ParsedNaturalFootprint {
  rowSpan?: number;
  className?: string;
}

// Lightweight parse of the flat (one-entry-per-line) DEFERRED_PANEL_NATURAL_FOOTPRINTS
// registry from panel-layout.ts source, so the e2e footprint test runs against the
// real registry without importing panel-layout.ts (which needs the app bundler).
function parseNaturalFootprintRegistry(src: string): Map<string, ParsedNaturalFootprint> {
  const declIdx = src.indexOf('DEFERRED_PANEL_NATURAL_FOOTPRINTS');
  const open = src.indexOf('{', src.indexOf('= {', declIdx));
  const end = src.indexOf('\n};', open);
  const block = src.slice(open, end === -1 ? undefined : end);
  const map = new Map<string, ParsedNaturalFootprint>();
  const entryRe = /(?:'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(block))) {
    const key = match[1] ?? match[2];
    const body = match[3] ?? '';
    const rowSpan = body.match(/rowSpan:\s*([2-4])/);
    map.set(key, {
      rowSpan: rowSpan ? Number(rowSpan[1]) : undefined,
      className: /panel-wide/.test(body) ? 'panel-wide' : undefined,
    });
  }
  return map;
}

function createFullPanel(id: string): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset.panel = id;

  const header = document.createElement('div');
  header.className = 'panel-header';
  header.appendChild(document.createElement('button'));
  header.appendChild(document.createElement('button'));

  const content = document.createElement('div');
  content.className = 'panel-content';
  content.appendChild(document.createElement('input'));
  content.appendChild(document.createElement('button'));
  for (let index = 0; index < 8; index++) {
    const row = document.createElement('div');
    row.className = 'test-row';
    row.appendChild(document.createElement('span'));
    row.appendChild(document.createElement('span'));
    content.appendChild(row);
  }

  panel.appendChild(header);
  panel.appendChild(content);
  return panel;
}

function elementCount(root: ParentNode): number {
  return root.querySelectorAll('*').length;
}

afterEach(() => {
  restoreDom();
});

describe('panel mount deferral', () => {
  it('uses a smaller initial real-panel budget on mobile', () => {
    assert.equal(getInitialPanelMountBudget(false), 8);
    assert.equal(getInitialPanelMountBudget(true), 3);
    assert.equal(shouldDeferInitialPanelMount({ enabled: false, mountedEnabledCount: 100, isMobile: false }), false);
    assert.equal(shouldDeferInitialPanelMount({ enabled: true, mountedEnabledCount: 7, isMobile: false }), false);
    assert.equal(shouldDeferInitialPanelMount({ enabled: true, mountedEnabledCount: 8, isMobile: false }), true);
    // Mobile budget is 3: the first 3 enabled panels mount immediately; the 4th defers.
    assert.equal(shouldDeferInitialPanelMount({ enabled: true, mountedEnabledCount: 2, isMobile: true }), false);
    assert.equal(shouldDeferInitialPanelMount({ enabled: true, mountedEnabledCount: 3, isMobile: true }), true);
  });

  it('creates inert shells with panel identity but no startup controls', () => {
    const document = installDom();
    const shell = createDeferredPanelShell('strategic-risk', 'Strategic Risk Overview');
    document.body.appendChild(shell);

    assert.equal(shell.dataset.panel, 'strategic-risk');
    assert.equal(shell.dataset.deferredPanel, 'true');
    assert.equal(shell.getAttribute('aria-hidden'), 'true');
    assert.equal(shell.querySelector('.panel-title')?.textContent, 'Strategic Risk Overview');
    assert.equal(countInteractiveControls(shell), 0);
  });

  it('reserves natural lazy-panel row and column footprints before hydration', () => {
    const document = installDom();
    const naturalFootprints = {
      'live-webcams': { className: 'panel-wide' },
      'supply-chain': { rowSpan: 2 },
    };

    const wideShell = createDeferredPanelShell(
      'live-webcams',
      'Live Webcams',
      getDeferredPanelShellFootprint({ panelId: 'live-webcams', naturalFootprints }),
    );
    const tallShell = createDeferredPanelShell(
      'supply-chain',
      'Supply Chain',
      getDeferredPanelShellFootprint({ panelId: 'supply-chain', naturalFootprints }),
    );
    document.body.appendChild(wideShell);
    document.body.appendChild(tallShell);

    assert.equal(wideShell.classList.contains('panel-wide'), true);
    assert.equal(tallShell.classList.contains('span-2'), true);
  });

  it('clamps saved deferred-shell column spans to the rendered grid width after insertion', () => {
    const document = installDom();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    Object.defineProperty(grid, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 560, height: 0, top: 0, left: 0, right: 560, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    (globalThis.window as unknown as { getComputedStyle: () => { gridTemplateColumns: string; columnGap: string } }).getComputedStyle = () => ({
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      columnGap: '0',
    });

    const shell = createDeferredPanelShell(
      'live-webcams',
      'Live Webcams',
      getDeferredPanelShellFootprint({ panelId: 'live-webcams', savedColSpans: { 'live-webcams': 3 } }),
    );
    grid.appendChild(shell);
    document.body.appendChild(grid);
    reconcileDeferredPanelShellColSpan(shell);

    assert.equal(shell.classList.contains('col-span-3'), false);
    assert.equal(shell.classList.contains('col-span-2'), true);
  });

  it('waits for a measurable connected grid before clamping saved shell column spans', () => {
    const document = installDom();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    let gridWidth = 0;
    Object.defineProperty(grid, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: gridWidth, height: 0, top: 0, left: 0, right: gridWidth, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    (globalThis.window as unknown as { getComputedStyle: () => { gridTemplateColumns: string; columnGap: string } }).getComputedStyle = () => ({
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      columnGap: '0',
    });

    const frames: Array<() => void> = [];
    (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
      frames.push(cb);
      return frames.length;
    };

    try {
      const shell = createDeferredPanelShell(
        'live-webcams',
        'Live Webcams',
        getDeferredPanelShellFootprint({ panelId: 'live-webcams', savedColSpans: { 'live-webcams': 3 } }),
      );
      grid.appendChild(shell);
      document.body.appendChild(grid);

      reconcileDeferredPanelShellColSpan(shell);
      assert.equal(shell.classList.contains('col-span-3'), true);
      assert.equal(frames.length, 1);

      gridWidth = 560;
      frames.shift()?.();
      assert.equal(shell.classList.contains('col-span-3'), false);
      assert.equal(shell.classList.contains('col-span-2'), true);
    } finally {
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
  });

  it('defers col-span reconciliation until the shell is connected, then clamps', () => {
    const document = installDom();
    const grid = document.createElement('div');
    grid.className = 'panels-grid';
    Object.defineProperty(grid, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 560, height: 0, top: 0, left: 0, right: 560, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    (globalThis.window as unknown as { getComputedStyle: () => { gridTemplateColumns: string; columnGap: string } }).getComputedStyle = () => ({
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      columnGap: '0',
    });

    // Drive requestAnimationFrame synchronously so the retry path is observable.
    const frames: Array<() => void> = [];
    (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
      frames.push(cb);
      return frames.length;
    };

    const shell = createDeferredPanelShell(
      'live-webcams',
      'Live Webcams',
      getDeferredPanelShellFootprint({ panelId: 'live-webcams', savedColSpans: { 'live-webcams': 3 } }),
    );
    grid.appendChild(shell);

    // Grid is detached: reconcile must NOT clamp against a 0-width grid; it
    // schedules a retry instead of mis-reading the column count.
    reconcileDeferredPanelShellColSpan(shell);
    assert.equal(shell.classList.contains('col-span-3'), true);
    assert.equal(frames.length, 1);

    // Once connected, the queued frame clamps to the real column count.
    document.body.appendChild(grid);
    frames.shift()?.();
    assert.equal(shell.classList.contains('col-span-3'), false);
    assert.equal(shell.classList.contains('col-span-2'), true);

    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  });

  it('lets saved user spans override natural deferred-shell footprints', () => {
    const document = installDom();
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'live-webcams',
      naturalFootprints: { 'live-webcams': { className: 'panel-wide', rowSpan: 2 } },
      savedRowSpans: { 'live-webcams': 3 },
      savedColSpans: { 'live-webcams': 1 },
    });
    const shell = createDeferredPanelShell('live-webcams', 'Live Webcams', footprint);
    document.body.appendChild(shell);

    assert.equal(shell.classList.contains('panel-wide'), true);
    assert.equal(shell.classList.contains('span-3'), true);
    assert.equal(shell.classList.contains('span-2'), false);
    assert.equal(shell.classList.contains('col-span-1'), true);
  });


  it('marks saved row-span deferred shells as resized', () => {
    const document = installDom();
    const shell = createDeferredPanelShell(
      'supply-chain',
      'Supply Chain',
      getDeferredPanelShellFootprint({
        panelId: 'supply-chain',
        naturalFootprints: { 'supply-chain': { rowSpan: 2 } },
        savedRowSpans: { 'supply-chain': 3 },
      }),
    );
    document.body.appendChild(shell);

    assert.equal(shell.classList.contains('span-3'), true);
    assert.equal(shell.classList.contains('resized'), true);
  });

  it('keeps a saved col-span that equals a non-wide natural col-span', () => {
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'wide-data',
      naturalFootprints: { 'wide-data': { colSpan: 2 } },
      savedColSpans: { 'wide-data': 2 },
    });

    assert.equal(footprint.colSpan, 2);
    assert.equal(footprint.colSpanSource, 'saved');
  });

  it('suppresses a saved col-span that matches the panel-wide default of 2', () => {
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'live-webcams',
      naturalFootprints: { 'live-webcams': { className: 'panel-wide' } },
      savedColSpans: { 'live-webcams': 2 },
    });

    assert.equal(footprint.className, 'panel-wide');
    assert.equal(footprint.colSpan, undefined);
  });

  it('applies collapsed state and dynamic default footprints to deferred shells', () => {
    const document = installDom();
    const dynamicFootprints = {
      'cw-': { rowSpan: 2 },
      'mcp-': { rowSpan: 2 },
    };

    const customShell = createDeferredPanelShell(
      'cw-example',
      'Custom Widget',
      getDeferredPanelShellFootprint({ panelId: 'cw-example', dynamicFootprints }),
    );
    const mcpShell = createDeferredPanelShell(
      'mcp-example',
      'MCP Data',
      getDeferredPanelShellFootprint({
        panelId: 'mcp-example',
        dynamicFootprints,
        savedCollapsed: { 'mcp-example': true },
      }),
    );
    document.body.appendChild(customShell);
    document.body.appendChild(mcpShell);

    assert.equal(customShell.classList.contains('span-2'), true);
    assert.equal(mcpShell.classList.contains('span-2'), true);
    assert.equal(mcpShell.classList.contains('panel-collapsed'), true);
    assert.equal(countInteractiveControls(mcpShell), 0);
  });

  it('rejects out-of-range or non-integer saved spans and falls back to the natural footprint', () => {
    installDom();
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'supply-chain',
      naturalFootprints: { 'supply-chain': { rowSpan: 2 } },
      savedRowSpans: { 'supply-chain': 9 }, // over the 4-row max → rejected
      savedColSpans: { 'supply-chain': 2.5 }, // non-integer → rejected
    });
    assert.equal(footprint.rowSpan, 2); // fell back to the natural row span
    assert.equal(footprint.colSpan, undefined); // no natural col span, saved value rejected
  });

  // End-to-end guard: the whole point of the deferred shell is that it reserves
  // exactly the footprint the REAL panel takes after hydration. The real Panel
  // cannot be instantiated here (it needs the app bundler / i18next), so we pin
  // the panel's class formula from its source and assert the shell — built from
  // the real registry via the real shell builder — produces the identical
  // classes. If either the panel formula or the shell builder drifts, this fails.
  it('reserves the same footprint classes the real panel applies after hydration', async () => {
    const document = installDom();
    const panelSrc = await readFile(new URL('../src/components/Panel.ts', import.meta.url), 'utf8');
    const layoutSrc = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

    // Pin the real panel's footprint formulas: a tall panel gets `span-${N}`
    // (only when N > 1) and a wide panel carries the `panel-wide` class. The
    // shell below hardcodes these same class names, so a change here that isn't
    // mirrored in panel-mount-deferral must break this test.
    assert.match(
      panelSrc,
      /options\.defaultRowSpan\s*&&\s*options\.defaultRowSpan\s*>\s*1/,
      'Panel must only reserve a row span class when defaultRowSpan > 1',
    );
    assert.match(
      panelSrc,
      /classList\.add\(`span-\$\{options\.defaultRowSpan\}`\)/,
      'Panel must apply its row span as the `span-${N}` class the shell reserves',
    );

    const registry = parseNaturalFootprintRegistry(layoutSrc);
    assert.ok(registry.size > 0, 'expected DEFERRED_PANEL_NATURAL_FOOTPRINTS entries');

    for (const [panelId, natural] of registry) {
      const shell = createDeferredPanelShell(
        panelId,
        panelId,
        getDeferredPanelShellFootprint({ panelId, naturalFootprints: { [panelId]: natural } }),
      );
      document.body.appendChild(shell);

      if (natural.rowSpan) {
        assert.equal(
          shell.classList.contains(`span-${natural.rowSpan}`),
          true,
          `${panelId}: shell must reserve span-${natural.rowSpan} to match the hydrated panel`,
        );
      }
      if (natural.className === 'panel-wide') {
        assert.equal(
          shell.classList.contains('panel-wide'),
          true,
          `${panelId}: shell must reserve the panel-wide footprint`,
        );
      }
    }
  });

  it('materially reduces initial DOM and control count for below-budget panels', () => {
    const fullDocument = installDom();
    for (let index = 0; index < 12; index++) {
      fullDocument.body.appendChild(createFullPanel(`panel-${index}`));
    }
    const fullElements = elementCount(fullDocument.body);
    const fullControls = countInteractiveControls(fullDocument.body);

    const deferredDocument = installDom();
    const budget = getInitialPanelMountBudget(false);
    for (let index = 0; index < 12; index++) {
      deferredDocument.body.appendChild(
        index < budget
          ? createFullPanel(`panel-${index}`)
          : createDeferredPanelShell(`panel-${index}`, `Panel ${index}`),
      );
    }

    assert.ok(elementCount(deferredDocument.body) < fullElements * 0.8);
    assert.ok(countInteractiveControls(deferredDocument.body) < fullControls * 0.75);
  });

  it('does not toggle a panel twice when settings enable a deferred mount', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

    assert.match(
      source,
      /private\s+mountDeferredPanel\(key:\s*string\):\s*boolean/,
      'mountDeferredPanel must report when it already synchronized panel visibility',
    );
    assert.match(
      source,
      /mountedFromDeferred\s*=\s*this\.mountDeferredPanel\(key\);/,
      'applyPanelSettings must track deferred mounts triggered by settings enablement',
    );
    assert.match(
      source,
      /if\s*\(!mountedFromDeferred\)\s*\{\s*panel\?\.toggle\(config\.enabled\);\s*\}/,
      'applyPanelSettings must skip its own toggle when mountDeferredPanel already toggled',
    );
  });

  it('signals queued panel work after replacing a deferred shell with the real panel', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
    const mountPanelElement = source.match(/private\s+mountPanelElement[\s\S]*?\n {2}\}/);

    assert.ok(mountPanelElement, 'mountPanelElement method not found');
    assert.match(
      mountPanelElement[0],
      /panel\.notifyConnected\(\);/,
      'mountPanelElement must flush runWhenConnected callbacks after inserting the panel element',
    );
  });

  it('reserves a grid slot for immediate-tier lazy panels before their chunk loads (#5332)', async () => {
    const source = await readFile(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
    const method = source.match(/private\s+insertInitialPanelByKey\([\s\S]*?\n {2}\}/);

    assert.ok(method, 'insertInitialPanelByKey method not found');
    assert.doesNotMatch(
      method[0],
      /mountLazyPanel\(/,
      'immediate-tier boot mounts must not use the placeholder-less mountLazyPanel path: the async '
        + 'chunk arrival inserts a brand-new grid item and shoves every panel below it — field mover '
        + 'data (#5332) named these insertions as the dominant desktop CLS mechanism',
    );
    assert.match(
      method[0],
      /this\.deferPanelMount\(key, null, grid, this\.ctx\.panelSettings\[key\]\?\.enabled === true\);\s*if \(this\.shouldMountPanelImmediately\(key\)\) \{\s*this\.mountDeferredPanel\(key\);\s*\}/,
      'insertInitialPanelByKey must reserve the slot first (withShell tied to the enabled flag), with the '
        + 'immediate mount nested inside the shouldMountPanelImmediately budget gate and running after '
        + 'deferPanelMount — hoisting, reordering, or dropping the enabled arg defeats the immediate-tier '
        + 'budget or the shell reservation (#5332)',
    );
  });
});
