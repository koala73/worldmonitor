import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureNoopenerRel, getFocusableElements, h, replaceChildren, safeHtml } from '../src/utils/dom-utils.ts';
import { createBrowserEnvironment, MiniNode } from './helpers/mini-dom.mts';

class TestElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: TestElement[] = [];
  readonly attrs = new Map<string, string>();

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) {
      this.attrs.set(name.toLowerCase(), value);
    }
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Array.from(this.attrs, ([name, value]) => ({ name, value }));
  }

  get firstChild(): TestElement | null {
    return this.childNodes[0] ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }

  insertBefore(node: TestElement, ref: TestElement): void {
    const index = this.childNodes.indexOf(ref);
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
  }

  removeChild(node: TestElement): void {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
  }
}

class TestDocumentFragment {
  readonly childNodes: TestElement[] = [];

  insertBefore(node: TestElement, ref: TestElement): void {
    const index = this.childNodes.indexOf(ref);
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
  }

  removeChild(node: TestElement): void {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
  }
}

class TestTemplateElement {
  readonly content = new TestDocumentFragment();

  set innerHTML(html: string) {
    const tag = html.match(/^<a\s+([^>]*)>/i);
    if (!tag) return;

    const attrs: Record<string, string> = {};
    for (const match of tag[1]!.matchAll(/([^\s=]+)="([^"]*)"/g)) {
      attrs[match[1]!.toLowerCase()] = match[2]!;
    }
    this.content.childNodes.push(new TestElement('a', attrs));
  }
}

function withMinimalDom(fn: () => void): void {
  const globals = globalThis as unknown as {
    document?: { createElement(tagName: string): TestTemplateElement };
    Node?: { ELEMENT_NODE: number };
  };
  const originalDocument = globals.document;
  const originalNode = globals.Node;

  globals.Node = { ELEMENT_NODE: 1 };
  globals.document = {
    createElement(tagName: string) {
      assert.equal(tagName, 'template');
      return new TestTemplateElement();
    },
  };

  try {
    fn();
  } finally {
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;
    if (originalNode === undefined) delete globals.Node;
    else globals.Node = originalNode;
  }
}

function withBrowserDom(fn: () => void): void {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  const browser = createBrowserEnvironment();

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: browser.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: MiniNode,
  });

  try {
    fn();
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    if (originalNode) Object.defineProperty(globalThis, 'Node', originalNode);
    else delete (globalThis as { Node?: unknown }).Node;
  }
}

describe('dom-utils construction helpers', () => {
  it('withBrowserDom exposes standard node-type contracts', () => {
    withBrowserDom(() => {
      const element = document.createElement('div');
      const text = document.createTextNode('content');
      const fragment = document.createDocumentFragment();

      assert.equal(Node.ELEMENT_NODE, 1);
      assert.equal(Node.TEXT_NODE, 3);
      assert.equal(Node.DOCUMENT_FRAGMENT_NODE, 11);
      assert.equal(element.nodeType, Node.ELEMENT_NODE);
      assert.equal(text.nodeType, Node.TEXT_NODE);
      assert.equal(fragment.nodeType, Node.DOCUMENT_FRAGMENT_NODE);
    });
  });

  it('h applies attributes, datasets, and both supported style forms', () => {
    withBrowserDom(() => {
      const element = h('button', {
        className: 'primary',
        id: 'launch',
        dataset: { role: 'action', active: 'true' },
        style: { color: 'blue', display: 'none' },
        'aria-label': 'Launch',
        disabled: true,
        ignored: null,
      });
      const stringStyled = h('span', { style: 'color: red;' });

      assert.equal(element.className, 'primary');
      assert.equal(element.id, 'launch');
      assert.deepEqual(
        { role: element.dataset.role, active: element.dataset.active },
        { role: 'action', active: 'true' },
      );
      assert.deepEqual(
        { color: element.style.color, display: element.style.display },
        { color: 'blue', display: 'none' },
      );
      assert.equal(stringStyled.style.cssText, 'color: red;');
      assert.equal(element.getAttribute('aria-label'), 'Launch');
      assert.equal(element.hasAttribute('disabled'), true);
      assert.equal(element.hasAttribute('ignored'), false);
    });
  });

  it('h registers event handlers from on-prefixed props', () => {
    withBrowserDom(() => {
      let clicks = 0;
      const button = h('button', { onClick: () => { clicks += 1; } });

      button.dispatchEvent(new Event('click'));

      assert.equal(clicks, 1);
    });
  });

  it('h preserves node children, stringifies numbers, and skips empty children', () => {
    withBrowserDom(() => {
      const child = document.createElement('span');
      const element = h(
        'div',
        'first',
        child,
        42,
        null,
        undefined,
        false,
        'last',
      );

      assert.equal(element.childNodes.length, 4);
      assert.equal(element.childNodes[0]!.textContent, 'first');
      assert.equal(element.childNodes[1], child);
      assert.equal(element.childNodes[2]!.textContent, '42');
      assert.equal(element.childNodes[3]!.textContent, 'last');
    });
  });

  it('replaceChildren removes prior content before appending replacements', () => {
    withBrowserDom(() => {
      const element = h('div', null, 'old', h('span'));
      const replacement = h('strong');

      replaceChildren(element, replacement, 'new', 7);

      assert.equal(element.childNodes.length, 3);
      assert.equal(element.childNodes[0], replacement);
      assert.equal(element.childNodes[1]!.textContent, 'new');
      assert.equal(element.childNodes[2]!.textContent, '7');
    });
  });
});

