import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

const metaTags = await import('../src/services/meta-tags.ts');
const { VARIANT_META } = await import('../src/config/variant-meta.ts');
const { SITE_VARIANT } = await import('../src/config/variant.ts');

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
  delete (globalThis as { window?: unknown }).window;
});

describe('story meta tags', () => {
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    fakeDocument = installDom();
  });

  it('keeps initial dashboard identity for both country aliases and chokepoint state', () => {
    const canonical = VARIANT_META[SITE_VARIANT].url;
    for (const query of ['c=IR', 'country=IR&expanded=1', 'chokepoint=suez']) {
      const link = fakeDocument.querySelector('link[rel="canonical"]') ?? fakeDocument.createElement('link');
      link.setAttribute('rel', 'canonical');
      link.setAttribute('href', canonical);
      if (!fakeDocument.elements.includes(link)) fakeDocument.head.appendChild(link);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: `${canonical}?${query}` } } });
      metaTags.initMetaTags();
      assert.equal(fakeDocument.querySelector('link[rel="canonical"]')?.getAttribute('href'), canonical, query);
      assert.equal(fakeDocument.elements.filter(el => el.getAttribute('rel') === 'canonical').length, 1);
    }
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
