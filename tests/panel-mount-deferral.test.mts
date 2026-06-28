import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import {
  countInteractiveControls,
  createDeferredPanelShell,
  getDeferredPanelShellFootprint,
  getInitialPanelMountBudget,
  shouldDeferInitialPanelMount,
} from '../src/app/panel-mount-deferral';
class MiniClassList {
  private values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }

  setFromString(value: string): void {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  toString(): string {
    return Array.from(this.values).join(' ');
  }
}

class MiniText {
  parentNode: MiniElement | null = null;
  parentElement: MiniElement | null = null;

  constructor(private value: string) {}

  get textContent(): string {
    return this.value;
  }

  set textContent(value: string | null) {
    this.value = String(value ?? '');
  }
}

class MiniElement {
  readonly childNodes: Array<MiniElement | MiniText> = [];
  readonly classList = new MiniClassList();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  parentNode: MiniElement | null = null;
  parentElement: MiniElement | null = null;
  id = '';

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.setFromString(value);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? '').join('');
  }

  set textContent(value: string | null) {
    this.childNodes.length = 0;
    this.appendChild(new MiniText(String(value ?? '')));
  }

  appendChild<T extends MiniElement | MiniText>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MiniElement | MiniText>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'class') this.className = stringValue;
    else if (name === 'id') this.id = stringValue;
    else if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, part: string) => part.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    const matches: MiniElement[] = [];
    const visit = (node: MiniElement) => {
      for (const child of node.childNodes) {
        if (!(child instanceof MiniElement)) continue;
        if (selectors.some((part) => matchesSelector(child, part))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class MiniDocument {
  readonly body = new MiniElement('body');

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName.toLowerCase());
  }
}

function matchesSelector(element: MiniElement, selector: string): boolean {
  if (selector === '*') return true;
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector === 'a[href]') return element.tagName === 'a' && element.attributes.has('href');
  if (selector === '[tabindex]:not([tabindex="-1"])') return element.attributes.has('tabindex') && element.getAttribute('tabindex') !== '-1';
  const role = selector.match(/^\[role="([^\"]+)"\]$/);
  if (role) return element.getAttribute('role') === role[1];
  return element.tagName === selector.toLowerCase();
}

function createBrowserEnvironment() {
  return {
    document: new MiniDocument(),
    HTMLElement: MiniElement,
  };
}

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
