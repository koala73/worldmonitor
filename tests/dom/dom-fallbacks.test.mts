/**
 * Sentry WORLDMONITOR-1DP: on an engine without `replaceChildren` (Chrome < 86,
 * Safari < 14) the dashboard never booted. `PanelTabBar.render` calls
 * `this.tablistEl.replaceChildren()` during `App.init`, which threw
 * `replaceChildren is not a function` and showed the boot-failure screen.
 * Each HTML entry installs a fallback before the app graph loads.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fallbackReplaceChildren, installDomFallbacks } from '@/bootstrap/dom-fallbacks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNERS = [Element, Document, DocumentFragment] as const;

/** Remove native `replaceChildren` from every owner (and its own prototype chain), as on Chrome 85. */
function removeNative(): () => void {
  const saved: Array<[object, PropertyDescriptor]> = [];
  for (const owner of OWNERS) {
    for (let proto: object | null = owner.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'replaceChildren');
      if (descriptor) {
        saved.push([proto, descriptor]);
        delete (proto as { replaceChildren?: unknown }).replaceChildren;
      }
    }
  }
  return () => {
    for (const owner of OWNERS) delete (owner.prototype as { replaceChildren?: unknown }).replaceChildren;
    for (const [proto, descriptor] of saved) Object.defineProperty(proto, 'replaceChildren', descriptor);
  };
}

describe('installDomFallbacks on an engine without replaceChildren', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = removeNative();
  });
  afterEach(() => restore());

  it('the PanelTabBar call shape throws without it (the production failure)', () => {
    const tablist = document.createElement('div');
    expect(() => (tablist as unknown as { replaceChildren(): void }).replaceChildren()).toThrow(
      /replaceChildren is not a function/,
    );
  });

  it('clears an element when called with no arguments', () => {
    installDomFallbacks();
    const tablist = document.createElement('div');
    tablist.append(document.createElement('button'), 'text', document.createElement('span'));
    tablist.replaceChildren();
    expect(tablist.childNodes.length).toBe(0);
  });

  it('replaces children with nodes and strings, in order', () => {
    installDomFallbacks();
    const host = document.createElement('ul');
    host.append(document.createElement('li'));
    const a = document.createElement('li');
    a.textContent = 'a';
    host.replaceChildren(a, 'b');
    expect(host.childNodes.length).toBe(2);
    expect(host.firstChild).toBe(a);
    expect(host.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(host.textContent).toBe('ab');
  });

  it('keeps a node that was already a child when it is passed back in', () => {
    installDomFallbacks();
    const host = document.createElement('div');
    const keep = document.createElement('p');
    host.append(document.createElement('hr'), keep);
    host.replaceChildren(keep);
    expect([...host.childNodes]).toEqual([keep]);
  });

  it('moves a fragment\'s children in and works on fragments', () => {
    installDomFallbacks();
    const fragment = document.createDocumentFragment();
    fragment.append(document.createElement('i'));
    const b = document.createElement('b');
    fragment.replaceChildren(b);
    expect([...fragment.childNodes]).toEqual([b]);

    const host = document.createElement('div');
    host.append('old');
    host.replaceChildren(fragment);
    expect([...host.childNodes]).toEqual([b]);
    expect(fragment.childNodes.length).toBe(0);
  });
});

describe('installDomFallbacks on a current engine', () => {
  it('leaves the native replaceChildren untouched', () => {
    const native = Element.prototype.replaceChildren;
    installDomFallbacks();
    expect(Element.prototype.replaceChildren).toBe(native);
    expect(Element.prototype.replaceChildren).not.toBe(fallbackReplaceChildren);
  });
});

/** The module path of each page script referenced by a root HTML entry. */
function entryScripts(): string[] {
  const scripts = new Set<string>();
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.html')) continue;
    const html = readFileSync(resolve(root, file), 'utf-8');
    for (const match of html.matchAll(/<script[^>]*type="module"[^>]*src="\/(src\/[^"]+\.ts)"/g)) {
      scripts.add(match[1]!);
    }
  }
  return [...scripts].sort();
}

/** Script imports in order, skipping comments, stylesheets and the Zod CSP bootstrap. */
function scriptImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
    .map((match) => match[1]!)
    .filter((specifier) => !specifier.endsWith('.css') && specifier !== './bootstrap/zod-csp');
}

describe('every page entry installs the DOM fallbacks before the app graph', () => {
  const scripts = entryScripts();

  it('finds the page entries', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    expect(scripts).toContain('src/main.ts');
  });

  it('imports bootstrap/dom-fallbacks right after the AbortSignal fallbacks', () => {
    const offenders = scripts.filter((script) => {
      const [first, second] = scriptImports(readFileSync(resolve(root, script), 'utf-8'));
      return first !== './bootstrap/abort-signal-fallbacks' || second !== './bootstrap/dom-fallbacks';
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the fallback module free of imports', () => {
    const source = readFileSync(resolve(root, 'src/bootstrap/dom-fallbacks.ts'), 'utf-8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
