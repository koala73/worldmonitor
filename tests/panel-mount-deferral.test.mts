import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import {
  countInteractiveControls,
  createDeferredPanelShell,
  getDeferredPanelShellFootprint,
  getInitialPanelMountBudget,
  reconcileDeferredShellColSpan,
  shouldDeferInitialPanelMount,
} from '../src/app/panel-mount-deferral';
import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');

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
  return env.document;
}

function restoreDom(): void {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
  else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
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

  it('derives natural panel row reservations before constructing the real panel', () => {
    assert.deepEqual(
      getDeferredPanelShellFootprint({
        panelId: 'energy-complex',
        naturalFootprints: { 'energy-complex': { rowSpan: 2 } },
      }),
      { wide: false, collapsed: false, rowSpan: 2, rowSpanSource: 'natural' },
    );
  });

  it('lets saved row and column spans override natural reservations', () => {
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'live-news',
      naturalFootprints: { 'live-news': { wide: true } },
      savedRowSpans: { 'live-news': 3 },
      savedColSpans: { 'live-news': 1 },
    });

    assert.deepEqual(footprint, {
      wide: true,
      collapsed: false,
      rowSpan: 3,
      rowSpanSource: 'saved',
      colSpan: 1,
      colSpanSource: 'saved',
    });
  });

  it('keeps a saved col-span that equals a non-wide natural col-span', () => {
    // Regression: a saved col-span equal to the panel's explicit (non-wide)
    // natural col-span must still emit the class, because the real panel's
    // default col-span is 1 — without the class the shell would render one
    // column and shift horizontally on mount.
    assert.deepEqual(
      getDeferredPanelShellFootprint({
        panelId: 'wide-data',
        naturalFootprints: { 'wide-data': { colSpan: 2 } },
        savedColSpans: { 'wide-data': 2 },
      }),
      { wide: false, collapsed: false, colSpan: 2, colSpanSource: 'saved' },
    );
  });

  it('suppresses a saved col-span that matches the wide default of 2', () => {
    // A wide panel already spans 2 columns via panel-wide, so a saved col-span of
    // 2 is redundant and should not add an explicit class (mirrors the real panel).
    assert.deepEqual(
      getDeferredPanelShellFootprint({
        panelId: 'live-news',
        naturalFootprints: { 'live-news': { wide: true } },
        savedColSpans: { 'live-news': 2 },
      }),
      { wide: true, collapsed: false },
    );
  });

  it('ignores invalid saved spans instead of emitting invalid shell classes', () => {
    const document = installDom();
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'energy-complex',
      naturalFootprints: { 'energy-complex': { rowSpan: 2 } },
      savedRowSpans: { 'energy-complex': 9 },
      savedColSpans: { 'energy-complex': 0 },
    });
    const shell = createDeferredPanelShell('energy-complex', 'Energy Complex', footprint);
    document.body.appendChild(shell);

    assert.equal(shell.classList.contains('span-2'), true);
    assert.equal(shell.className.includes('span-9'), false);
    assert.equal(shell.className.includes('col-span-0'), false);
  });

  it('applies wide, saved resize, and collapsed footprint classes to shells', () => {
    const document = installDom();
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'live-news',
      naturalFootprints: { 'live-news': { wide: true } },
      savedRowSpans: { 'live-news': 2 },
      savedCollapsed: { 'live-news': true },
    });
    const shell = createDeferredPanelShell('live-news', 'Live News', footprint);
    document.body.appendChild(shell);

    assert.equal(shell.classList.contains('panel-wide'), true);
    assert.equal(shell.classList.contains('span-2'), true);
    assert.equal(shell.classList.contains('resized'), true);
    assert.equal(shell.classList.contains('panel-collapsed'), true);
    // Content visibility is handled by the .panel-collapsed CSS rule, not an inline style.
    assert.notEqual((shell.querySelector('.panel-deferred-content') as HTMLElement | null)?.style.display, 'none');
    assert.equal(countInteractiveControls(shell), 0);
  });

  it('uses explicit dynamic defaults for custom widget and MCP shells while honoring saved spans', () => {
    const dynamicFootprints = {
      'cw-': { rowSpan: 2 },
      'mcp-': { rowSpan: 2 },
    };

    assert.deepEqual(
      getDeferredPanelShellFootprint({ panelId: 'cw-example', dynamicFootprints }),
      { wide: false, collapsed: false, rowSpan: 2, rowSpanSource: 'natural' },
    );
    assert.deepEqual(
      getDeferredPanelShellFootprint({
        panelId: 'mcp-example',
        dynamicFootprints,
        savedRowSpans: { 'mcp-example': 4 },
        savedColSpans: { 'mcp-example': 2 },
      }),
      {
        wide: false,
        collapsed: false,
        rowSpan: 4,
        rowSpanSource: 'saved',
        colSpan: 2,
        colSpanSource: 'saved',
      },
    );
    assert.deepEqual(
      getDeferredPanelShellFootprint({ panelId: 'unknown-panel', dynamicFootprints }),
      { wide: false, collapsed: false },
    );
  });

  it('clamps a saved shell col-span down to the live grid width', () => {
    const document = installDom();
    const footprint = getDeferredPanelShellFootprint({
      panelId: 'live-news',
      savedColSpans: { 'live-news': 3 },
    });
    const shell = createDeferredPanelShell('live-news', 'Live News', footprint);
    document.body.appendChild(shell);
    assert.equal(shell.classList.contains('col-span-3'), true);

    // A 2-column grid must collapse col-span-3 to col-span-2, matching the real panel.
    reconcileDeferredShellColSpan(shell, 2);
    assert.equal(shell.classList.contains('col-span-3'), false);
    assert.equal(shell.classList.contains('col-span-2'), true);
  });

  it('drops the col-span class entirely when the grid only fits one column', () => {
    const document = installDom();
    const shell = createDeferredPanelShell('live-news', 'Live News', {
      colSpan: 2,
      colSpanSource: 'saved',
    });
    document.body.appendChild(shell);

    reconcileDeferredShellColSpan(shell, 1);
    assert.equal(shell.className.includes('col-span-'), false);
  });

  it('leaves a shell col-span untouched when it already fits the grid', () => {
    const document = installDom();
    const shell = createDeferredPanelShell('live-news', 'Live News', {
      colSpan: 2,
      colSpanSource: 'saved',
    });
    document.body.appendChild(shell);

    reconcileDeferredShellColSpan(shell, 3);
    assert.equal(shell.classList.contains('col-span-2'), true);
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
    const mountPanelElement = source.match(/private\s+mountPanelElement[\s\S]*?\n  \}/);

    assert.ok(mountPanelElement, 'mountPanelElement method not found');
    assert.match(
      mountPanelElement[0],
      /panel\.notifyConnected\(\);/,
      'mountPanelElement must flush runWhenConnected callbacks after inserting the panel element',
    );
  });
});
