import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureNoopenerRel, safeHtml } from '../src/utils/dom-utils.ts';

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