describe('dom-utils safe link helpers', () => {
  it('adds noopener and noreferrer for blank-target links (#3550)', () => {
    assert.equal(ensureNoopenerRel(null), 'noopener noreferrer');
  });

  it('preserves safe rel tokens while removing opener (#3550)', () => {
    assert.equal(ensureNoopenerRel('nofollow OPENER'), 'nofollow noopener noreferrer');
  });

  it('safeHtml enforces noopener on blank-target anchors (#3550)', () => {
    withMinimalDom(() => {
      const fragment = safeHtml(
        '<a href="https://example.com" target="_blank" rel="nofollow opener ugc noopener" onclick="alert(1)">Source</a>',
      ) as unknown as TestDocumentFragment;
      const anchor = fragment.childNodes[0]!;

      assert.equal(anchor.getAttribute('rel'), 'nofollow ugc noopener noreferrer');
      assert.equal(anchor.getAttribute('onclick'), null);
    });
  });
});

describe('dom-utils getFocusableElements', () => {
  it('includes enabled buttons, href anchors, and tabindex="0" while excluding disabled, aria-hidden, and tabindex="-1" matches', () => {
    withBrowserDom(() => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const enabledButton = document.createElement('button');
      const disabledButton = document.createElement('button');
      disabledButton.setAttribute('disabled', 'disabled');
      const link = document.createElement('a');
      link.setAttribute('href', '#');
      const hiddenButton = document.createElement('button');
      hiddenButton.setAttribute('aria-hidden', 'true');
      const tabbableDiv = document.createElement('div');
      tabbableDiv.setAttribute('tabindex', '0');
      const untabbableDiv = document.createElement('div');
      untabbableDiv.setAttribute('tabindex', '-1');

      container.append(enabledButton, disabledButton, link, hiddenButton, tabbableDiv, untabbableDiv);

      const result = getFocusableElements(container as unknown as ParentNode);

      assert.equal(result.length, 3);
      assert.equal(result[0], enabledButton);
      assert.equal(result[1], link);
      assert.equal(result[2], tabbableDiv);
    });
  });

  it('excludes elements with no offsetParent (disconnected from the document)', () => {
    withBrowserDom(() => {
      // Not appended to document.body, so isConnected (and thus offsetParent) is false —
      // mirrors an undisplayed/detached element that would otherwise match the selector.
      const floatingContainer = document.createElement('div');
      const button = document.createElement('button');
      floatingContainer.appendChild(button);

      const result = getFocusableElements(floatingContainer as unknown as ParentNode);

      assert.equal(result.length, 0);
    });
  });
});
