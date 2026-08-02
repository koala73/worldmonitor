import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

const metaTags = await import('../src/services/meta-tags.ts');

class FakeElement {
  readonly attributes = new Map<string, string>();

  constructor(
    private readonly documentRef: FakeDocument,
    readonly tagName: string,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  remove(): void {
    this.documentRef.removeElement(this);
  }
}

class FakeDocument {
  title = '';
  readonly elements: FakeElement[] = [];
  readonly head = {
    appendChild: (el: FakeElement) => {
      this.elements.push(el);
      return el;
    },
  };

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === 'link[rel="canonical"]') {
      return this.elements.find((el) =>
        el.tagName === 'link' && el.getAttribute('rel') === 'canonical'
      ) ?? null;
    }

    const metaSelectors = [...selector.matchAll(/meta\[(property|name)="([^"]+)"\]/g)];
    for (const [, attr, value] of metaSelectors) {
      const found = this.elements.find((el) =>
        el.tagName === 'meta' && el.getAttribute(attr!) === value
      );
      if (found) return found;
    }

    return null;
  }

  removeElement(el: FakeElement): void {
    const index = this.elements.indexOf(el);
    if (index >= 0) this.elements.splice(index, 1);
  }
}

class FakeStorage {
  private readonly store = new Map<string, string>();

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function installDom(): FakeDocument {
  const fakeDocument = new FakeDocument();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: new FakeStorage(),
  });
  return fakeDocument;
}

after(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

describe('story meta tags', () => {
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    fakeDocument = installDom();
  });

  it('emits OpenGraph tags with property and Twitter tags with name', () => {
    metaTags.updateMetaTagsForStory({
      countryCode: 'UA',
      countryName: 'Ukraine',
      type: 'dailybrief',
    });

    assert.ok(
      fakeDocument.querySelector('meta[property="og:title"]'),
      'OpenGraph title must use property="og:title".',
    );
    assert.equal(
      fakeDocument.querySelector('meta[name="og:title"]'),
      null,
      'OpenGraph tags must not be emitted with name attributes.',
    );
    assert.ok(
      fakeDocument.querySelector('meta[name="twitter:title"]'),
      'Twitter card title must use name="twitter:title".',
    );
    assert.equal(
      fakeDocument.querySelector('meta[property="twitter:title"]'),
      null,
      'Twitter card tags must not be emitted with property attributes.',
    );
  });
});
